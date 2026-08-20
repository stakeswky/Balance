# 首次引导、Agent 检测与演示开关实施计划

日期：2026-08-20
状态：待执行
目标分支：`feat/onboarding-agent-availability`

## 1. 产品规则

1. 首次进入时先检测本机可监控数据目录：Claude 为 `~/.claude` 或 `~/.config/claude`，Grok 为 `$GROK_HOME` 或 `~/.grok`，Codex 为 `$CODEX_HOME` 或 `~/.codex`。
2. 检测结果只返回三个布尔值，不把 home、root、token 或账号信息发送到浏览器。
3. 正式模式显示“检测到的 Agent + 已手动导入过事件的 Agent”；未检测且无导入数据的 Agent 不进入卡片、时间线、金额、建议、报告、套餐、采集设置、事件流或会话详情。
4. 演示模式刻意显示全部三种 synthetic Agent；设置页用显式开关进入/退出演示。
5. Store 把 `realEvents` 与当前展示用的 `events` 分层：真实扫描与手动导入始终写入 `realEvents`；演示只替换 `events`。关闭演示时从 `realEvents` 原样恢复，不丢手动导入，且保留 `quotaSamples`、套餐、阈值和真实官方快照。
6. 首次未检测到任何 Agent 也不能卡死：引导页允许重新检测、进入空工作台或查看演示。
7. 每次打开应用都重新检测一次；只有引导页是首次显示，检测后的隐藏规则始终更新。

## 2. 已核对的真实签名

- Store：`useQuota` 位于 `src/lib/quota/store.ts`，Zustand persist key 为 `synq-quota-v8`，可用 `useQuota.persist.hasHydrated()` 与 `onFinishHydration()`。
- Server functions：`src/lib/quota/watch.ts` 使用 `createServerFn({ method: "GET" | "POST" })` 与 `.validator()`。
- Claude 扫描：`scanClaudeUsage(since, opts?: { home?: string; now?: number; state?: ScanState }): ClaudeScanResult`。
- Grok 扫描：`scanGrokUsage(since, opts?: { home?: string; grokHome?: string; now?: number; state?: GrokScanState }): GrokScanResult`。
- Codex 扫描：`scanCodexUsage(since, opts?: { home?: string; codexHome?: string; now?: number; state?: CodexScanState }): CodexScanResult`。
- 根路由：`src/routes/index.tsx` 在 client-ready 后直接渲染 `<Dashboard />`，是 hydration、检测和首次引导 gate 的接入点。
- UI 继续复用现有 `Button`、`Card`、`Badge` 和 Tailwind token；开关使用已安装的 `@radix-ui/react-switch`。

## 3. Step 1：Agent 数据目录检测

### 红测

新增 `src/lib/quota/agent-availability.server.test.ts`，完整覆盖：

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectAgentAvailability } from "./agent-availability.server.ts";

test("detectAgentAvailability returns false when no monitorable home exists", (t) => {
  const home = mkdtempSync(join(tmpdir(), "synq-presence-empty-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(
    detectAgentAvailability({
      home,
      grokHome: join(home, "missing-grok"),
      codexHome: join(home, "missing-codex"),
    }),
    { claude: false, grok: false, codex: false },
  );
});

test("detectAgentAvailability recognizes Claude primary and config homes", (t) => {
  const primary = mkdtempSync(join(tmpdir(), "synq-presence-claude-primary-"));
  const config = mkdtempSync(join(tmpdir(), "synq-presence-claude-config-"));
  t.after(() => rmSync(primary, { recursive: true, force: true }));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  mkdirSync(join(primary, ".claude"));
  mkdirSync(join(config, ".config", "claude"), { recursive: true });
  assert.equal(detectAgentAvailability({ home: primary }).claude, true);
  assert.equal(detectAgentAvailability({ home: config }).claude, true);
});

test("GROK_HOME and CODEX_HOME overrides are authoritative", (t) => {
  const home = mkdtempSync(join(tmpdir(), "synq-presence-overrides-"));
  const grokHome = join(home, "grok-data");
  const codexHome = join(home, "codex-data");
  mkdirSync(grokHome);
  mkdirSync(codexHome);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const found = detectAgentAvailability({ home, grokHome, codexHome });
  assert.deepEqual(found, { claude: false, grok: true, codex: true });
  const missing = detectAgentAvailability({
    home,
    grokHome: join(home, "missing-grok"),
    codexHome: join(home, "missing-codex"),
  });
  assert.deepEqual(missing, { claude: false, grok: false, codex: false });
});

test("a symlink to a directory counts as an available Agent home", (t) => {
  const home = mkdtempSync(join(tmpdir(), "synq-presence-symlink-"));
  const target = join(home, "codex-target");
  const link = join(home, "codex-link");
  mkdirSync(target);
  symlinkSync(target, link, "dir");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(detectAgentAvailability({ home, codexHome: link }).codex, true);
});
```

先运行：

```bash
node --test --experimental-strip-types src/lib/quota/agent-availability.server.test.ts
```

预期因模块不存在失败。

### 实现

新增 `src/lib/quota/agent-availability.ts`：

```ts
import type { AgentId, UsageEvent } from "./types";

export const AGENT_IDS = ["claude", "grok", "codex"] as const satisfies readonly AgentId[];

export type AgentAvailability = Record<AgentId, boolean>;

export const EMPTY_AGENT_AVAILABILITY: AgentAvailability = {
  claude: false,
  grok: false,
  codex: false,
};

export const ALL_AGENT_AVAILABILITY: AgentAvailability = {
  claude: true,
  grok: true,
  codex: true,
};

export function detectedAgentIds(availability: AgentAvailability): AgentId[] {
  return AGENT_IDS.filter((agent) => availability[agent]);
}

export function visibleAgentIds(
  availability: AgentAvailability,
  demoMode: boolean,
  events: readonly UsageEvent[],
): AgentId[] {
  if (demoMode) return [...AGENT_IDS];
  return AGENT_IDS.filter(
    (agent) => availability[agent] || events.some((event) => event.agent === agent),
  );
}

export function eventsForAgents(
  events: readonly UsageEvent[],
  agents: readonly AgentId[],
): UsageEvent[] {
  const allowed = new Set(agents);
  return events.filter((event) => allowed.has(event.agent));
}
```

新增 `src/lib/quota/agent-availability.server.ts`：

```ts
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAvailability } from "./agent-availability";

export interface AgentDetectionOptions {
  home?: string;
  grokHome?: string;
  codexHome?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function detectAgentAvailability(
  options: AgentDetectionOptions = {},
): AgentAvailability {
  const home = options.home ?? homedir();
  const grokHome = options.grokHome || process.env.GROK_HOME || join(home, ".grok");
  const codexHome = options.codexHome || process.env.CODEX_HOME || join(home, ".codex");
  return {
    claude: isDirectory(join(home, ".claude")) || isDirectory(join(home, ".config", "claude")),
    grok: isDirectory(grokHome),
    codex: isDirectory(codexHome),
  };
}
```

在 `src/lib/quota/watch.ts` 增加：

```ts
import { detectAgentAvailability } from "./agent-availability.server";

export const pullAgentAvailability = createServerFn({ method: "GET" }).handler(() => {
  return detectAgentAvailability();
});
```

验收：4 项检测测试通过；`npm run typecheck` 通过。

建议 commit：`feat: detect local agent availability`

## 4. Step 2：统一可见性与演示状态机

### 红测

新增 `src/lib/quota/agent-availability.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsForAgents, visibleAgentIds } from "./agent-availability.ts";
import type { UsageEvent } from "./types.ts";

function event(agent: UsageEvent["agent"]): UsageEvent {
  return {
    id: `event-${agent}`,
    agent,
    model: agent === "claude" ? "opus" : agent === "grok" ? "grok-4.6" : "gpt-5.6-sol",
    ts: 1,
    sessionId: `session-${agent}`,
    task: `task-${agent}`,
    tokensIn: 1,
    tokensOut: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
  };
}

test("real mode shows only detected agents", () => {
  assert.deepEqual(
    visibleAgentIds({ claude: true, grok: false, codex: true }, false, []),
    ["claude", "codex"],
  );
});

test("manual data makes an undetected agent visible", () => {
  assert.deepEqual(
    visibleAgentIds({ claude: false, grok: false, codex: false }, false, [event("grok")]),
    ["grok"],
  );
});

test("demo mode always shows all three agents", () => {
  assert.deepEqual(
    visibleAgentIds({ claude: false, grok: false, codex: false }, true, []),
    ["claude", "grok", "codex"],
  );
});

test("eventsForAgents removes unavailable agent data from summaries", () => {
  assert.deepEqual(
    eventsForAgents([event("claude"), event("grok"), event("codex")], ["claude"]),
    [event("claude")],
  );
});
```

在 `src/lib/quota/store.test.ts` 增加状态机测试：

```ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { useQuota } from "./store.ts";

let snapshot: ReturnType<typeof useQuota.getState>;

beforeEach(() => {
  snapshot = useQuota.getState();
  useQuota.setState({
    agentAvailability: { claude: true, grok: false, codex: true },
    captureEnabled: { claude: true, grok: true, codex: false },
    realEvents: [{
      id: "real-claude",
      agent: "claude",
      model: "sonnet",
      ts: 1,
      sessionId: "real-session",
      task: "真实导入",
      tokensIn: 1,
      tokensOut: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningMin: 0,
    }],
    quotaSamples: [{
      windowId: "sample-window",
      agent: "claude",
      product: null,
      timestampMs: 1,
      usedPercent: 10,
      cumulativeObservedUsd: 1,
      pricedTokenCoverage: 1,
      modelMix: {},
      pricingVersion: "test",
    }],
  });
});

afterEach(() => {
  useQuota.setState(snapshot, true);
});

test("demo can be enabled and disabled without losing calibration samples", () => {
  useQuota.getState().setDemoMode(true);
  assert.equal(useQuota.getState().demoMode, true);
  assert.ok(useQuota.getState().events.some((item) => item.agent === "claude"));
  assert.ok(useQuota.getState().events.some((item) => item.agent === "grok"));
  assert.ok(useQuota.getState().events.some((item) => item.agent === "codex"));
  useQuota.getState().setDemoMode(false);
  const state = useQuota.getState();
  assert.equal(state.demoMode, false);
  assert.deepEqual(state.events, state.realEvents);
  assert.equal(state.events[0]?.id, "real-claude");
  assert.equal(state.liveClaude, true);
  assert.equal(state.liveGrok, false);
  assert.equal(state.liveCodex, false);
  assert.equal(state.quotaSamples.length, 1);
});

test("availability disables missing real collectors but demo keeps all streams", () => {
  useQuota.getState().setAgentAvailability({ claude: false, grok: true, codex: false });
  assert.equal(useQuota.getState().liveClaude, false);
  assert.equal(useQuota.getState().liveGrok, true);
  assert.equal(useQuota.getState().liveCodex, false);
  useQuota.getState().setDemoMode(true);
  assert.equal(useQuota.getState().liveClaude, true);
  assert.equal(useQuota.getState().liveGrok, true);
  assert.equal(useQuota.getState().liveCodex, true);
});
```

### 实现

`QuotaState` 新增：

```ts
realEvents: UsageEvent[];
agentAvailability: AgentAvailability;
captureEnabled: AgentAvailability;
onboardingComplete: boolean;
setAgentAvailability: (availability: AgentAvailability) => void;
setOnboardingComplete: (complete: boolean) => void;
setDemoMode: (on: boolean) => void;
```

初始状态改为正式空数据：

```ts
events: [],
realEvents: [],
liveClaude: false,
liveGrok: false,
liveCodex: false,
demoMode: false,
agentAvailability: { ...EMPTY_AGENT_AVAILABILITY },
captureEnabled: { ...ALL_AGENT_AVAILABILITY },
onboardingComplete: false,
claudeSession: null,
grokSession: null,
codexSession: null,
```

`setAgentAvailability` 的完整状态规则：

```ts
setAgentAvailability: (agentAvailability) => {
  const state = get();
  set({
    agentAvailability,
    liveClaude: state.demoMode
      ? state.liveClaude
      : agentAvailability.claude && state.captureEnabled.claude,
    liveGrok: state.demoMode
      ? state.liveGrok
      : agentAvailability.grok && state.captureEnabled.grok,
    liveCodex: state.demoMode
      ? state.liveCodex
      : agentAvailability.codex && state.captureEnabled.codex,
  });
},
setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
```

`setDemoMode` 与 `resetDemo`：

```ts
setDemoMode: (on) => {
  if (on) {
    get().resetDemo();
    return;
  }
  const state = get();
  set({
    events: state.realEvents,
    demoMode: false,
    liveClaude: state.agentAvailability.claude && state.captureEnabled.claude,
    liveGrok: state.agentAvailability.grok && state.captureEnabled.grok,
    liveCodex: state.agentAvailability.codex && state.captureEnabled.codex,
    claudeCursor: 0,
    grokCursor: 0,
    codexCursor: 0,
    claudeHydrated: false,
    grokHydrated: false,
    codexHydrated: false,
    claudeWriting: false,
    grokWriting: false,
    codexWriting: false,
    claudeSession: null,
    grokSession: null,
    codexSession: null,
    lastBeat: Date.now(),
  });
},
resetDemo: () => {
  const now = Date.now();
  set({
    events: seedHistory(now),
    ...startTrio(now),
    lastBeat: now,
    liveClaude: true,
    liveGrok: true,
    liveCodex: true,
    demoMode: true,
    claudeCursor: 0,
    grokCursor: 0,
    codexCursor: 0,
    claudeHydrated: true,
    grokHydrated: true,
    codexHydrated: true,
    claudeWriting: false,
    grokWriting: false,
    codexWriting: false,
  });
},
```

所有真实事件写入路径保持分层：

```ts
// importText / loadImported / ingestClaudeLogs / ingestGrokLogs / ingestCodexLogs
// 先由现有去重逻辑计算 nextRealEvents，然后统一提交：
set({
  realEvents: nextRealEvents,
  events: get().demoMode ? get().events : nextRealEvents,
});
```

三种 `ingest*Logs({ replace: true })` 只替换 `realEvents` 内对应 Agent 的片段，不触碰其他 Agent 或当前 demo seed；`recordOfficialSamples` 使用 `realEvents`，绝不拿 synthetic event 校准真实样本。`realEvents` 与 `events` 都不进入 persist，延续现有“大事件不写 localStorage”的约束；同一浏览器会话内开关演示可无损恢复，刷新后由本机日志重新扫描。

正式模式下 `toggleLive()` 同时更新对应 `captureEnabled`，不再隐式退出 demo；`setBothLive()` 在正式模式只启用 availability 为 true 的采集器，在 demo 模式控制三路 synthetic stream。`partialize` 增加 `agentAvailability`、`captureEnabled`、`onboardingComplete`。

删除 Dashboard 的 `seedIfEmpty()` hydration 回填；内置匿名 Claude JSON 只保留给插件页的显式“载入 Claude 导出”。`loadImported()` 只写 Claude 的 `realEvents`，不得再把 Grok/Codex 的采集状态强制设为 true。

验收：availability 4 项 + store 2 项测试通过；现有 154 项不回归；`npm run typecheck` 通过。

建议 commit：`feat: add persisted demo and onboarding state`

## 5. Step 3：首次进入引导页面与设置开关

### 红测

新增 `src/lib/quota/onboarding.test.ts`，把页面状态判定抽成纯函数：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { onboardingState } from "./onboarding.ts";

test("onboarding reports checking before detection finishes", () => {
  assert.equal(
    onboardingState({ claude: false, grok: false, codex: false }, true, null),
    "checking",
  );
});

test("onboarding distinguishes ready, empty, and error states", () => {
  assert.equal(onboardingState({ claude: true, grok: false, codex: false }, false, null), "ready");
  assert.equal(onboardingState({ claude: false, grok: false, codex: false }, false, null), "empty");
  assert.equal(
    onboardingState({ claude: false, grok: false, codex: false }, false, "检测失败"),
    "error",
  );
});
```

### 实现

新增 `src/lib/quota/onboarding.ts`：

```ts
import { detectedAgentIds, type AgentAvailability } from "./agent-availability";

export type OnboardingState = "checking" | "ready" | "empty" | "error";

export function onboardingState(
  availability: AgentAvailability,
  checking: boolean,
  error: string | null,
): OnboardingState {
  if (checking) return "checking";
  if (error) return "error";
  return detectedAgentIds(availability).length ? "ready" : "empty";
}
```

新增 shadcn/Radix 风格 `src/components/ui/switch.tsx`：

```tsx
import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-raised p-1 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 data-[state=checked]:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-full bg-mute transition-transform duration-150 data-[state=checked]:translate-x-5 data-[state=checked]:bg-accent-fg" />
    </SwitchPrimitive.Root>
  );
}
```

新增 `src/components/synq/onboarding.tsx`，完整交互契约：

```tsx
import { ArrowRight, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AGENT_LABEL, agentTextClass } from "@/lib/quota/agent";
import { AGENT_IDS, detectedAgentIds, type AgentAvailability } from "@/lib/quota/agent-availability";
import { onboardingState } from "@/lib/quota/onboarding";
import { cn } from "@/lib/utils";

const ADAPTER: Record<(typeof AGENT_IDS)[number], string> = {
  claude: "~/.claude 或 ~/.config/claude",
  grok: "$GROK_HOME 或 ~/.grok",
  codex: "$CODEX_HOME 或 ~/.codex",
};

export function Onboarding({
  availability,
  checking,
  error,
  onRetry,
  onContinue,
  onDemo,
}: {
  availability: AgentAvailability;
  checking: boolean;
  error: string | null;
  onRetry: () => void;
  onContinue: () => void;
  onDemo: () => void;
}) {
  const state = onboardingState(availability, checking, error);
  const detected = detectedAgentIds(availability);
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10 text-ink sm:px-6">
      <div className="w-full max-w-xl">
        <p className="text-sm font-medium text-mute">Synq 初始设置</p>
        <h1 className="mt-3 text-balance text-3xl font-medium tracking-tight sm:text-4xl">
          先连接这台机器上的 Agent
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-mute">
          Synq 只检查本机数据目录。未检测到的 Agent 不会出现在正式工作台，之后可在设置里重新检测。
        </p>

        <Card className="mt-8 p-2 sm:p-2">
          <div className="divide-y divide-line" aria-live="polite">
            {AGENT_IDS.map((agent) => {
              const found = availability[agent];
              return (
                <div key={agent} className="flex min-h-16 items-center gap-3 rounded-xl px-3 py-3 sm:px-4">
                  <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-raised", agentTextClass(agent))}>
                    {checking ? <LoaderCircle className="animate-spin" /> : found ? <Check /> : <X className="text-faint" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{AGENT_LABEL[agent]}</span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-mute">{ADAPTER[agent]}</span>
                  </span>
                  <span className={cn("text-xs", found ? "text-ok" : "text-faint")}>
                    {checking ? "检测中" : found ? "已找到" : "未检测到"}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="mt-6" aria-live="polite">
          {state === "ready" ? (
            <p className="text-sm text-mute">已找到 {detected.length} 个 Agent，可以开始只读监控。</p>
          ) : null}
          {state === "empty" ? (
            <p className="text-sm text-mute">暂未找到可监控目录。先运行一次 Agent，或直接查看演示。</p>
          ) : null}
          {state === "error" ? <p className="text-sm text-crit">{error}</p> : null}
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button onClick={onContinue} disabled={checking} className="sm:min-w-36">
            进入工作台
            <ArrowRight />
          </Button>
          <Button variant="secondary" onClick={onDemo} disabled={checking}>
            查看演示
          </Button>
          <Button variant="ghost" onClick={onRetry} disabled={checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} />
            重新检测
          </Button>
        </div>
      </div>
    </main>
  );
}
```

`src/routes/index.tsx` 使用完整的 `persistHydrated → availabilityChecking → availabilityResolved` gate；返回用户在检测结束前不渲染 stale workbench，首次用户则能看到引导页的检测中状态：

```tsx
import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/synq/dashboard";
import { Onboarding } from "@/components/synq/onboarding";
import { useQuota } from "@/lib/quota/store";
import { pullAgentAvailability } from "@/lib/quota/watch";

export const Route = createFileRoute("/")({ component: Home });

function LoadingShell() {
  return (
    <div className="min-h-dvh bg-canvas px-4 py-8 text-ink">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="h-16 rounded-xl bg-surface" />
        <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
          <div className="h-64 rounded-2xl bg-surface" />
          <div className="h-64 rounded-2xl bg-surface" />
        </div>
      </div>
    </div>
  );
}

function Home() {
  const onboardingComplete = useQuota((state) => state.onboardingComplete);
  const availability = useQuota((state) => state.agentAvailability);
  const [persistHydrated, setPersistHydrated] = useState(() => useQuota.persist.hasHydrated());
  const [availabilityChecking, setAvailabilityChecking] = useState(false);
  const [availabilityResolved, setAvailabilityResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setAvailabilityChecking(true);
    setError(null);
    try {
      const result = await pullAgentAvailability();
      useQuota.getState().setAgentAvailability(result);
    } catch {
      setError("无法检测本机 Agent，请稍后重试");
    } finally {
      setAvailabilityChecking(false);
      setAvailabilityResolved(true);
    }
  }, []);

  useEffect(() => {
    const afterHydration = () => {
      setPersistHydrated(true);
      if (useQuota.getState().demoMode) useQuota.getState().resetDemo();
      void detect();
    };
    if (useQuota.persist.hasHydrated()) {
      afterHydration();
      return;
    }
    return useQuota.persist.onFinishHydration(afterHydration);
  }, [detect]);

  if (!persistHydrated) return <LoadingShell />;
  if (!onboardingComplete) {
    return (
      <Onboarding
        availability={availability}
        checking={availabilityChecking || !availabilityResolved}
        error={error}
        onRetry={() => void detect()}
        onContinue={() => useQuota.getState().setOnboardingComplete(true)}
        onDemo={() => {
          useQuota.getState().setDemoMode(true);
          useQuota.getState().setOnboardingComplete(true);
        }}
      />
    );
  }
  if (!availabilityResolved) return <LoadingShell />;
  return <Dashboard />;
}
```

该状态机每次页面启动都触发一次服务端检测。检测失败时，首次用户留在带错误和重试按钮的引导页；返回用户在检测尝试结束后使用上次安全的布尔快照继续，不暴露路径。

`src/components/synq/settings-panel.tsx`：

- 引入 `Switch`、`pullAgentAvailability`、`demoMode`、`agentAvailability`。
- “演示数据”卡改为 `Switch checked={demoMode}`，`onCheckedChange={(on) => useQuota.getState().setDemoMode(on)}`；开启提示“已开启演示数据”，关闭提示“已恢复本机数据”。
- 保留仅在 `demoMode` 时出现的“重置今日演示”按钮。
- “本机监控”卡增加“重新检测”按钮，调用 `pullAgentAvailability()` 后 `setAgentAvailability(result)`。

验收：onboarding 2 项纯逻辑测试通过；全量测试与 typecheck 通过；首次渲染组件使用现有 token、无新 hex、按钮和开关触控高度不低于 44px。

建议 commit：`feat: add first-run onboarding and demo toggle`

## 6. Step 4A：建议算法改为可见 Agent 数组

### 红测

先扩展 `src/lib/quota/presentation.test.ts`：

```ts
test("routing advice never names unavailable agents", () => {
  const tips = routingAdvice([
    meter({ agent: "claude", windowPct: 20, weekPct: 20 }),
  ]);
  assert.ok(tips.length > 0);
  assert.ok(tips.every((tip) => !tip.title.includes("Grok") && !tip.title.includes("Codex")));
  assert.ok(tips.every((tip) => !tip.body.includes("Grok") && !tip.body.includes("Codex")));
});

test("routing advice respects a weekly-only Codex limit", () => {
  const tips = routingAdvice([
    meter({ agent: "claude", windowPct: 20, weekPct: 20 }),
    meter({ agent: "grok", windowPct: 20, weekPct: 20 }),
    meter({ agent: "codex", windowPct: 12, weekPct: 80 }),
  ]);
  assert.ok(tips.some((tip) => tip.title.includes("Codex")));
});
```

旧三参数测试同时改成数组签名；先运行确认类型/断言失败。

### 实现

把 `routingAdvice` 改为：

```ts
export function routingAdvice(meters: readonly MeterSnapshot[]) {
  const tips: { title: string; body: string }[] = [];
  const byAgent = new Map(meters.map((meter) => [meter.agent, meter]));
  const load = (agent: AgentId) => {
    const meter = byAgent.get(agent);
    return meter ? Math.max(meter.windowPct, meter.weekPct) : null;
  };
  const claude = byAgent.get("claude");
  const claudeLoad = load("claude");
  const grokLoad = load("grok");
  const codexLoad = load("codex");

  if (claude && claude.windowPct >= 68) {
    tips.push({
      title: "Claude 切到 Sonnet / Haiku",
      body: "窗口已过警戒。简单改文件用 Haiku 4.5，重重构再开 Opus 5。",
    });
  }
  if (grokLoad != null && grokLoad >= 68) {
    tips.push({
      title: "Grok 先歇一轮或换档",
      body: "Grok 窗已经紧。短修补继续用 4.6，长推理等周额度回补。",
    });
  }
  if (codexLoad != null && codexLoad >= 68) {
    tips.push({
      title: "Codex 降到 Terra / Luna",
      body: "周额度已经紧。短任务用 GPT-5.6 Luna，把 Sol 留给难的实现。",
    });
  }

  const strained = meters.some((meter) => Math.max(meter.windowPct, meter.weekPct) >= 70);
  const receiver = meters
    .filter((meter) => Math.max(meter.windowPct, meter.weekPct) < 40)
    .sort(
      (a, b) =>
        Math.max(a.windowPct, a.weekPct) - Math.max(b.windowPct, b.weekPct),
    )[0];
  if (strained && receiver) {
    const name = receiver.agent === "claude" ? "Claude" : receiver.agent === "grok" ? "Grok" : "Codex";
    tips.push({
      title: `把重活交给 ${name}`,
      body: `${name} 当前窗口更宽裕，下一趟长任务优先走这一路。`,
    });
  }
  if (!tips.length && meters.length) {
    tips.push({
      title: meters.length === 1 ? "当前 Agent 节奏正常" : `${meters.length} 路节奏正常`,
      body: "可见 Agent 的窗口都还宽裕，保持当前模型组合即可。",
    });
  }
  return tips.slice(0, 3);
}
```

`AdviceCard` 的 props 改为 `meters: readonly MeterSnapshot[]`，内部只调用 `routingAdvice(meters)`；0 路时由 Dashboard 不渲染。先只完成算法与 AdviceCard callsite，运行 presentation test 与 typecheck 后再进入 4B。

验收：routing advice 新旧测试通过；任意 1/2/3 路输入都不在建议文案中提到不存在的 Agent。

建议 commit：`refactor: route advice across visible agents`

## 7. Step 4B：监控页、导航、时间线与图表过滤

组件签名的新增字段：

```ts
Header: { agents: readonly AgentId[] } + 现有 view/onView/live/watchText
DualTimeline: { agents: readonly AgentId[]; events: UsageEvent[]; now: number }
UsageChart: { agents: readonly AgentId[]; events: UsageEvent[]; now: number }
```

实现规则：

- `Dashboard` 用 `visibleAgentIds(agentAvailability, demoMode, realEvents)` 与 `eventsForAgents(events, visibleAgents)`；`primaryMeters`、订阅合计、API 等价金额、告警、watchText 都只遍历 visible agents；`tighter` 允许为 `null`。
- 0 个 visible agent 时监控页只显示一个 Card：标题“未发现可监控 Agent”，正文“在这台机器上先运行一次 Claude Code、Grok 或 Codex，然后到设置重新检测；也可以在设置开启演示数据。”，按钮“打开设置”。
- 三个 `AgentCard` 分别包在 `visibleAgents.includes(agent)` 条件中；grid 使用 `md:grid-cols-2 xl:grid-cols-3`，1/2/3 路都不留空列。
- `DualTimeline` 只 map `agents`；副标题使用 `${agents.length} 路 Agent 共享同一口 5 小时时钟`。
- `UsageChart` 只为 `agents.includes(id)` 的 dataKey 渲染 `<Area>`。
- `SessionDialog` 和 `EventFeed` 必须接收 `visibleEvents`，禁止继续传原始 `events`，避免已隐藏 Agent 通过会话详情或事件流出现。
- `Header` 副标题改为 `agents.length ? `${agents.length} 路 Agent 额度` : "本机 Agent 额度"`。
- 告警循环只检查 `visibleAgents`；不存在的 Agent 不生成 toast 或报告记录。

验收：monitor 页 0/1/2/3 路均无空列；timeline、chart、event feed、session dialog、顶部统计、告警都只消费可见数组；typecheck 通过。

建议 commit：`feat: filter monitor by available agents`

## 8. Step 4C：设置、套餐与插件过滤

组件 props 在保留现有全部字段基础上新增 `agents: readonly AgentId[]`：`PlansPanel` 与 `PluginPanel`；`SettingsPanel` 从 store 读取 availability，无新增 props。

实现规则：

- `PlansPanel` 只渲染 agents 包含的套餐列表；周额度加成只在包含 Claude 时出现，告警阈值保留一次。
- `SettingsPanel` 的日志采集只 map `detectedAgentIds(agentAvailability)`；无检测结果时显示重新检测提示。
- `PluginPanel` 的适配器和默认导入目标只 map `agents`；若 0 路，保留事件协议并显示去设置重新检测/开启演示的空态。
- Dashboard 首页“重置演示”按钮只在 `demoMode` 时显示；正式模式只能从设置开关进入演示。

验收：Settings、Plans、Plugin 的 Agent 入口仅来自 `agents`/`detectedAgentIds`；0 路仍能进入设置打开演示；typecheck 通过。

建议 commit：`feat: filter agent settings and imports`

## 9. Step 4D：报告过滤与跨表面回归

`ReportPanel` 在保留现有 props 的基础上新增 `agents: readonly AgentId[]`，用配置数组 map 可见的 PlanCompare 和模型占比；Dashboard 传入的 `events` 与 `alerts` 先按 visible agents 过滤。周 API 等价只累计可见 meters。

验收：`rg` 检查 Dashboard、Timeline、Report、Plans、Settings、Plugin、EventFeed、SessionDialog 不再无条件消费三路数据；全量 test/typecheck/build 通过。

建议 commit：`feat: filter reports by available agents`

## 10. Step 5：真实端到端验证

按 `verify-before-done` 执行，每个命令写 `/tmp` exit code 与 drain sentinel：

```bash
npm test
npm run typecheck
npm run build
```

真实浏览器路径：

1. 清除 `synq-quota-v8` localStorage，以全新 context 打开开发版。
2. 首屏必须是“Synq 初始设置”，检测完成后当前机器显示 Claude/Grok/Codex 都“已找到”。
3. 点击“进入工作台”，刷新后引导不再出现；三路真实卡片、时间线和设置采集项存在。
4. 设置打开“演示数据”，确认三路 synthetic 数据出现；刷新后仍为完整三路演示。
5. 设置关闭“演示数据”，确认 2.5 秒内回到真实日志且 `quotaSamples` 未被清空。
6. 用 production preview `npx nitro preview --host 127.0.0.1 --port 8081`，重复首次引导与开关路径；实际 `/assets/*` 必须 200 且 MIME 非 HTML。
7. 在 Playwright 中拦截首次实际发生的 `pullAgentAvailability` server-function 请求，并对独立 browser context 返回 `{ claude: true, grok: false, codex: false }`；该 context 先清理当前 origin 的 `synq-quota-v8`，完成引导后正文存在 Claude Code，且监控/设置/报告正文不出现 Grok 或 Codex。底层目录检测的 0/1/2/3 与 symlink 情况由 Step 1 的真实临时目录单测覆盖，因此浏览器层只验证 UI 消费合同，不改写系统 `HOME`。
8. 桌面 1280×900 与移动 390×844 均断言 `scrollWidth <= clientWidth`，`consoleErrors=[]`、`pageErrors=[]`、`requestFailures=[]`。

## 8. 四关自检

### Spec coverage

演示设置开关、首次引导、三 Agent 检测、缺失隐藏、0/1/2/3 Agent、刷新持久化、真实日志恢复与生产验证全部有对应步骤。

### Placeholder scan

新文件、测试、状态机、引导组件、检测函数与 generic advice 均给出完整实现，没有 TODO、伪代码或省略函数体。

### Type consistency

类型来自真实 `AgentId`、`UsageEvent`、`MeterSnapshot`、Zustand store 和 `createServerFn` API；检测结果只用 `Record<AgentId, boolean>`，不传 server-only path。

### Step size

Step 1 是检测单元，Step 2 是 store/visibility 单元，Step 3 是 onboarding/settings UI 单元，Step 4A 是纯建议算法，Step 4B 是监控表面，Step 4C 是设置/套餐/插件，Step 4D 是报告与跨表面回归，Step 5 是端到端验收；每步可独立红绿验证。
