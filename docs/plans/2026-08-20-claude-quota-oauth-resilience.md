# Claude OAuth 额度解析与降级可信度修复计划

日期：2026-08-20
状态：待执行
范围：Claude OAuth usage 解析、429 退避、成功快照持久化、逐窗口来源标注

## 已核对事实与真实 API

- 真实响应是标量 `five_hour: 24`、`seven_day: 34`，并同时给出 `limits[].kind=session|weekly_all|weekly_scoped`。
- 当前 `claudeWindow()` 只接受对象；`parseClaudeUsagePayload(raw, opts): OfficialSlice | null` 因此丢失 5h 与总周额度。
- `readOfficialQuota(opts): Promise<OfficialQuota>` 每进程缓存 30 秒；`fetchClaudeUsage()` 把所有非 2xx 静默折成 `null`。
- `applyOfficial()` 只覆盖非空官方字段；`AgentCard` 无来源类型，官方未就绪时会把本地 token 估算写成“窗口剩余/本周额度”。
- Dashboard 每 2.5 秒拉取；两个实例会各自轮询。磁盘快照必须只包含额度切片和退避元数据，不能包含 token/header。

## Step 1：真实 Claude 响应契约

### 先写失败测试

在 `src/lib/quota/official.test.ts` 增加：

```ts
test("Claude OAuth usage parses the observed scalar 24/34/26 contract", () => {
  const usage = parseClaudeUsagePayload({
    five_hour: 24,
    seven_day: 34,
    limits: [
      { kind: "session", percent: 24 },
      { kind: "weekly_all", percent: 34 },
      {
        kind: "weekly_scoped",
        scope: { model: { display_name: "Fable" } },
        percent: 26,
      },
    ],
  });
  assert.ok(usage);
  assert.equal(usage.windowPct, 24);
  assert.equal(usage.weekPct, 34);
  assert.equal(usage.windowResetsAt, null);
  assert.equal(usage.weekResetsAt, null);
  assert.deepEqual(usage.modelWeekLimits, {
    fable: { usedPct: 26, resetsAt: null },
  });
});

test("Claude OAuth limits win over legacy top-level windows", () => {
  const usage = parseClaudeUsagePayload({
    five_hour: { utilization: 9, resets_at: "2026-08-20T15:00:00Z" },
    seven_day: { utilization: 11, resets_at: "2026-08-25T20:59:00Z" },
    limits: [
      { kind: "session", percent: 24, resets_at: "2026-08-20T16:00:00Z" },
      { kind: "weekly_all", percent: 34, resets_at: "2026-08-26T20:59:00Z" },
    ],
  });
  assert.ok(usage);
  assert.equal(usage.windowPct, 24);
  assert.equal(usage.weekPct, 34);
  assert.equal(usage.windowResetsAt, Date.parse("2026-08-20T16:00:00Z"));
  assert.equal(usage.weekResetsAt, Date.parse("2026-08-26T20:59:00Z"));
});

test("Claude OAuth skips invalid limits and falls back to valid top-level scalars", () => {
  const usage = parseClaudeUsagePayload({
    five_hour: "24",
    seven_day: 34,
    limits: [
      { kind: "session", percent: false },
      { kind: "weekly_all", percent: { value: 99 } },
    ],
  });
  assert.ok(usage);
  assert.equal(usage.windowPct, 24);
  assert.equal(usage.weekPct, 34);
  assert.equal(parseClaudeUsagePayload({ five_hour: false }), null);
});
```

运行红灯：

```bash
node --test --experimental-strip-types src/lib/quota/official.test.ts
```

### 实现

```ts
function claudeWindow(
  raw: unknown,
  percentKey: "utilization" | "percent",
): { usedPct: number; resetsAt: number | null } | null {
  const value = record(raw);
  const candidate = value ? value[percentKey] : raw;
  if (
    candidate == null
    || candidate === ""
    || (typeof candidate !== "number" && typeof candidate !== "string")
  ) return null;
  const usedPct = typeof candidate === "number" ? candidate : Number(candidate);
  if (!Number.isFinite(usedPct)) return null;
  return {
    usedPct: clampPct(usedPct),
    resetsAt: value ? timestampMs(value.resets_at) : null,
  };
}

function claudeLimit(
  root: Record<string, unknown>,
  kind: "session" | "weekly_all",
): { usedPct: number; resetsAt: number | null } | null {
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const limit = record(item);
    if (!limit || limit.kind !== kind) continue;
    const parsed = claudeWindow(limit, "percent");
    if (parsed) return parsed;
  }
  return null;
}
```

`parseClaudeUsagePayload()` 中使用：

```ts
const fiveHour = claudeLimit(root, "session") ?? claudeWindow(root.five_hour, "utilization");
const sevenDay = claudeLimit(root, "weekly_all") ?? claudeWindow(root.seven_day, "utilization");
```

`fableLimit()` 保持 `weekly_scoped + Fable/Fable 5` 优先、`seven_day_overage_included` fallback。旧对象测试必须继续通过。

验收：24/34/26、limits 优先、旧对象、旧 Fable fallback 全绿。
Commit：`fix: parse observed Claude OAuth quota shape`

## Step 2：429 Retry-After 与指数退避

### 先写失败测试

在 `official.server.test.ts` 增加：

```ts
test("Claude 429 Retry-After suppresses repeated OAuth requests", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      if (claudeCalls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      }
      return new Response(JSON.stringify({ five_hour: 24, seven_day: 34 }), { status: 200 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });
  await readAt(now);
  await readAt(now + 30_000);
  assert.equal(claudeCalls, 1);
  const recovered = await readAt(now + 120_001);
  assert.equal(claudeCalls, 2);
  assert.equal(recovered.claude?.windowPct, 24);
  assert.equal(recovered.claude?.weekPct, 34);
});

test("Claude Retry-After accepts an HTTP date", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  assert.equal(
    claudeRetryAfterMs("Thu, 20 Aug 2026 12:02:00 GMT", now),
    120_000,
  );
});
```

### 实现

```ts
export const CLAUDE_BACKOFF_BASE_MS = 30_000;
export const CLAUDE_BACKOFF_MAX_MS = 60 * 60 * 1000;

interface ClaudeUsageFetchResult {
  slice: OfficialSlice | null;
  status: number | null;
  retryAfterMs: number | null;
}

interface ClaudeCacheEntry {
  checkedAt: number;
  loadedAt: number;
  slice: OfficialSlice | null;
  failureCount: number;
  nextAllowedAt: number;
  updatedAt: number;
  lastAttemptFailed: boolean;
}

export function claudeRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const raw = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.max(1000, Math.min(CLAUDE_BACKOFF_MAX_MS, Math.ceil(raw)));
}

function claudeBackoffMs(failureCount: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null) return retryAfterMs;
  const exponent = Math.max(0, Math.min(10, failureCount - 1));
  return Math.min(CLAUDE_BACKOFF_MAX_MS, CLAUDE_BACKOFF_BASE_MS * 2 ** exponent);
}
```

新增内部 `fetchClaudeUsageResult()`：保留响应 status；429 读取 `Retry-After`；网络错误返回 status null；公开 `fetchClaudeUsage()` 继续只返回 slice，避免破坏调用方。

`readOfficialQuota()` 的 Claude cache 使用上述完整字段：成功时 `failureCount=0,nextAllowedAt=0,lastAttemptFailed=false`；失败时保留一小时内的最后成功 slice 并设置 `nextAllowedAt`；即使 `skipCache=true` 也不得绕过 `nextAllowedAt`。

验收：秒数/HTTP-date 生效，无 header 时 30s→60s→120s，成功清零。

额外失败测试必须覆盖：连续三个无 header 429 的 30s→60s→120s 请求次数；成功后下一次失败从 30s 重新开始；网络错误走指数退避；负数、非法和超过一小时的 `Retry-After` 被拒绝或 clamp；多次 `skipCache=true` 仍不能越过 `nextAllowedAt`。
Commit：`fix: back off Claude OAuth quota polling`

## Step 3：持久化最后成功快照

### 先写失败测试

```ts
test("Claude last-success snapshot survives cache reset and redacts auth", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const snapshotPath = join(home, "state", "official-quota.json");
  const now = Date.parse("2026-08-20T12:00:00Z");
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          five_hour: 24,
          seven_day: 34,
          limits: [{
            kind: "weekly_scoped",
            scope: { model: { display_name: "Fable" } },
            percent: 26,
          }],
        }), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  await readOfficialQuota({
    home, grokHome, snapshotPath, now, fetchImpl, skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "never-write-this-token" }),
  });
  clearOfficialCache();
  const restored = await readOfficialQuota({
    home, grokHome, snapshotPath, now: now + 30_001, fetchImpl, skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "never-write-this-token" }),
  });
  assert.equal(restored.claude?.windowPct, 24);
  assert.equal(restored.claude?.weekPct, 34);
  assert.equal(restored.claude?.modelWeekLimits?.fable?.usedPct, 26);
  assert.equal(restored.claude?.windowStale, true);
  assert.equal(restored.claude?.weekStale, true);
  assert.equal(restored.claude?.modelWeekLimitsStale, true);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /never-write-this-token|authorization|access.?token|bearer|headers/i);
});
```

### 实现

给 `OfficialSlice` 增加字段级 stale 标记，避免把新 Desktop history 与旧 OAuth Fable 混成一个全局状态：

```ts
windowStale?: boolean;
weekStale?: boolean;
modelWeekLimitsStale?: boolean;
```

给 `readOfficialQuota()` 增加 `snapshotPath?: string`。

```ts
export function claudeSnapshotPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Synq", "official-quota.json");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Synq", "official-quota.json");
  }
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "synq", "official-quota.json");
}

function staleOfficial(slice: OfficialSlice | null): OfficialSlice | null {
  return slice ? {
    ...slice,
    windowStale: slice.windowPct != null,
    weekStale: slice.weekPct != null,
    modelWeekLimitsStale: Boolean(slice.modelWeekLimits),
  } : null;
}

interface ClaudeSnapshotFile {
  version: 1;
  claude: ClaudeCacheEntry;
}
```

`readClaudeSnapshot()` 必须校验 version、agent、所有时间/计数字段和 boolean；损坏返回 null。`writeClaudeSnapshot()` 必须 `mkdirSync(dirname(path), {recursive:true,mode:0o700})`，以 `writeFileSync(temp,{mode:0o600}) + renameSync` 原子替换；catch 只清理本次 temp。写入前从 slice 去掉三个 stale 字段。不能写 auth。

不能只用 `updatedAt` 做无锁覆盖。实现 `withClaudeSnapshotLock(path, action)`：以 `openSync(path + ".lock", "wx", 0o600)` 获取跨进程锁；锁存在时异步短退避重试，总等待小于 10 秒；超过 30 秒的死锁文件可清理。只有持锁者能执行“重新读取 snapshot → 判断 `nextAllowedAt` → OAuth fetch → 原子写回”，并在 `finally` 关闭 fd、删除本次锁。拿不到锁的调用只读最后快照并降级，不得再请求 OAuth。

这样两个实例不会并发请求或 lost update。`skipCache` 只跳过成功值的 30 秒 TTL，不能跳过锁内重新读取和 `nextAllowedAt`。恢复值只在 `loadedAt` 一小时内展示。

`mergeClaudeOfficial()` 的字段级规则：stale OAuth window/week 遇到非空 Desktop history 时由 history 覆盖并清除对应 stale 标记；OAuth 独有的 stale Fable 保留并设置 `modelWeekLimitsStale=true`；fresh OAuth 始终优先。新增 stale OAuth + fresh history、fresh OAuth + history 两组测试。

验收测试还必须覆盖：malformed JSON/version/type/过期快照静默降级；目录/文件 mode；无临时文件残留；两个并发 `readOfficialQuota()` 共享一个 snapshot 时 Claude fetch 只发生一次；清内存后 backoff 期内 `skipCache=true` 仍不请求；递归检查 snapshot 与 temp 均无 auth/token/header 字段和值。
Commit：`fix: persist Claude quota success snapshots`

## Step 4：逐窗口数据来源

### 先写失败测试

```ts
test("official-only meters cannot alert on local 100/73 estimates", () => {
  const sources = meterDataSources(null);
  assert.deepEqual(sources, { window: "local-estimate", week: "local-estimate" });
  assert.equal(officialOnlyMeter(meterFixture, sources), null);

  const weeklySources = meterDataSources(officialFixture({ weekPct: 34 }));
  const weekly = officialOnlyMeter({ ...meterFixture, weekPct: 34 }, weeklySources);
  assert.ok(weekly);
  assert.equal(weekly.windowPct, 0);
  assert.equal(weekly.weekPct, 34);
  assert.equal(weekly.status, "ok");
});
```

测试文件内写出完整 `meterFixture: MeterSnapshot` 与 `officialFixture(): OfficialSlice`，不依赖 mock cast。

### 实现

```ts
export type MeterDataSource = "official" | "official-stale" | "local-estimate";

export interface MeterDataSources {
  window: MeterDataSource;
  week: MeterDataSource;
}

export function meterDataSources(
  official: OfficialSlice | null | undefined,
): MeterDataSources {
  return {
    window: official?.windowPct == null
      ? "local-estimate"
      : official.windowStale
        ? "official-stale"
        : "official",
    week: official?.weekPct == null
      ? "local-estimate"
      : official.weekStale
        ? "official-stale"
        : "official",
  };
}

export function officialOnlyMeter(
  meter: MeterSnapshot,
  sources: MeterDataSources,
): MeterSnapshot | null {
  if (sources.window !== "official" && sources.week !== "official") return null;
  const windowPct = sources.window === "official" ? meter.windowPct : 0;
  const weekPct = sources.week === "official" ? meter.weekPct : 0;
  return {
    ...meter,
    windowPct,
    weekPct,
    status: meterStatus(windowPct, weekPct),
  };
}
```

验收：local 100/73 无法进入官方告警、Advice、“更紧窗口”；仅 weekly 官方时 5h 仍为 local。
补充 stale slice 测试：stale 可展示但 `officialOnlyMeter()` 返回 null；fresh weekly 仍可参与。Dashboard 消费逻辑抽成纯函数或直接在 `engine.test.ts` 覆盖官方-only advisory 列表，证明 alerts、Advice 和 tightest 的输入均已过滤。
Commit：`fix: track quota source per window`

## Step 5：额度来源文案契约

### 先写失败测试

新增 `src/lib/quota/quota-label.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaSourceLabel, quotaSourceMessage } from "./quota-label.ts";

test("local quota labels never impersonate official quota", () => {
  assert.equal(quotaSourceLabel("5 小时窗", "local-estimate"), "5 小时窗用量（本地估算）");
  assert.equal(quotaSourceLabel("本周额度", "local-estimate"), "本周用量（本地估算）");
  assert.equal(quotaSourceLabel("5 小时窗", "official"), "5 小时窗（官方）");
  assert.equal(quotaSourceLabel("本周额度", "official"), "本周额度（官方）");
  assert.equal(quotaSourceLabel("本周额度", "official-stale"), "本周额度（官方快照）");
});

test("quota source messages cover loading, failure, mixed, and stale", () => {
  assert.equal(
    quotaSourceMessage("loading", false, true, false),
    "正在读取官方额度；当前百分比为本地日志估算。",
  );
  assert.equal(
    quotaSourceMessage("error", false, true, false),
    "官方额度读取失败；当前百分比为本地日志估算。",
  );
  assert.equal(
    quotaSourceMessage("ready", true, true, false),
    "部分窗口未读到官方值；对应百分比为本地日志估算。",
  );
  assert.equal(
    quotaSourceMessage("ready", true, false, true),
    "官方接口暂不可用；显示上次成功快照。",
  );
});
```

### 实现

新增 `src/lib/quota/quota-label.ts`：

```ts
import type { MeterDataSource } from "./engine.ts";

export type OfficialLoadState = "loading" | "ready" | "error";

export function quotaSourceLabel(
  label: "5 小时窗" | "本周额度",
  source: MeterDataSource,
): string {
  if (source === "official") return label + "（官方）";
  if (source === "official-stale") return label + "（官方快照）";
  return label === "本周额度"
    ? "本周用量（本地估算）"
    : "5 小时窗用量（本地估算）";
}

export function quotaSourceMessage(
  loadState: OfficialLoadState,
  hasOfficial: boolean,
  hasLocal: boolean,
  stale: boolean,
): string | null {
  if (stale) return "官方接口暂不可用；显示上次成功快照。";
  if (!hasLocal) return null;
  if (loadState === "loading") return "正在读取官方额度；当前百分比为本地日志估算。";
  if (loadState === "error") return "官方额度读取失败；当前百分比为本地日志估算。";
  if (hasOfficial) return "部分窗口未读到官方值；对应百分比为本地日志估算。";
  return "官方额度暂不可用；当前百分比为本地日志估算。";
}
```

验收：pure tests 全绿，三种来源均有唯一、不可混淆的文案。
Commit：`fix: define truthful quota source labels`

## Step 6：AgentCard、Dashboard 与可控浏览器契约

### 先写失败测试

新增 `scripts/quota-source-e2e.mjs`。使用 Playwright 路由同时拦截 `pullAgentAvailability` 与 `pullOfficialQuota`；用当前 TanStack 使用的 `seroval.toCrossJSON()` 生成带 `x-tss-serialized: true` 的响应。每个 case 使用独立 context 并预置 `onboardingComplete=true`、Claude-only availability。

必须先让以下五个 case 失败：

1. hold official response：页面出现“正在读取官方额度”，local bar 只写“本地估算”。
2. full 24/34/26 response：出现 `5 小时窗（官方）`、`本周额度（官方）`、`Fable 5 周额度（官方）` 和 24/34/26。
3. mixed response（window null, week 34）：5h 写本地估算，weekly 写官方。
4. stale field response：bar 写“官方快照”，页面写“官方接口暂不可用”，且不产生新 alert。
5. aborted official request：页面写“官方额度读取失败”，不存在把 local bar 标成官方的文本。

每个 case 断言 desktop 与 390px 无横向溢出，收集 console/page/request/HTTP errors；只允许 error case 中被测试主动 abort 的那一个 official request。

### 实现

`AgentCard` 增加有默认值的 `quotaSources`、`officialLoadState` props。主数字在 local 时写“本地估算窗口剩余/周剩余”；所有 MeterBar 分支必须调用 `quotaSourceLabel()`。Fable 根据 `modelWeekLimitsStale` 显示“官方快照”。无 fresh 官方窗口时 Badge 文案为“本地估算”或“官方快照”，不能显示“将尽”。

Dashboard 初始 `officialLoadState="loading"`；server function 成功为 ready、抛错为 error。三张卡传各自的 `meterDataSources()`。Claude note 分为“官方 OAuth 利用率”“Claude Desktop 历史利用率”“上次官方快照”。

非演示模式下，alerts、Advice 和“更紧窗口”只消费 `officialOnlyMeter()`；明确用 `!state.official.claude?.modelWeekLimitsStale` 保护 Fable alert，并从 primaryLimits/Advice 过滤 stale Fable。顶部说明改成：

```tsx
官方额度可用时优先显示；未读到的窗口会明确标为本地估算。金额仍是本机日志按公开 API 价折算的 API 等价。
```

验收：pure/组件逻辑测试与五态 Playwright 全绿；未加载=正在读取；失败=本地估算；24/34/26=官方；stale=上次快照；local 100/73 不再冒充官方。
Commit：`fix: label estimated quota data in the dashboard`

## 最终验证

```bash
node --test --experimental-strip-types src/lib/quota/official.test.ts src/lib/quota/official.server.test.ts src/lib/quota/engine.test.ts src/lib/quota/quota-label.test.ts
npm test
npm run typecheck
npm run lint
npm run build
sh startup.sh
node scripts/browser-smoke.mjs http://127.0.0.1:8080/
node scripts/onboarding-e2e.mjs http://127.0.0.1:8080/ screenshots
node scripts/quota-source-e2e.mjs http://127.0.0.1:8080/ screenshots
```

每个验证命令额外写真实 exit code 到独立 `/tmp/synq-quota-*.exit` 并输出 `===DRAIN-SENTINEL===`。浏览器核验桌面和 390px、卡片来源文案、无 console/page/network error。生产 build 启动后再验一次静态资源与业务页。

## 四关自检

- Spec coverage：真实响应、429、跨重启快照、UI 加载/估算态、24/34/26 全覆盖。
- Placeholder scan：代码块无 TODO、伪代码、空实现或省略号。
- Type consistency：所有签名来自当前源码；新增字段可选或有默认值。
- Step size：六个 step 各自一个合同；pure label 与 UI/E2E 已拆开，均先红后绿并独立 commit。
