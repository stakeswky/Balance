# Claude / Codex / Grok 配额样本窗口身份稳定性修复计划

日期：2026-08-20  
状态：已执行  
范围：三家官方配额窗口的样本分组键、旧样本兼容与运行时回放；不改变计费事件的真实时间范围

## 1. 目标与验收

1. Claude 同一周窗口在官方接口返回亚秒抖动时仍使用同一个 `windowId`，已有样本不会突然变成“样本不足”。
2. Codex 同一周 reset 相差 1 秒时仍使用同一个 `windowId`。
3. Grok 的整秒日志与微秒接口边界映射到同一个 `windowId`。
4. 真正跨越 5 小时或 7 日 reset 的窗口仍生成不同 `windowId`。
5. `windowBounds` 保留官方原始毫秒边界，事件过滤和 L1 金额不因身份归一化而移动。
6. 已持久化的旧精确时间戳 `windowId` 在读取和下次合并时自动归一，不要求用户重新积累样本。

## 2. Explore 核对结果

- 真实签名：`officialWindowId(agent, kind, product, startsAt, resetsAt): string`。
- 真实样本入口：`samplesFromOfficial` 先调用 `windowBounds`，再调用 `officialWindowId` 和 `mergeSamples`。
- 真实估值入口：`quotaValueFor` 使用当前 `windowId` 精确筛选 `QuotaSample[]`，然后调用 `calibrateFromSamples`。
- Claude Desktop 同一周边界出现 `20:59:59.901` 与 `21:00:00.416` 两种值，相差约 515ms，且跨过整分钟边界。
- Codex 近期 session 日志中同一 weekly reset 出现 `1787815628` 与 `1787815629` 两个秒值。
- Grok 当前真实日志边界稳定，但 live fixture 使用微秒、log fixture 使用整秒，现有精确字符串键存在同类风险。
- 归一化必须使用最近一分钟 `Math.round`；`Math.floor` 会把 Claude 已观测到的两个值分到相邻分钟。
- 旧 `windowId` 不能用贪婪正则直接拆 `product`，因为产品名理论上允许包含 `:`；实现应从左侧取 `agent/kind`、从右侧取 `startsAt/resetsAt`，中间整体视为 `product`。
- 归一化只用于窗口身份，不修改 `windowBounds` 返回值。

## 3. TDD Step 1：稳定三家窗口身份并迁移旧样本

### 3.1 先写失败测试

在 `src/lib/quota/quota-value.test.ts` 添加完整测试：

```ts
test("provider reset jitter keeps one quota window identity", () => {
  const claudeA = officialWindowId(
    "claude",
    "weekly",
    null,
    Date.parse("2026-08-17T20:59:59.901Z"),
    Date.parse("2026-08-24T20:59:59.901Z"),
  );
  const claudeB = officialWindowId(
    "claude",
    "weekly",
    null,
    Date.parse("2026-08-17T21:00:00.416Z"),
    Date.parse("2026-08-24T21:00:00.416Z"),
  );
  assert.equal(claudeA, claudeB);

  const codexResetA = 1_787_815_628_000;
  const codexResetB = 1_787_815_629_000;
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.equal(
    officialWindowId("codex", "weekly", null, codexResetA - week, codexResetA),
    officialWindowId("codex", "weekly", null, codexResetB - week, codexResetB),
  );

  assert.equal(
    officialWindowId(
      "grok",
      "weekly",
      null,
      Date.parse("2026-08-18T13:28:17.000Z"),
      Date.parse("2026-08-25T13:28:17.000Z"),
    ),
    officialWindowId(
      "grok",
      "weekly",
      null,
      Date.parse("2026-08-18T13:28:17.911Z"),
      Date.parse("2026-08-25T13:28:17.911Z"),
    ),
  );
});

test("real quota resets still create a new window identity", () => {
  const start = Date.parse("2026-08-20T00:00:00Z");
  const span = 5 * 60 * 60 * 1000;
  assert.notEqual(
    officialWindowId("claude", "five_hour", null, start, start + span),
    officialWindowId("claude", "five_hour", null, start + span, start + 2 * span),
  );
});

test("legacy jittered sample ids coalesce without losing observations", () => {
  const firstId = "claude:weekly:_:1787000399901:1787605199901";
  const secondId = "claude:weekly:_:1787000400416:1787605200416";
  const rows = normalizeWindowSamples([
    sample({
      agent: "claude",
      windowId: firstId,
      timestampMs: 1,
      usedPercent: 10,
      cumulativeObservedUsd: 1,
      modelMix: { opus: 1 },
    }),
    sample({
      agent: "claude",
      windowId: secondId,
      timestampMs: 2,
      usedPercent: 12,
      cumulativeObservedUsd: 2,
      modelMix: { opus: 1 },
    }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.windowId)).size, 1);
  assert.equal(rows[0]?.windowId, officialWindowId("claude", "weekly", null, 1787000400416, 1787605200416));

  const codexRows = normalizeWindowSamples([
    sample({
      agent: "codex",
      windowId: "codex:weekly:_:1787210828000:1787815628000",
      timestampMs: 1,
      usedPercent: 5,
      cumulativeObservedUsd: 1,
    }),
    sample({
      agent: "codex",
      windowId: "codex:weekly:_:1787210829000:1787815629000",
      timestampMs: 2,
      usedPercent: 7,
      cumulativeObservedUsd: 2,
    }),
  ]);
  assert.equal(new Set(codexRows.map((row) => row.windowId)).size, 1);

  const grokStartA = Date.parse("2026-08-18T13:28:17.000Z");
  const grokStartB = Date.parse("2026-08-18T13:28:17.911Z");
  const grokEndA = Date.parse("2026-08-25T13:28:17.000Z");
  const grokEndB = Date.parse("2026-08-25T13:28:17.911Z");
  const grokRows = normalizeWindowSamples([
    sample({
      agent: "grok",
      windowId: `grok:weekly:_:${grokStartA}:${grokEndA}`,
      timestampMs: 1,
      usedPercent: 8,
      cumulativeObservedUsd: 1,
      modelMix: { "grok-4.6": 1 },
    }),
    sample({
      agent: "grok",
      windowId: `grok:weekly:_:${grokStartB}:${grokEndB}`,
      timestampMs: 2,
      usedPercent: 10,
      cumulativeObservedUsd: 2,
      modelMix: { "grok-4.6": 1 },
    }),
  ]);
  assert.equal(new Set(grokRows.map((row) => row.windowId)).size, 1);
});

test("quotaValueFor reuses legacy jittered samples immediately", () => {
  const value = quotaValueFor(
    [],
    "claude",
    slice({
      agent: "claude",
      weekPct: 24,
      weekStartedAt: 1_787_000_400_416,
      weekResetsAt: 1_787_605_200_416,
    }),
    "weekly",
    1_787_300_000_000,
    [
      sample({
        agent: "claude",
        windowId: "claude:weekly:_:1787000399901:1787605199901",
        timestampMs: 1,
        usedPercent: 10,
        cumulativeObservedUsd: 1,
        modelMix: { opus: 1 },
      }),
      sample({
        agent: "claude",
        windowId: "claude:weekly:_:1787000399901:1787605199901",
        timestampMs: 2,
        usedPercent: 12,
        cumulativeObservedUsd: 2,
        modelMix: { opus: 1 },
      }),
    ],
  );
  assert.equal(value.confidence, "low");
  assert.equal(value.totalPointUsd, 50);
});

test("window identity normalization does not move event boundaries", () => {
  const start = Date.parse("2026-08-17T21:00:00.416Z");
  const reset = Date.parse("2026-08-24T21:00:00.416Z");
  const bounds = windowBounds(
    slice({ agent: "claude", weekStartedAt: start, weekResetsAt: reset }),
    "weekly",
    Date.parse("2026-08-20T00:00:00Z"),
  );
  assert.equal(bounds.start, start);
  assert.equal(bounds.resetsAt, reset);
});
```

失败命令：

```bash
node --test --experimental-strip-types src/lib/quota/quota-value.test.ts
```

预期红灯：三家抖动身份断言失败；旧样本产生两个 ID；`quotaValueFor` 返回 `confidence: "none"`。

### 3.2 实现

在 `src/lib/quota/quota-value.ts` 增加完整身份归一化实现：

```ts
const WINDOW_ID_GRANULARITY_MS = 60_000;
const MIN_REAL_WINDOW_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

function canonicalWindowAnchor(value: number | null): string {
  if (value == null) return "na";
  if (!Number.isFinite(value) || value < MIN_REAL_WINDOW_TIMESTAMP_MS) return String(value);
  return String(Math.round(value / WINDOW_ID_GRANULARITY_MS) * WINDOW_ID_GRANULARITY_MS);
}

function canonicalWindowAnchorToken(value: string): string | null {
  if (value === "na") return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return canonicalWindowAnchor(parsed);
}

export function normalizeOfficialWindowId(windowId: string): string {
  const parts = windowId.split(":");
  if (parts.length < 5) return windowId;
  const agent = parts[0];
  const kind = parts[1];
  if ((agent !== "claude" && agent !== "codex" && agent !== "grok")
    || (kind !== "five_hour" && kind !== "weekly" && kind !== "product")) {
    return windowId;
  }
  const startsAt = canonicalWindowAnchorToken(parts[parts.length - 2]!);
  const resetsAt = canonicalWindowAnchorToken(parts[parts.length - 1]!);
  if (startsAt == null || resetsAt == null) return windowId;
  const product = parts.slice(2, -2).join(":");
  return `${agent}:${kind}:${product}:${startsAt}:${resetsAt}`;
}

function normalizeSampleWindowId(sample: QuotaSample): QuotaSample {
  const windowId = normalizeOfficialWindowId(sample.windowId);
  if (windowId === sample.windowId) return sample;
  return Object.assign({}, sample, { windowId });
}

export function officialWindowId(
  agent: AgentId,
  kind: "five_hour" | "weekly" | "product",
  product: string | null,
  startsAt: number | null,
  resetsAt: number | null,
): string {
  return `${agent}:${kind}:${product ?? "_"}:${canonicalWindowAnchor(startsAt)}:${canonicalWindowAnchor(resetsAt)}`;
}
```

用以下完整函数替换 `normalizeWindowSamples`：

```ts
export function normalizeWindowSamples(samples: QuotaSample[]): QuotaSample[] {
  const groups = new Map<string, QuotaSample[]>();
  for (const original of samples) {
    const row = normalizeSampleWindowId(original);
    const key = `${row.windowId}\u0000${row.pricingVersion}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const normalized: QuotaSample[] = [];
  for (const group of groups.values()) {
    const ordered = Array.from(group).sort((a, b) => a.timestampMs - b.timestampMs);
    const out: QuotaSample[] = [];
    let maxPct = -Infinity;
    for (const row of ordered) {
      if (row.usedPercent < maxPct) continue;
      if (row.usedPercent === maxPct) {
        out[out.length - 1] = row;
        continue;
      }
      out.push(row);
      maxPct = row.usedPercent;
    }
    for (const row of out) normalized.push(row);
  }
  return normalized.sort((a, b) => a.timestampMs - b.timestampMs);
}
```

用以下完整函数替换 `mergeSamples`：

```ts
export function mergeSamples(existing: QuotaSample[], incoming: QuotaSample): QuotaSample[] {
  const canonicalExisting = existing.map(normalizeSampleWindowId);
  const canonicalIncoming = normalizeSampleWindowId(incoming);
  const same = canonicalExisting.filter((sample) => sample.windowId === canonicalIncoming.windowId);
  const others = canonicalExisting.filter((sample) => sample.windowId !== canonicalIncoming.windowId);
  const nextSame = normalizeWindowSamples(same.concat(canonicalIncoming)).slice(-128);
  const combined = others.concat(nextSame);
  const latestByWindow = new Map<string, { group: string; at: number }>();
  for (const sample of combined) {
    if (sample.agent !== canonicalIncoming.agent) continue;
    const current = latestByWindow.get(sample.windowId);
    if (!current || sample.timestampMs > current.at) {
      latestByWindow.set(sample.windowId, {
        group: retentionGroup(sample),
        at: sample.timestampMs,
      });
    }
  }
  const grouped = new Map<string, Array<{ windowId: string; at: number }>>();
  for (const [windowId, meta] of latestByWindow) {
    const rows = grouped.get(meta.group) ?? [];
    rows.push({ windowId, at: meta.at });
    grouped.set(meta.group, rows);
  }
  const keep = new Set<string>();
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.at - right.at);
    for (const row of rows.slice(-8)) keep.add(row.windowId);
  }
  return combined.filter((sample) => sample.agent !== canonicalIncoming.agent || keep.has(sample.windowId));
}
```

在 `quotaValueFor` 中把样本筛选改为：

```ts
const compatibleSamples = (samples ?? []).filter(
  (sample) => normalizeOfficialWindowId(sample.windowId) === windowId,
);
const cal = official ? calibrateFromSamples(compatibleSamples, usedPct, bounds.rolling) : emptyCal;
```

### 3.3 绿灯与回归

依次执行：

```bash
node --test --experimental-strip-types src/lib/quota/quota-value.test.ts
npm test
npm run typecheck
npm run build
```

验收标准：

- 新增五个测试全部通过。
- 全量测试、类型检查、生产构建均退出 0。
- 用本机 Claude、Codex、Grok 最新官方边界回放时，同逻辑窗口各只有一个规范化 ID。
- Claude 旧的 `.901` / `.416` 两组样本能合并并产出非 `none` 置信度。
- 页面仍显示 Claude Fable 周额度；运行中的样本不会仅因 reset 亚秒或 1 秒抖动变成不足。

建议 commit：`fix(quota): stabilize official sample windows`

## 4. 计划自检

- Spec coverage：六项验收全部由 Step 1 的测试、实现或运行时回放覆盖。
- Placeholder scan：计划中的实现和测试均为可直接执行的完整代码，无省略片段。
- Type consistency：函数参数、返回类型和 `OfficialSlice` / `QuotaSample` 字段均已按当前源码核对；`quotaValueFor(events, agent, official, kind, now, samples)` 的 `kind` 参数已补回。
- Step size：单一 TDD 单元，只修改窗口身份及直接消费者，可一次实现并独立验证。
