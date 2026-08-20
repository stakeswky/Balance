# Claude Fable 官方周额度接入与 140% 修复计划

日期：2026-08-20  
状态：执行中（Step 1 已完成并通过 `official.test.ts`）  
范围：读取 Claude Code OAuth usage 的 Fable 周百分比，移除本机 token 伪估算，保留 Claude Desktop 5h/7d 后备

## 1. Spec 与根因

- Claude Max 的 Fable 5 周额度必须使用 Anthropic 返回的真实百分比；本次验收样例为 `24%`。
- Claude Code 2.1.234 的 usage UI 调用 `GET https://api.anthropic.com/api/oauth/usage`，并从 `limits[]` 中筛选 `kind === "weekly_scoped"` 且 `scope.model.display_name` 为 `Fable` 或 `Fable 5` 的项目；`percent` 是已用百分比，`resets_at` 是重置时间。
- 当前 `modelWeekLimitFor` 把本机 Fable weighted token 除以 `plan.weekTokenBudget * 50%`，再由全局 `clampPct` 放宽到 140%，因此会把真实 24% 显示成 140%。这条算法不具备跨设备完整性，也没有 Anthropic 的 token-to-plan 换算依据，必须停止作为 Fable 百分比来源。
- `/api/oauth/usage` 是未公开稳定化的第一方 OAuth 接口，可能返回 401、403、429 或改 schema。接口或凭据不可用时继续使用 `plan-usage-history.json` 的 5h/7d，但不显示伪造的 Fable 百分比。
- OAuth token 只允许在服务端内存中使用，不返回前端、不写日志、不写 Synq 数据文件。macOS 优先读取有效的 `~/.claude/.credentials.json`，再只读查询 Keychain `Claude Code-credentials`；不刷新、不覆盖 Claude 凭据。
- 成功响应缓存 30 秒；失败时最多保留最近 60 分钟的成功 Fable 快照，避免 2.5 秒 UI 轮询打爆 usage 接口。

## 2. Explore 核对的真实签名

```ts
export interface OfficialSlice {
  agent: "claude" | "grok" | "codex";
  windowPct: number | null;
  weekPct: number | null;
  windowResetsAt: number | null;
  weekResetsAt: number | null;
  weekStartedAt: number | null;
  windowDurationMs: number | null;
  weekDurationMs: number | null;
  burnPctPerHour: number;
  planLabel: string | null;
  products: OfficialProductShare[];
  prepaidBalance: number | null;
  onDemandUsed: number | null;
  onDemandCap: number | null;
  source: string;
  fetchedAt: number;
  windowKind: "five_hour" | "weekly";
}

export async function readOfficialQuota(opts?: {
  home?: string;
  grokHome?: string;
  codexHome?: string;
  now?: number;
  fetchImpl?: FetchLike;
  skipCache?: boolean;
  cacheMs?: number;
}): Promise<OfficialQuota>;

export function modelWeekLimitFor(
  events: UsageEvent[],
  plan: PlanDef,
  official: OfficialSlice | null | undefined,
  model: ModelId,
  now: number,
  boostPct: number,
): ModelWeekLimitSnapshot | null;
```

现有 live API 模式为 `fetchCodexUsage(auth, opts?)`、`fetchGrokBilling(token, opts?)`，测试统一通过 `fetchImpl` 注入 `Response`。本计划沿用该结构。

## 3. TDD Step 1：解析 Claude OAuth usage

提交：`feat(quota): parse Claude OAuth model limits`

### 3.1 先写失败测试

在 `src/lib/quota/official.test.ts` 增加以下完整测试：

```ts
test("Claude OAuth usage exposes the official Fable weekly limit", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const fableReset = "2026-08-25T20:59:00Z";
  const usage = parseClaudeUsagePayload(
    {
      five_hour: { utilization: 34, resets_at: "2026-08-20T15:00:00Z" },
      seven_day: { utilization: 27, resets_at: "2026-08-25T20:59:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Fable 5" } },
          percent: 24,
          resets_at: fableReset,
        },
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Other" } },
          percent: 91,
          resets_at: fableReset,
        },
      ],
    },
    { fetchedAt: now },
  );

  assert.ok(usage);
  assert.equal(usage.windowPct, 34);
  assert.equal(usage.weekPct, 27);
  assert.deepEqual(usage.modelWeekLimits, {
    fable: { usedPct: 24, resetsAt: Date.parse(fableReset) },
  });
  assert.equal(usage.source, "oauth-usage");
});

test("Claude OAuth usage accepts Fable and ignores malformed scoped limits", () => {
  const usage = parseClaudeUsagePayload({
    seven_day_overage_included: { utilization: 31, resets_at: 1787691540 },
    limits: [
      { kind: "daily_scoped", scope: { model: { display_name: "Fable" } }, percent: 90 },
      { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: "bad" },
    ],
  });

  assert.ok(usage);
  assert.deepEqual(usage.modelWeekLimits, {
    fable: { usedPct: 31, resetsAt: 1787691540 * 1000 },
  });
});

test("Claude OAuth usage rejects payloads without any usage windows", () => {
  assert.equal(parseClaudeUsagePayload({ limits: [] }), null);
});
```

把 `parseClaudeUsagePayload` 加入该测试文件现有 import。执行：

```bash
node --test --experimental-strip-types src/lib/quota/official.test.ts
```

验收红灯：测试因缺少导出或返回结构不匹配而失败。

### 3.2 实现完整类型与解析器

在 `src/lib/quota/official.ts` 顶部加入类型 import 和模型限额类型，并把可选字段加入 `OfficialSlice`：

```ts
import type { ModelId } from "./types.ts";

export interface OfficialModelWeekLimit {
  usedPct: number;
  resetsAt: number | null;
}

export type OfficialModelWeekLimits = Partial<Record<ModelId, OfficialModelWeekLimit>>;

export interface OfficialSlice {
  agent: "claude" | "grok" | "codex";
  windowPct: number | null;
  weekPct: number | null;
  windowResetsAt: number | null;
  weekResetsAt: number | null;
  weekStartedAt: number | null;
  windowDurationMs: number | null;
  weekDurationMs: number | null;
  burnPctPerHour: number;
  planLabel: string | null;
  products: OfficialProductShare[];
  prepaidBalance: number | null;
  onDemandUsed: number | null;
  onDemandCap: number | null;
  modelWeekLimits?: OfficialModelWeekLimits;
  source: string;
  fetchedAt: number;
  windowKind: "five_hour" | "weekly";
}
```

在 `parseClaudeHistoryPoints` 前加入以下完整实现：

```ts
function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function timestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v >= 1_000_000_000_000 ? v : v * 1000;
  }
  if (typeof v !== "string" || !v) return null;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function claudeWindow(
  raw: unknown,
  percentKey: "utilization" | "percent",
): { usedPct: number; resetsAt: number | null } | null {
  const value = record(raw);
  if (!value) return null;
  const candidate = value[percentKey];
  if (candidate == null || candidate === "") return null;
  const usedPct = typeof candidate === "number" ? candidate : Number(candidate);
  if (!Number.isFinite(usedPct)) return null;
  return {
    usedPct: clampPct(usedPct),
    resetsAt: timestampMs(value.resets_at),
  };
}

function fableLimit(root: Record<string, unknown>): OfficialModelWeekLimit | null {
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const limit = record(item);
    if (!limit || limit.kind !== "weekly_scoped") continue;
    const scope = record(limit.scope);
    const model = record(scope?.model);
    const displayName = typeof model?.display_name === "string" ? model.display_name.toLowerCase() : "";
    if (displayName !== "fable" && displayName !== "fable 5") continue;
    const parsed = claudeWindow(limit, "percent");
    if (parsed) return parsed;
  }
  return claudeWindow(root.seven_day_overage_included, "utilization");
}

export function parseClaudeUsagePayload(
  raw: unknown,
  opts?: { fetchedAt?: number; source?: string },
): OfficialSlice | null {
  const root = record(raw);
  if (!root) return null;
  const fiveHour = claudeWindow(root.five_hour, "utilization");
  const sevenDay = claudeWindow(root.seven_day, "utilization");
  const fable = fableLimit(root);
  if (!fiveHour && !sevenDay && !fable) return null;
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  const weekResetsAt = sevenDay?.resetsAt ?? fable?.resetsAt ?? null;
  return {
    agent: "claude",
    windowPct: fiveHour?.usedPct ?? null,
    weekPct: sevenDay?.usedPct ?? null,
    windowResetsAt: fiveHour?.resetsAt ?? null,
    weekResetsAt,
    weekStartedAt: weekResetsAt == null ? null : weekResetsAt - WEEK_MS,
    windowDurationMs: FIVE_HOUR_MS,
    weekDurationMs: WEEK_MS,
    burnPctPerHour: 0,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    modelWeekLimits: fable ? { fable } : undefined,
    source: opts?.source ?? "oauth-usage",
    fetchedAt,
    windowKind: "five_hour",
  };
}

export function mergeClaudeOfficial(
  live: OfficialSlice | null,
  history: OfficialSlice | null,
): OfficialSlice | null {
  if (!live) return history;
  if (!history) return live;
  return {
    agent: history.agent,
    windowPct: live.windowPct ?? history.windowPct,
    weekPct: live.weekPct ?? history.weekPct,
    windowResetsAt: live.windowResetsAt ?? history.windowResetsAt,
    weekResetsAt: live.weekResetsAt ?? history.weekResetsAt,
    weekStartedAt: live.weekStartedAt ?? history.weekStartedAt,
    windowDurationMs: live.windowDurationMs ?? history.windowDurationMs,
    weekDurationMs: live.weekDurationMs ?? history.weekDurationMs,
    burnPctPerHour: history.burnPctPerHour || live.burnPctPerHour,
    planLabel: live.planLabel ?? history.planLabel,
    products: live.products.length ? live.products : history.products,
    prepaidBalance: live.prepaidBalance ?? history.prepaidBalance,
    onDemandUsed: live.onDemandUsed ?? history.onDemandUsed,
    onDemandCap: live.onDemandCap ?? history.onDemandCap,
    modelWeekLimits: live.modelWeekLimits ?? history.modelWeekLimits,
    source: live.source,
    fetchedAt: Math.max(live.fetchedAt, history.fetchedAt),
    windowKind: live.windowKind,
  };
}
```

验收绿灯：上述测试通过；现有 `official.test.ts` 全部保持通过。

## 4. TDD Step 2：服务端凭据、API 与限流缓存

提交：`feat(quota): fetch Claude OAuth usage`

### 4.1 先写失败测试

在 `src/lib/quota/official.server.test.ts` 将 import 改为：

```ts
import {
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_STALE_MS,
  claudeOauthAuthFromCredentials,
  clearOfficialCache,
  CODEX_USAGE_URL,
  GROK_BILLING_URL,
  readOfficialQuota,
} from "./official.server.ts";
```

增加以下完整测试：

```ts
test("readOfficialQuota reads the official Fable percent from Claude OAuth usage", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer claude-token");
      assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 34, resets_at: "2026-08-20T15:00:00Z" },
          seven_day: { utilization: 27, resets_at: "2026-08-25T20:59:00Z" },
          limits: [
            {
              kind: "weekly_scoped",
              scope: { model: { display_name: "Fable" } },
              percent: 24,
              resets_at: "2026-08-25T20:59:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const q = await readOfficialQuota({
    home,
    grokHome,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  assert.equal(q.claude?.windowPct, 34);
  assert.equal(q.claude?.weekPct, 27);
  assert.equal(q.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(q.claude?.source, "oauth-usage");
});

test("readOfficialQuota keeps desktop 5h and 7d without inventing Fable after a 429", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const q = await readOfficialQuota({
    home,
    grokHome,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  assert.equal(q.claude?.windowPct, 7);
  assert.equal(q.claude?.weekPct, 19);
  assert.equal(q.claude?.modelWeekLimits?.fable, undefined);
  assert.equal(q.claude?.source, "plan-usage-history");
});

test("Claude usage cache keeps a successful Fable snapshot for at most 60 minutes", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      if (claudeCalls > 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({
          seven_day: { utilization: 27, resets_at: "2026-08-25T20:59:00Z" },
          limits: [
            {
              kind: "weekly_scoped",
              scope: { model: { display_name: "Fable" } },
              percent: 24,
              resets_at: "2026-08-25T20:59:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) =>
    readOfficialQuota({
      home,
      grokHome,
      fetchImpl,
      cacheMs: 30_000,
      readClaudeAuth: async () => ({ accessToken: "claude-token" }),
      now: at,
    });

  const first = await readAt(now);
  const fresh = await readAt(now + 5_000);
  const stale = await readAt(now + 30_001);
  const expired = await readAt(now + CLAUDE_USAGE_STALE_MS + 30_002);

  assert.equal(first.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(fresh.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(stale.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(expired.claude?.modelWeekLimits?.fable, undefined);
  assert.equal(claudeCalls, 3);
});

test("Claude OAuth auth parser rejects expired and empty credentials", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  assert.equal(
    claudeOauthAuthFromCredentials({ claudeAiOauth: { accessToken: "", expiresAt: now + 60_000 } }, now),
    null,
  );
  assert.equal(
    claudeOauthAuthFromCredentials(
      { claudeAiOauth: { accessToken: "expired", expiresAt: now - 60_000 } },
      now,
    ),
    null,
  );
  assert.deepEqual(
    claudeOauthAuthFromCredentials(
      { claudeAiOauth: { accessToken: "valid", expiresAt: now + 60_000 } },
      now,
    ),
    { accessToken: "valid" },
  );
});
```

同时导入 `claudeOauthAuthFromCredentials`。执行：

```bash
node --test --experimental-strip-types src/lib/quota/official.server.test.ts
```

验收红灯：缺少 Claude server 导出及 `readClaudeAuth` 注入点。

### 4.2 实现完整服务端接入

在 `src/lib/quota/official.server.ts` 增加 `node:child_process`、`node:util` import，并从 `official.ts` 导入 `mergeClaudeOfficial`、`parseClaudeUsagePayload`：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
```

加入以下完整常量、类型与函数：

```ts
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_STALE_MS = 60 * 60 * 1000;

export interface ClaudeOauthAuth {
  accessToken: string;
}

type ReadClaudeAuth = (home: string, now: number) => Promise<ClaudeOauthAuth | null>;

const execFileAsync = promisify(execFile);
const claudeCache = new Map<
  string,
  { checkedAt: number; loadedAt: number; slice: OfficialSlice | null }
>();

export function claudeOauthAuthFromCredentials(
  raw: unknown,
  now = Date.now(),
): ClaudeOauthAuth | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const nested = root.claudeAiOauth;
  const oauth = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : root;
  const accessToken =
    typeof oauth.accessToken === "string"
      ? oauth.accessToken
      : typeof oauth.access_token === "string"
        ? oauth.access_token
        : "";
  if (!accessToken) return null;
  const expiresCandidate = oauth.expiresAt ?? oauth.expires_at;
  const expiresAt = typeof expiresCandidate === "number" ? expiresCandidate : Number(expiresCandidate);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) return null;
  return { accessToken };
}

async function readClaudeOauthAuth(home: string, now: number): Promise<ClaudeOauthAuth | null> {
  const fileRaw = readText(join(home, ".claude", ".credentials.json"));
  if (fileRaw) {
    try {
      const fromFile = claudeOauthAuthFromCredentials(JSON.parse(fileRaw), now);
      if (fromFile) return fromFile;
    } catch {
      // Malformed local credentials fall through to the read-only Keychain lookup.
    }
  }
  if (process.platform !== "darwin" || home !== homedir()) return null;
  try {
    const result = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
      { encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024 },
    );
    return claudeOauthAuthFromCredentials(JSON.parse(result.stdout), now);
  } catch {
    return null;
  }
}

export async function fetchClaudeUsage(
  auth: ClaudeOauthAuth,
  opts?: { fetchImpl?: FetchLike; now?: number },
): Promise<OfficialSlice | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseClaudeUsagePayload(body, {
      fetchedAt: opts?.now ?? Date.now(),
      source: "oauth-usage",
    });
  } catch {
    return null;
  }
}
```

把 `readOfficialQuota` 的 opts 增加：

```ts
readClaudeAuth?: ReadClaudeAuth;
```

把函数中的 Claude 读取改为 `claudeHistory`，并在 Grok/Codex live 分支前加入完整 Claude 分支：

```ts
const claudeHistory = readClaudeOfficial(home, now);
const cacheMs = opts?.cacheMs ?? GROK_BILLING_CACHE_MS;
const claudeHit = !opts?.skipCache ? claudeCache.get(home) : undefined;
const claudeFresh = Boolean(claudeHit && now - claudeHit.checkedAt < cacheMs);

let claudeLive: OfficialSlice | null = claudeFresh ? (claudeHit?.slice ?? null) : null;
if (!claudeFresh) {
  const readAuth = opts?.readClaudeAuth ?? readClaudeOauthAuth;
  const auth = await readAuth(home, now);
  const fetched = auth
    ? await fetchClaudeUsage(auth, { fetchImpl: opts?.fetchImpl, now })
    : null;
  if (fetched) {
    claudeLive = fetched;
    claudeCache.set(home, { checkedAt: now, loadedAt: now, slice: fetched });
  } else {
    const stale =
      claudeHit && now - claudeHit.loadedAt <= CLAUDE_USAGE_STALE_MS
        ? claudeHit.slice
        : null;
    claudeLive = stale;
    claudeCache.set(home, {
      checkedAt: now,
      loadedAt: stale ? claudeHit?.loadedAt ?? now : 0,
      slice: stale,
    });
  }
}

const claude = mergeClaudeOfficial(claudeLive, claudeHistory);
```

`readOfficialQuota` 的完整最终实现必须是：

```ts
export async function readOfficialQuota(opts?: {
  home?: string;
  grokHome?: string;
  codexHome?: string;
  now?: number;
  fetchImpl?: FetchLike;
  readClaudeAuth?: ReadClaudeAuth;
  skipCache?: boolean;
  cacheMs?: number;
}): Promise<OfficialQuota> {
  const home = opts?.home ?? homedir();
  const now = opts?.now ?? Date.now();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const codexHome = codexHomeOf(home, opts?.codexHome);
  const claudeHistory = readClaudeOfficial(home, now);
  const log = readGrokLog(grokHome);
  const codexLog = readCodexOfficialFromSessions(codexHome);

  const cacheMs = opts?.cacheMs ?? GROK_BILLING_CACHE_MS;
  const claudeHit = !opts?.skipCache ? claudeCache.get(home) : undefined;
  const grokHit = !opts?.skipCache ? grokCache.get(grokHome) : undefined;
  const codexHit = !opts?.skipCache ? codexCache.get(codexHome) : undefined;
  const claudeFresh = Boolean(claudeHit && now - claudeHit.checkedAt < cacheMs);
  const grokFresh = Boolean(grokHit && now - grokHit.at < cacheMs);
  const codexFresh = Boolean(codexHit && now - codexHit.at < cacheMs);
  if (claudeFresh && grokFresh && codexFresh) {
    return {
      claude: mergeClaudeOfficial(claudeHit?.slice ?? null, claudeHistory),
      grok: mergeGrokOfficial(grokHit?.slice ?? null, log),
      codex: codexHit?.slice ?? codexLog,
    };
  }

  let claudeLive: OfficialSlice | null = claudeFresh ? (claudeHit?.slice ?? null) : null;
  if (!claudeFresh) {
    const readAuth = opts?.readClaudeAuth ?? readClaudeOauthAuth;
    const auth = await readAuth(home, now);
    const fetched = auth
      ? await fetchClaudeUsage(auth, { fetchImpl: opts?.fetchImpl, now })
      : null;
    if (fetched) {
      claudeLive = fetched;
      claudeCache.set(home, { checkedAt: now, loadedAt: now, slice: fetched });
    } else {
      const stale =
        claudeHit && now - claudeHit.loadedAt <= CLAUDE_USAGE_STALE_MS
          ? claudeHit.slice
          : null;
      claudeLive = stale;
      claudeCache.set(home, {
        checkedAt: now,
        loadedAt: stale ? claudeHit?.loadedAt ?? now : 0,
        slice: stale,
      });
    }
  }

  let grokLive: OfficialSlice | null = grokFresh ? grokHit?.slice ?? null : null;
  if (!grokFresh) {
    const token = readGrokToken(grokHome);
    if (token) grokLive = await fetchGrokBilling(token, { fetchImpl: opts?.fetchImpl, now });
    grokCache.set(grokHome, { at: now, slice: grokLive });
  }

  let codexLive: OfficialSlice | null = codexFresh ? codexHit?.slice ?? null : null;
  if (!codexFresh) {
    const auth = readCodexToken(codexHome);
    if (auth) codexLive = await fetchCodexUsage(auth, { fetchImpl: opts?.fetchImpl, now });
    codexCache.set(codexHome, { at: now, slice: codexLive });
  }

  return {
    claude: mergeClaudeOfficial(claudeLive, claudeHistory),
    grok: mergeGrokOfficial(grokLive, log),
    codex: codexLive ?? codexLog,
  };
}
```

`officialFilesMtime` 的完整路径数组改为：

```ts
const paths = [
  join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"),
  join(home, ".claude", ".credentials.json"),
  join(grokHomeOf(home, grokHome), "logs", "unified.jsonl"),
  join(grokHomeOf(home, grokHome), "auth.json"),
  join(codexHomeOf(home, codexHome), "auth.json"),
];
```

`clearOfficialCache` 完整改为：

```ts
export function clearOfficialCache(): void {
  claudeCache.clear();
  grokCache.clear();
  codexCache.clear();
}
```

不得把 token 放入 cache key、响应或异常文本。

验收绿灯：server 测试全绿，200 时得到 Fable 24%，429 时仍有桌面 5h/7d 且没有 Fable 假百分比。

## 5. TDD Step 3：领域/UI 只消费官方 Fable

提交：`fix(quota): remove estimated Fable percentage`

### 5.1 先改失败测试

用以下完整内容替换 `src/lib/quota/model-week-limit.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelWeekLimitFor } from "./engine.ts";
import type { OfficialSlice } from "./official.ts";
import { planById } from "./plans.ts";

const now = Date.parse("2026-08-20T12:00:00Z");
const fableResetsAt = now + 5 * 24 * 60 * 60 * 1000;

const official: OfficialSlice = {
  agent: "claude",
  windowPct: 10,
  weekPct: 20,
  windowResetsAt: now + 60_000,
  weekResetsAt: fableResetsAt,
  weekStartedAt: now - 2 * 24 * 60 * 60 * 1000,
  windowDurationMs: 5 * 60 * 60 * 1000,
  weekDurationMs: 7 * 24 * 60 * 60 * 1000,
  burnPctPerHour: 0,
  planLabel: "max",
  products: [],
  prepaidBalance: null,
  onDemandUsed: null,
  onDemandCap: null,
  modelWeekLimits: { fable: { usedPct: 24, resetsAt: fableResetsAt } },
  source: "oauth-usage",
  fetchedAt: now,
  windowKind: "five_hour",
};

test("Claude Max plans expose a 50% Fable weekly sub-limit", () => {
  assert.equal(planById("claude-max-5x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-max-20x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-pro").modelWeekLimitPct?.fable, undefined);
  assert.equal(planById("claude-api").modelWeekLimitPct?.fable, undefined);
});

test("Fable weekly limit uses the official percent instead of local tokens", () => {
  assert.deepEqual(modelWeekLimitFor(planById("claude-max-5x"), official, "fable"), {
    model: "fable",
    limitPctOfWeek: 50,
    usedPct: 24,
    resetsAt: fableResetsAt,
  });
});

test("Fable weekly limit is hidden when official data is unavailable", () => {
  assert.equal(modelWeekLimitFor(planById("claude-max-20x"), null, "fable"), null);
  const withoutFable = structuredClone(official);
  withoutFable.modelWeekLimits = undefined;
  assert.equal(modelWeekLimitFor(planById("claude-max-20x"), withoutFable, "fable"), null);
});

test("plans without a Fable sub-limit ignore an official Fable value", () => {
  assert.equal(modelWeekLimitFor(planById("claude-pro"), official, "fable"), null);
});
```

执行：

```bash
node --test --experimental-strip-types src/lib/quota/model-week-limit.test.ts
```

验收红灯：旧六参数函数仍返回 token 估算结构。

### 5.2 实现完整领域函数与 UI 修改

把 `ModelWeekLimitSnapshot` 完整改为：

```ts
export interface ModelWeekLimitSnapshot {
  model: ModelId;
  limitPctOfWeek: number;
  usedPct: number;
  resetsAt: number | null;
}
```

移除 `engine.ts` 对 `eventsInWindow`、`windowBounds` 的 import，并用以下完整函数替换旧 `modelWeekLimitFor`：

```ts
export function modelWeekLimitFor(
  plan: PlanDef,
  official: OfficialSlice | null | undefined,
  model: ModelId,
): ModelWeekLimitSnapshot | null {
  const limitPctOfWeek = plan.modelWeekLimitPct?.[model];
  const observed = official?.modelWeekLimits?.[model];
  if (limitPctOfWeek == null || limitPctOfWeek <= 0 || !observed) return null;
  return {
    model,
    limitPctOfWeek,
    usedPct: Math.max(0, Math.min(100, observed.usedPct)),
    resetsAt: observed.resetsAt,
  };
}
```

`dashboard.tsx` 的两个调用都改为：

```ts
modelWeekLimitFor(planById(state.claudePlanId), state.official.claude, "fable")
```

```ts
modelWeekLimitFor(claudePlan, official.claude, "fable")
```

Fable 加入 `primaryLimits` 时的 `resetsAt` 改为：

```ts
resetsAt: claudeFableLimit.resetsAt ?? claudeMeter.weekResetsAt,
```

`agent-card.tsx` 把标签和说明改为：

```tsx
<MeterBar
  value={modelWeekLimit.usedPct}
  tone={
    modelWeekLimit.usedPct >= 88
      ? "crit"
      : modelWeekLimit.usedPct >= 72
        ? "warn"
        : tone
  }
  label="Fable 5 周额度（官方）"
/>
<p className="text-xs leading-relaxed text-faint">
  {`Claude Max 的 Fable 5 套餐上限为总周额度的 ${modelWeekLimit.limitPctOfWeek}%；当前利用率来自 Claude Code。`}
</p>
```

`dashboard.tsx` 的 Claude `quotaNote` 改为：

```tsx
quotaNote={
  official.claude
    ? claudeFableLimit
      ? "官方 5h / 7d / Fable 利用率"
      : "官方 5h / 7d 利用率"
    : undefined
}
```

`plugin-panel.tsx` 的 Claude detail 改为：

```ts
detail: "会话 token 读 jsonl；5h / 7d 读桌面历史，Fable 周额度优先读 Claude OAuth usage。",
```

README 功能列表中的 Claude 项完整替换为：

```md
- 获取 Claude 5h/7d 官方利用率，并通过 Claude OAuth usage 读取 Claude Max 的 Fable 5 官方周子额度；OAuth 不可用时只保留桌面 5h/7d 后备。同时读取 Grok 共享周池和 Codex 官方订阅百分比。
```

README 数据来源表中的 Claude 行完整替换为：

```md
| Claude | `~/.claude/projects/**/*.jsonl`、`~/.config/claude/projects/**/*.jsonl` | Claude OAuth `/api/oauth/usage`（含 Fable）；macOS Claude Desktop `plan-usage-history.json` 后备 5h/7d |
```

验收绿灯：模型限额测试全绿；24% 输入输出 24%，无官方数据输出 `null`，不存在 140% Fable 假值。

## 6. 全量验证与真实运行 Gate

不产生功能提交；若验证发现问题，回到对应 step 新增失败测试后修复并提交。

按顺序执行并把 exit code 写入 `/tmp`：

```bash
npm test; echo "EXIT:$?" > /tmp/synq-fable-test-exit; echo "===DRAIN-SENTINEL==="
npm run typecheck; echo "EXIT:$?" > /tmp/synq-fable-typecheck-exit; echo "===DRAIN-SENTINEL==="
npm run build; echo "EXIT:$?" > /tmp/synq-fable-build-exit; echo "===DRAIN-SENTINEL==="
```

真实数据验证：

1. 启动实际 Synq 服务并确认首页 HTTP 200。
2. 直接运行服务端 `readOfficialQuota()`，确认 token、账户标识不会出现在输出；若接口成功，`modelWeekLimits.fable.usedPct` 必须等于 Claude Code UI 同期值；若当前命中 429/无 OAuth token，确认返回 Claude 5h/7d 且没有 Fable 字段。
3. 用 24% 的真实响应形状通过运行中 server 路径验证最终 snapshot 为 24，不是 48、100 或 140。
4. 浏览器可用时打开实际页面，确认标签为“Fable 5 周额度（官方）”、数值正确且 console 无错；浏览器不可用时明确记录该环境限制，不以单测冒充 UI 验收。
5. `git show --stat HEAD`、`git log --oneline -4` 和 `/tmp/*-exit` 同时核验提交及真实 exit code。

## 7. Plan 自检

- Spec coverage：官方 payload、OAuth 读取、401/429 后备、60 分钟成功缓存、领域消费、UI 文案、README 与真实运行均有对应 step。
- Placeholder scan：代码块无占位内容、无伪代码；每个新增函数和测试均给出完整实现。
- Type consistency：沿用已核对的 `OfficialSlice`、`readOfficialQuota`、`fetchImpl`、`PlanDef` 与 `ModelWeekLimitSnapshot`；唯一签名变更在 Step 3 同步覆盖全部调用点。
- Step size：三步分别是纯解析、服务端 I/O、领域/UI 消费，每步可独立红绿验证并单独提交。
