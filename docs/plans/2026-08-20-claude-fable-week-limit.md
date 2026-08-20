# Claude Max Fable 5 周限额补充计划

日期：2026-08-20
状态：已完成
范围：Claude Max 的 Fable 5 模型周子额度计算、监控卡展示与阈值提醒

## 1. 已核对事实与真实 API

- `ClaudeModelId` 已包含 `"fable"`，Claude JSONL 解析、价格、模型名展示也已支持 Fable 5；本次不重复改模型解析或定价。
- Claude Desktop `plan-usage-history.json` 当前只记录 `samples[].u.fh` 和 `samples[].u.sd`。Claude Desktop 1.32885.1 的写入映射也没有 Fable 键，因此不能伪造“官方 Fable 已用百分比”。
- 本机 Claude Max 公告明确给出：Fable 5 最多使用周订阅额度的 50%，且会比 Opus 5 更快消耗总额度。
- 现有真实签名：

```ts
export interface PlanDef {
  id: string;
  agent: AgentId;
  name: string;
  priceUsd: number;
  blurb: string;
  windowTokenBudget: number;
  weekTokenBudget: number;
  windowReasoningMin: number;
  weekReasoningMin: number;
  kind: "subscription" | "api";
}

export function weightedTokens(event: UsageEvent): number;

export function inWindow(
  events: UsageEvent[],
  now: number,
  span: number,
  agent?: AgentId,
): UsageEvent[];

export function AgentCard(props: {
  name: string;
  adapter: string;
  plan: PlanDef;
  meter: MeterSnapshot;
  session: SessionState | null;
  live: boolean;
  liveNote?: string;
  windowLabel?: string;
  quotaNote?: string;
  products?: OfficialProductShare[];
  weekValue?: QuotaValue;
  windowValue?: QuotaValue;
  events: UsageEvent[];
  now: number;
  onToggle: () => void;
}): JSX.Element;
```

## 2. TDD Step 1：计算、展示并提醒 Fable 5 周子额度

### 2.1 先写失败测试

新增 `src/lib/quota/model-week-limit.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelWeekLimitFor } from "./engine.ts";
import type { OfficialSlice } from "./official.ts";
import { planById } from "./plans.ts";
import type { UsageEvent } from "./types.ts";
import { WEEK_MS } from "./types.ts";

const now = Date.parse("2026-08-20T12:00:00Z");

const official: OfficialSlice = {
  agent: "claude",
  windowPct: 10,
  weekPct: 20,
  windowResetsAt: now + 60_000,
  weekResetsAt: now + 5 * 24 * 60 * 60 * 1_000,
  weekStartedAt: now - 2 * 24 * 60 * 60 * 1_000,
  windowDurationMs: 5 * 60 * 60 * 1_000,
  weekDurationMs: 7 * 24 * 60 * 60 * 1_000,
  burnPctPerHour: 0,
  planLabel: "max",
  products: [],
  prepaidBalance: null,
  onDemandUsed: null,
  onDemandCap: null,
  source: "test",
  fetchedAt: now,
  windowKind: "five_hour",
};

function event(
  id: string,
  model: UsageEvent["model"],
  tokensIn: number,
  ts = now - 1_000,
): UsageEvent {
  return {
    id,
    agent: "claude",
    model,
    ts,
    sessionId: "session",
    task: "quota test",
    tokensIn,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
  };
}

test("Claude Max plans expose a 50% Fable weekly sub-limit", () => {
  assert.equal(planById("claude-max-5x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-max-20x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-pro").modelWeekLimitPct?.fable, undefined);
  assert.equal(planById("claude-api").modelWeekLimitPct?.fable, undefined);
});

test("Fable weekly sub-limit counts only in-window Fable weighted tokens", () => {
  const plan = {
    ...planById("claude-max-5x"),
    weekTokenBudget: 1_000,
  };
  const result = modelWeekLimitFor(
    [
      event("fable-current", "fable", 50),
      event("opus-current", "opus", 10_000),
      event("fable-old", "fable", 10_000, now - WEEK_MS - 1),
      event("fable-before-reset", "fable", 10_000, now - 3 * 24 * 60 * 60 * 1_000),
    ],
    plan,
    official,
    "fable",
    now,
    0,
  );

  assert.deepEqual(result, {
    model: "fable",
    limitPctOfWeek: 50,
    weightedTokens: 400,
    budget: 500,
    usedPct: 80,
  });
});

test("weekly boost expands the Fable sub-limit with the total weekly pool", () => {
  const plan = {
    ...planById("claude-max-20x"),
    weekTokenBudget: 1_000,
  };
  const result = modelWeekLimitFor(
    [event("fable-current", "fable", 50)],
    plan,
    null,
    "fable",
    now,
    100,
  );

  assert.equal(result?.budget, 1_000);
  assert.equal(result?.usedPct, 40);
});

test("plans without a Fable sub-limit return null", () => {
  assert.equal(
    modelWeekLimitFor(
      [event("fable-current", "fable", 50)],
      planById("claude-pro"),
      null,
      "fable",
      now,
      0,
    ),
    null,
  );
});
```

在 `src/lib/quota/presentation.test.ts` 的 import 中加入 `effectiveQuotaStatus`、`quotaAlertLatch`、`tightestQuota`，并新增：

```ts
test("Fable sub-limit can raise the Claude card status", () => {
  assert.equal(effectiveQuotaStatus("ok", 90), "critical");
  assert.equal(effectiveQuotaStatus("ok", 75), "watch");
  assert.equal(effectiveQuotaStatus("critical", 10), "critical");
});

test("tightest quota includes a stricter Fable sub-limit", () => {
  const result = tightestQuota([
    { label: "Claude", pct: 30, resetsAt: 10 },
    { label: "Claude Fable 5", pct: 80, resetsAt: 20 },
  ]);
  assert.deepEqual(result, { label: "Claude Fable 5", pct: 80, resetsAt: 20 });
});

test("Fable alert latch triggers once and unlocks after a 12 point drop", () => {
  assert.deepEqual(quotaAlertLatch(90, 85, false), {
    triggered: true,
    nextWarned: true,
  });
  assert.deepEqual(quotaAlertLatch(90, 85, true), {
    triggered: false,
    nextWarned: true,
  });
  assert.deepEqual(quotaAlertLatch(72, 85, true), {
    triggered: false,
    nextWarned: false,
  });
  assert.deepEqual(quotaAlertLatch(null, 85, true), {
    triggered: false,
    nextWarned: false,
  });
});
```

在 `src/lib/quota/store.test.ts` 新增：

```ts
test("same-tick Claude total and Fable alerts receive distinct ids", () => {
  useQuota.setState({ alerts: [] });
  useQuota.getState().pushAlert({
    ts: 1_000,
    agent: "claude",
    kind: "week",
    message: "Claude Code 本周额度已用 90%",
  });
  useQuota.getState().pushAlert({
    ts: 1_000,
    agent: "claude",
    kind: "week",
    message: "Claude Code Fable 5 周额度已用 90%",
  });

  assert.equal(useQuota.getState().alerts.length, 2);
  assert.equal(new Set(useQuota.getState().alerts.map((alert) => alert.id)).size, 2);
});
```

先运行并确认因为 `modelWeekLimitFor`、`modelWeekLimitPct` 尚不存在而失败：

```bash
node --test --experimental-strip-types \
  src/lib/quota/model-week-limit.test.ts \
  src/lib/quota/presentation.test.ts \
  src/lib/quota/store.test.ts
```

### 2.2 实现领域模型与纯计算

在 `src/lib/quota/types.ts` 中把 `PlanDef` 完整改为：

```ts
export interface PlanDef {
  id: string;
  agent: AgentId;
  name: string;
  priceUsd: number;
  blurb: string;
  windowTokenBudget: number;
  weekTokenBudget: number;
  windowReasoningMin: number;
  weekReasoningMin: number;
  modelWeekLimitPct?: Partial<Record<ModelId, number>>;
  kind: "subscription" | "api";
}

export interface ModelWeekLimitSnapshot {
  model: ModelId;
  limitPctOfWeek: number;
  weightedTokens: number;
  budget: number;
  usedPct: number;
}
```

在 `src/lib/quota/plans.ts` 的两个 Claude Max 套餐中分别加入：

```ts
modelWeekLimitPct: { fable: 50 },
```

Claude Pro 和 Anthropic API 不加入该字段。

在 `src/lib/quota/engine.ts` 的类型 import 中加入 `ModelWeekLimitSnapshot`，从 `quota-value.ts` 导入 `eventsInWindow`、`windowBounds`，并在 `eventWeekShare` 后加入完整纯函数：

```ts
export function modelWeekLimitFor(
  events: UsageEvent[],
  plan: PlanDef,
  official: OfficialSlice | null | undefined,
  model: ModelId,
  now: number,
  boostPct: number,
): ModelWeekLimitSnapshot | null {
  const limitPctOfWeek = plan.modelWeekLimitPct?.[model];
  if (limitPctOfWeek == null || limitPctOfWeek <= 0) return null;

  const boost = 1 + Math.max(0, boostPct) / 100;
  const budget = plan.weekTokenBudget * boost * (limitPctOfWeek / 100);
  const bounds = windowBounds(official, "weekly", now);
  const weighted = eventsInWindow(events, plan.agent, bounds.start, bounds.end)
    .filter((event) => event.model === model)
    .reduce((sum, event) => sum + weightedTokens(event), 0);

  return {
    model,
    limitPctOfWeek,
    weightedTokens: weighted,
    budget,
    usedPct: clampPct(budget > 0 ? (weighted / budget) * 100 : 0),
  };
}
```

在 `src/lib/quota/presentation.ts` 加入：

```ts
export function effectiveQuotaStatus(
  meterStatus: MeterSnapshot["status"],
  extraUsedPct: number | null | undefined,
): MeterSnapshot["status"] {
  const extraStatus =
    extraUsedPct == null || extraUsedPct < 72 ? "ok" : extraUsedPct >= 88 ? "critical" : "watch";
  if (meterStatus === "critical" || extraStatus === "critical") return "critical";
  if (meterStatus === "watch" || extraStatus === "watch") return "watch";
  return "ok";
}

export function tightestQuota<T extends { pct: number }>(limits: readonly T[]): T | null {
  return [...limits].sort((a, b) => b.pct - a.pct)[0] ?? null;
}

export function quotaAlertLatch(
  usedPct: number | null,
  threshold: number,
  warned: boolean,
): { triggered: boolean; nextWarned: boolean } {
  if (usedPct == null || usedPct < threshold - 12) {
    return { triggered: false, nextWarned: false };
  }
  if (usedPct >= threshold) {
    return { triggered: !warned, nextWarned: true };
  }
  return { triggered: false, nextWarned: warned };
}
```

在 `src/lib/quota/store.ts` 的 `pushAlert` 中把 id 改为包含 kind 与 message，保证同 tick 的总周告警和 Fable 告警不冲突：

```ts
pushAlert: (alert) =>
  set({
    alerts: [
      {
        ...alert,
        id: `al_${alert.ts}_${alert.agent}_${alert.kind}_${alert.message}`,
      },
      ...get().alerts,
    ].slice(0, MAX_ALERTS),
  }),
```

运行测试并确认新增的 8 个用例通过：

```bash
node --test --experimental-strip-types \
  src/lib/quota/model-week-limit.test.ts \
  src/lib/quota/presentation.test.ts \
  src/lib/quota/store.test.ts
```

### 2.3 接入 Claude 卡片与周阈值提醒

在 `src/components/synq/agent-card.tsx`：

1. 从 `@/lib/quota/types` 加入 `ModelWeekLimitSnapshot` 类型。
2. 从 `@/lib/quota/presentation` 加入 `effectiveQuotaStatus`。
3. 给 `AgentCard` 参数和 props 类型加入：

```ts
modelWeekLimit?: ModelWeekLimitSnapshot | null;
```

4. 在现有 5 小时/本周 `MeterBar` 容器内、两个总额度条之后加入：

```tsx
{
  modelWeekLimit ? (
    <>
      <MeterBar
        value={modelWeekLimit.usedPct}
        tone={modelWeekLimit.usedPct >= 88 ? "crit" : modelWeekLimit.usedPct >= 72 ? "warn" : tone}
        label="Fable 5 周额度（本机估算）"
      />
      <p className="text-xs leading-relaxed text-faint">
        Claude Max 的 Fable 5 上限为总周额度的 {modelWeekLimit.limitPctOfWeek}
        %；未包含其他设备用量。
      </p>
    </>
  ) : null;
}
```

在 `src/components/synq/dashboard.tsx`：

1. 从 engine import 加入 `modelWeekLimitFor`。
2. 从 presentation import 加入 `quotaAlertLatch`，给 `warned.current` 加入 `claudeFable: false`。
3. `checkAlerts` 内在 `claudeMeter` 后计算：

```ts
const claudeFableLimit = modelWeekLimitFor(
  activeEvents,
  planById(state.claudePlanId),
  state.official.claude,
  "fable",
  t,
  state.weekBoostPct,
);
```

4. Claude 总额度的 `check` 调用之后加入：

```ts
const fableAlert = quotaAlertLatch(
  claudeFableLimit?.usedPct ?? null,
  state.alertWeekPct,
  warned.current.claudeFable,
);
warned.current.claudeFable = fableAlert.nextWarned;
if (claudeFableLimit && fableAlert.triggered) {
  const message = `Claude Code Fable 5 周额度已用 ${claudeFableLimit.usedPct.toFixed(0)}%`;
  toast.error(message);
  state.pushAlert({ ts: t, agent: "claude", kind: "week", message });
}
```

5. 在 `claudeMeter` 的 `useMemo` 后加入：

```ts
const claudeFableLimit = useMemo(
  () => modelWeekLimitFor(visibleEvents, claudePlan, official.claude, "fable", now, weekBoostPct),
  [visibleEvents, claudePlan, official.claude, now, weekBoostPct],
);
```

6. 让卡片顶部状态同时反映 Fable 子额度。在 `AgentCard` 的派生值区域加入：

```ts
const cardStatus = effectiveQuotaStatus(meter.status, modelWeekLimit?.usedPct);
```

并把卡片顶部 badge 改为：

```tsx
<Badge tone={cardStatus}>{statusCopy[cardStatus]}</Badge>
```

7. Claude 的 `AgentCard` 传入：

```tsx
modelWeekLimit = { claudeFableLimit };
```

8. 从 presentation import 加入 `tightestQuota`，并把 Fable 纳入“更紧的窗口”总览。保留 `primaryMeters` 给 `AdviceCard` 使用，把现有 `allPrimaryMeters` 到 `tighterPct` 的计算完整改为：

```ts
const allPrimaryMeters = [
  { meter: claudeMeter, kind: official.claude?.windowKind ?? "five_hour" },
  { meter: grokMeter, kind: official.grok?.windowKind ?? "five_hour" },
  { meter: codexMeter, kind: official.codex?.windowKind ?? "five_hour" },
] satisfies { meter: typeof claudeMeter; kind: PrimaryWindowKind }[];
const primaryMeters = allPrimaryMeters.filter(({ meter }) => visibleAgents.includes(meter.agent));
const primaryLimits = primaryMeters.map(({ meter, kind }) => ({
  label: AGENT_LABEL[meter.agent],
  pct: primaryUsagePercent(meter, kind),
  resetsAt: primaryWindowResetsAt(meter, kind),
}));
if (claudeFableLimit && visibleAgents.includes("claude")) {
  primaryLimits.push({
    label: "Claude Fable 5",
    pct: claudeFableLimit.usedPct,
    resetsAt: claudeMeter.weekResetsAt,
  });
}
const tighter = tightestQuota(primaryLimits);
const tighterPct = tighter?.pct ?? 0;
```

同步把总览文案和回补时间改为：

```tsx
<p className="mt-3 text-sm text-mute">{tighter.label} 先碰到上限</p>
```

```tsx
{
  formatDuration(Math.max(0, tighter.resetsAt - now));
}
```

在 `README.md` 功能列表把 Claude 官方额度说明更新为：

```md
- 获取 Claude 5h/7d 官方利用率，并按本机日志估算 Claude Max 的 Fable 5 周子额度（总周额度的 50%）。
```

### 2.4 单元、静态与真实路径验收

先跑独立用例，再跑仓库门禁：

```bash
node --test --experimental-strip-types src/lib/quota/model-week-limit.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

启动真实应用：

```bash
sh startup.sh
```

用 Playwright 清空 `synq-quota-v8`，进入演示工作台，确认 Claude Code 卡片包含以下业务文本且页面无 console/page/network 错误：

```text
Fable 5 周额度（本机估算）
Claude Max 的 Fable 5 上限为总周额度的 50%；未包含其他设备用量。
```

同时验证移动端 390×844 无横向溢出，并保存截图到：

```text
screenshots/synq-fable-limit-desktop.png
screenshots/synq-fable-limit-mobile.png
```

最后停止 dev server，启动生产构建输出并重复桌面业务文本、console/page/network 无错检查。

验收标准：

- Claude Max 5× / 20× 均显示 Fable 5 独立周额度；Claude Pro/API 不显示。
- 优先按 Claude 官方周起点统计 Fable 事件；官方边界不可用时才回退最近 7 天。Opus/Sonnet/Haiku、过期事件和本周重置前事件不进入分子。
- 周额度加成同步放大 Fable 子额度分母。
- Fable 使用率达到“本周额度”阈值时只提醒一次，回落 12 个百分点后可重新提醒；卡片状态和“更紧的窗口”总览都能识别它比总额度更紧。
- UI 明确说明它是本机日志估算，不冒充官方百分比。
- 单测、typecheck、lint、build、开发态与生产态真实浏览器路径均通过。

Commit：

```text
fix(quota): add Claude Max Fable weekly limit
```

提交末尾追加本轮真实验证输出的 `Verified-by:` trailers。

## 3. Plan 自检

- **spec coverage**：50% Max 限额、Fable-only 统计、官方周边界、周加成、卡片展示、卡片状态、总览排序、阈值提醒、Pro/API 排除、估算口径说明均有对应实现与验收。
- **placeholder scan**：无 `TODO`、无用于省略实现的省略号、无伪代码；代码中的展开运算符是完整 TypeScript 语法，所有新增函数、测试、UI 与提醒代码均给出完整实现。
- **type consistency**：使用 Explore 核对过的 `PlanDef`、`UsageEvent`、`AgentCard`、`meterFor`、`inWindow`、`weightedTokens` 真实签名；新增类型由 `types.ts` 单一导出。
- **step size**：单个 TDD 单元，先用 4 个纯函数测试锁定领域行为，再一次接通现有 Claude 卡片和周阈值提醒，能在一个 commit 内独立验收。
