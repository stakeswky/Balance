# Claude / Grok / Codex 并行任务采集计划

日期：2026-08-20
状态：已执行
范围：三家本机日志的乱序增量采集、Claude 子代理身份、并行活跃任务状态和工作台展示

## 1. 目标与非目标

目标：

1. Claude 子代理用量继续归属父计费 session，同时保留独立 `actorId`，在报告、时间线和会话详情中作为独立任务显示。
2. Claude 父进程等待子代理时，只要任一子代理日志仍在写，Synq 就显示正在运行。
3. Claude、Grok、Codex 并行文件乱序落盘时，已由逐文件 cursor 读到的新事件不再被全局 `since` 永久丢弃。
4. 三家都返回完整的 `active` 任务数组；同一 Codex session 的多个 rollout 文件只显示一个活跃任务。
5. 工作台紧凑显示并行任务数和最多四条活跃任务，不改变现有卡片视觉语言。
6. Claude 的 `<system-reminder>` 不再覆盖真实子代理任务名；workflow 子代理优先使用 `workflows/wf_*.json` 的 `workflowProgress[].label`。

非目标：

- `~/.claude/tasks/*.json` 不含 usage/session join，不参与 token 计费。
- 本次不解析 Claude workflow 总 token 汇总，避免与 assistant usage 双重计数。
- 不改变官方额度、API 等价价格或配额窗口算法。

## 2. Explore 核对结果

- Claude `subagents/**/agent-*.jsonl` 的 `sessionId` 是父计费 session，`agentId` 才是执行 actor；workflow 子代理另带 `attributionAgent: "workflow-subagent"`。真实 `workflows/wf_*.json` 中 `workflowProgress[]` 的 `workflow_agent` 行提供稳定的 `agentId + label`，应优先于子代理首条长 prompt。
- Claude scanner 会递归读子代理 `.jsonl`，但 live 判定在 `isParentJsonl()` 处显式排除 `subagents/`。
- Claude `state.meta` 当前按 basename 存；应改为按完整 path 存，避免跨父会话或 `journal.jsonl` 冲突。
- Grok 每个并行会话有独立 `sessions/**/<session>/updates.jsonl`，当前 live 只选最近一个文件。
- Codex 并行任务有不同 session id，同一 session 也可能跨多个 rollout 文件；当前 live 只选最近一个文件。
- 三家 scanner 都先推进逐文件 byte cursor，再执行 `e.ts >= since` 的全局过滤；新文件或迟到事件一旦被过滤就不会重读。
- 当前 `UsageEvent`、`SessionState`、报告、时间线和弹窗都只按 `sessionId` 聚合，无法表达 Claude 的父计费 session 与子 actor。

统一语义：

- `sessionId`：供应商原始计费/根会话 ID。
- `actorId`：可选执行 actor；Claude 子代理使用 `agent-<id>`，根任务、Grok、Codex 默认没有该字段。
- `activityIdOf(event)`：`actorId ?? sessionId`，只用于任务/UI 聚合，不参与配额计费。
- `active`：最近 20 秒仍在写入的去重任务数组；`live` 保留最近一个任务以兼容现有卡片会话摘要。

## 3. Step 1：三家 scanner 不漏乱序事件并返回并行活动

### 3.1 RED 测试

在三个 scanner 测试中把新增事件时间设为早于全局 `since`，但保证它是逐文件 cursor 之后追加的新行：

```ts
test("Claude per-file cursor keeps a late parallel event older than global since", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-claude-late-"));
  const dir = join(home, ".claude", "projects", "-demo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "root-session.jsonl");
  writeFileSync(file, `${assistant({ requestId: "req-new", timestamp: "2026-08-19T15:12:29.612Z" })}\n`);
  const state = createScanState();
  const first = scanClaudeUsage(0, { home, now: Date.parse("2026-08-19T16:00:00Z"), state });
  appendFileSync(file, `${assistant({ requestId: "req-late", timestamp: "2026-08-19T15:12:00.000Z" })}\n`);
  const second = scanClaudeUsage(first.events[0]!.ts + 1, {
    home,
    now: Date.parse("2026-08-19T16:00:01Z"),
    state,
  });
  assert.deepEqual(second.events.map((event) => event.id), ["req-late"]);
});

test("Grok per-file cursor keeps a late parallel turn older than global since", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-grok-late-"));
  const grokHome = join(home, ".grok");
  const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/demo"), "sess-g");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ generated_title: "并行 Grok", info: { cwd: "/tmp/demo" } }));
  const file = join(dir, "updates.jsonl");
  writeFileSync(file, `${turn({})}\n`);
  const state = createGrokScanState();
  const first = scanGrokUsage(0, { grokHome, now: 1_787_153_667_911, state });
  const late = turn({
    params: {
      sessionId: "sess-g",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-late",
        usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
      },
      _meta: { agentTimestampMs: 1_787_153_600_000 },
    },
  });
  appendFileSync(file, `${late}\n`);
  const second = scanGrokUsage(first.events[0]!.ts + 1, { grokHome, now: 1_787_153_668_000, state });
  assert.deepEqual(second.events.map((event) => event.id), ["prompt-late"]);
});

test("Codex per-file cursor keeps a late parallel event older than global since", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-codex-late-"));
  const codexHome = join(home, ".codex");
  const dir = join(codexHome, "sessions", "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-08-20T09-00-26-01a01caf-0009-78b1-a9fe-152648fe32d4.jsonl");
  writeFileSync(file, `${tokenCount()}\n`);
  const state = createCodexScanState();
  const now = Date.parse("2026-08-20T01:10:00Z");
  const first = scanCodexUsage(0, { codexHome, now, state });
  appendFileSync(file, `${tokenCount({ timestamp: "2026-08-20T01:00:00.000Z" })}\n`);
  const second = scanCodexUsage(first.events[0]!.ts + 1, { codexHome, now, state });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.ts, Date.parse("2026-08-20T01:00:00.000Z"));
});
```

在 `src/lib/quota/claude-jsonl.test.ts` 增加真实父子身份和活动测试：

```ts
test("Claude keeps billing session and subagent actor identities separate", () => {
  const meta = {
    sessionId: "agent-a1",
    cwd: "",
    title: "",
    lastUser: "",
    actorId: "agent-a1",
    actorKind: "subagent" as const,
  };
  parseJsonlLine(
    JSON.stringify({
      type: "user",
      sessionId: "parent-session",
      agentId: "a1",
      isSidechain: true,
      message: { role: "user", content: "检查并修复支付回归" },
    }),
    meta,
  );
  parseJsonlLine(
    JSON.stringify({
      type: "user",
      sessionId: "parent-session",
      agentId: "a1",
      message: { role: "user", content: "<system-reminder>Other agents active</system-reminder>" },
    }),
    meta,
  );
  const event = parseJsonlLine(
    assistant({ sessionId: "parent-session", agentId: "a1", requestId: "req-child" }),
    meta,
  );
  assert.ok(event);
  assert.equal(event.sessionId, "parent-session");
  assert.equal(event.actorId, "agent-a1");
  assert.equal(event.actorKind, "subagent");
  assert.equal(event.task, "检查并修复支付回归");
});

test("Claude reports concurrently writing subagents as active", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-claude-active-"));
  const root = join(home, ".claude", "projects", "-demo", "parent-session");
  const subagents = join(root, "subagents");
  mkdirSync(subagents, { recursive: true });
  const now = Date.parse("2026-08-20T11:00:00Z");
  for (const actor of ["a1", "a2"]) {
    const file = join(subagents, `agent-${actor}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", sessionId: "parent-session", agentId: actor, message: { content: `任务 ${actor}` } })}\n${assistant({ sessionId: "parent-session", agentId: actor, requestId: `req-${actor}`, timestamp: "2026-08-20T10:59:59Z" })}\n`,
    );
    utimesSync(file, new Date(now - 1_000), new Date(now - 1_000));
  }
  const result = scanClaudeUsage(0, { home, now, state: createScanState() });
  assert.equal(result.active.length, 2);
  assert.deepEqual(result.active.map((task) => task.actorId).sort(), ["agent-a1", "agent-a2"]);
  assert.equal(result.live?.writing, true);
  assert.equal(new Set(result.events.map((event) => event.actorId)).size, 2);
});

test("Claude workflow subagent prefers the workflow label over its long prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-claude-workflow-"));
  const session = join(home, ".claude", "projects", "-demo", "parent-session");
  const workflowDir = join(session, "workflows");
  const logDir = join(session, "subagents", "workflows", "wf_demo");
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(workflowDir, "wf_demo.json"),
    JSON.stringify({
      workflowProgress: [
        { type: "workflow_agent", agentId: "ab45c5", label: "M0-3-ws-origin" },
      ],
    }),
  );
  const now = Date.parse("2026-08-20T11:00:00Z");
  const log = join(logDir, "agent-ab45c5.jsonl");
  writeFileSync(
    log,
    `${JSON.stringify({ type: "user", sessionId: "parent-session", agentId: "ab45c5", isSidechain: true, message: { content: "这是不应成为标题的完整长任务 prompt" } })}\n${assistant({ sessionId: "parent-session", agentId: "ab45c5", attributionAgent: "workflow-subagent", requestId: "req-workflow", timestamp: "2026-08-20T10:59:59Z" })}\n`,
  );
  utimesSync(log, new Date(now - 1_000), new Date(now - 1_000));
  const result = scanClaudeUsage(0, { home, now, state: createScanState() });
  assert.equal(result.events[0]?.task, "M0-3-ws-origin");
  assert.equal(result.events[0]?.actorKind, "workflow-subagent");
  assert.equal(result.active[0]?.task, "M0-3-ws-origin");
});
```

在 `src/lib/quota/grok-jsonl.test.ts` 添加完整并行活动测试：

```ts
test("Grok reports two concurrently writing sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-grok-active-"));
  const grokHome = join(home, ".grok");
  const now = 1_787_153_700_000;
  for (const [sessionId, offset] of [["sess-a", 1_000], ["sess-b", 2_000]] as const) {
    const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/demo"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ generated_title: `任务 ${sessionId}`, info: { cwd: "/tmp/demo" } }));
    const file = join(dir, "updates.jsonl");
    writeFileSync(file, `${turn({
      params: {
        sessionId,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: `prompt-${sessionId}`,
          usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
        },
        _meta: { agentTimestampMs: now - offset },
      },
    })}\n`);
    utimesSync(file, new Date(now - offset), new Date(now - offset));
  }
  const result = scanGrokUsage(0, { grokHome, now, state: createGrokScanState() });
  assert.deepEqual(result.active.map((task) => task.sessionId).sort(), ["sess-a", "sess-b"]);
  assert.equal(result.live?.sessionId, "sess-a");
  assert.equal(result.live?.lastTs, now - 1_000);
});
```

在 `src/lib/quota/codex-jsonl.test.ts` 添加完整并行与同 session rollout 去重测试：

```ts
test("Codex reports parallel sessions and deduplicates rollouts for one session", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-codex-active-"));
  const codexHome = join(home, ".codex");
  const dir = join(codexHome, "sessions", "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-08-20T11:00:00Z");
  const rows = [
    ["01a01caf-0009-78b1-a9fe-152648fe32d4", "sess-a", 1_000],
    ["01a01caf-0009-78b1-a9fe-152648fe32d5", "sess-a", 2_000],
    ["01a01caf-0009-78b1-a9fe-152648fe32d6", "sess-b", 3_000],
  ] as const;
  for (const [fileId, sessionId, offset] of rows) {
    const file = join(dir, `rollout-2026-08-20T10-59-00-${fileId}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd: "/tmp/demo", agent_nickname: sessionId } })}\n${tokenCount({ timestamp: new Date(now - offset).toISOString() })}\n`,
    );
    utimesSync(file, new Date(now - offset), new Date(now - offset));
  }
  const result = scanCodexUsage(0, { codexHome, now, state: createCodexScanState() });
  assert.deepEqual(result.active.map((task) => task.sessionId).sort(), ["sess-a", "sess-b"]);
  assert.equal(result.live?.sessionId, "sess-a");
  assert.equal(result.live?.startedAt, now - 2_000);
  assert.equal(result.live?.lastTs, now - 1_000);
  assert.equal(result.live?.turns, 2);
});
```

失败命令：

```bash
node --test --experimental-strip-types src/lib/quota/claude-jsonl.test.ts src/lib/quota/grok-jsonl.test.ts src/lib/quota/codex-jsonl.test.ts
```

预期红灯：乱序新增事件均被 `since` 丢弃；Claude 子代理没有 `actorId`；三个结果都没有 `active` 数组。

### 3.2 实现

在 `src/lib/quota/types.ts` 增加：

```ts
export type ActorKind = "subagent" | "workflow-subagent";

export interface UsageEvent {
  id: string;
  agent: AgentId;
  model: ModelId;
  modelRaw?: string;
  ts: number;
  sessionId: string;
  actorId?: string;
  actorKind?: ActorKind;
  task: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cacheWriteUnsplit?: boolean;
  reasoningMin: number;
  reportedCostTicks?: number | null;
  reportedCostByModel?: Record<string, number>;
}

export function activityIdOf(event: Pick<UsageEvent, "sessionId" | "actorId">): string {
  return event.actorId ?? event.sessionId;
}

export interface AgentLiveInfo {
  sessionId: string;
  actorId?: string;
  actorKind?: ActorKind;
  cwd: string;
  task: string;
  writing: boolean;
  lastTs: number;
  startedAt: number;
  turns: number;
}
```

扩展 Claude meta 并过滤系统提醒：

```ts
export interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  lastUser: string;
  actorId?: string;
  actorKind?: ActorKind;
}

export function normalizedActorId(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.startsWith("agent-") ? raw : `agent-${raw}`;
}

export function applyMetaLine(obj: Record<string, unknown>, meta: SessionMeta): void {
  const typ = obj.type;
  if (typeof obj.cwd === "string" && obj.cwd) meta.cwd = obj.cwd;
  if (typeof obj.sessionId === "string" && obj.sessionId) meta.sessionId = obj.sessionId;
  const actorId = normalizedActorId(obj.agentId);
  if (actorId) meta.actorId = actorId;
  if (obj.attributionAgent === "workflow-subagent") meta.actorKind = "workflow-subagent";
  else if (meta.actorId && !meta.actorKind) meta.actorKind = "subagent";
  if (typ === "custom-title" && typeof obj.customTitle === "string") meta.title = obj.customTitle;
  if (typ === "last-prompt" && typeof obj.lastPrompt === "string") meta.lastUser = obj.lastPrompt;
  if (typ === "user") {
    const msg = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : {};
    const txt = textFromContent(msg.content);
    if (
      txt &&
      !txt.startsWith("[{") &&
      !txt.includes("<local-command") &&
      !txt.trimStart().startsWith("<system-reminder>")
    ) {
      meta.lastUser = txt;
    }
  }
}
```

Claude scanner 同时维护 workflow label side map；这只读取 metadata，不读取 `totalTokens`，因此不会重复计费。`src/lib/quota/claude-log.server.ts` 的 fs import 增加 `readFileSync`，状态和初始化改为：

```ts
export interface ScanState {
  files: Map<string, FileCursor>;
  meta: Map<string, SessionMeta>;
  workflowMtimes: Map<string, number>;
  workflowLabels: Map<string, string>;
}

export function createScanState(): ScanState {
  return {
    files: new Map(),
    meta: new Map(),
    workflowMtimes: new Map(),
    workflowLabels: new Map(),
  };
}

function listWorkflowFiles(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile() && name.startsWith("wf_") && name.endsWith(".json")) out.push(path);
    }
  }
}

function refreshWorkflowLabels(roots: string[], state: ScanState): void {
  const files: string[] = [];
  for (const root of roots) listWorkflowFiles(root, files);
  for (const path of files) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (state.workflowMtimes.get(path) === mtimeMs) continue;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const progress = Array.isArray(value.workflowProgress) ? value.workflowProgress : [];
      for (const raw of progress) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const actorId = normalizedActorId(row.agentId);
        const label = typeof row.label === "string" ? row.label.trim() : "";
        if (actorId && label) state.workflowLabels.set(actorId, label);
      }
      state.workflowMtimes.set(path, mtimeMs);
    } catch {
      /* ignore truncated workflow metadata */
    }
  }
}
```

在开始读取 Claude JSONL 前执行 `refreshWorkflowLabels(roots, state)`；每条事件和 live candidate 都优先使用 side map：

```ts
const event = parseJsonlLine(line, meta);
const workflowLabel = meta.actorId ? state.workflowLabels.get(meta.actorId) : undefined;
if (event) {
  if (workflowLabel) event.task = workflowLabel;
  fresh.push(event);
}
```

`parseJsonlLine` 返回事件时增加：

```ts
actorId: meta.actorId,
actorKind: meta.actorKind,
```

三个 scan result 都增加：

```ts
active: AgentLiveInfo[];
```

三家 `folded` 只保留未来时间保护，不再用全局 lower bound 二次过滤：

```ts
const folded = foldTurns(fresh).filter((event) => event.ts <= now + 60_000);
```

其中 Claude 使用 `foldByRequestId`，Grok 使用 `foldGrokTurns`，Codex 使用 `foldCodexTurns`。

Claude meta 改为按 path：

```ts
const pathActorId = path.includes(`${sep}subagents${sep}`) && sid.startsWith("agent-") ? sid : undefined;
const meta = state.meta.get(path) ?? {
  sessionId: sid,
  cwd: "",
  title: "",
  lastUser: "",
  actorId: pathActorId,
  actorKind: pathActorId
    ? path.includes(`${sep}subagents${sep}workflows${sep}`)
      ? "workflow-subagent"
      : "subagent"
    : undefined,
};
state.meta.set(path, meta);
```

在 `src/lib/quota/types.ts` 增加共享的 `latestActivities`，三家 scanner 显式 import 后用它构造、合并并返回活动数组；Claude 的 activity key 为 `actorId ?? sessionId`，Grok/Codex 为 `sessionId`。同一 Codex session 多 rollout 时保留最新 task/cwd、最早 `startedAt`、最新 `lastTs`、最大 `turns`（每个 candidate 已基于该 session 的全部 fresh events 计算，不能求和，否则会重复）：

```ts
export function latestActivities(candidates: AgentLiveInfo[]): { live: AgentLiveInfo | null; active: AgentLiveInfo[] } {
  const sorted = candidates.sort((left, right) => right.lastTs - left.lastTs);
  const merged = new Map<string, AgentLiveInfo>();
  for (const item of sorted) {
    const key = item.actorId ?? item.sessionId;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...item });
      continue;
    }
    current.writing ||= item.writing;
    current.startedAt = Math.min(current.startedAt, item.startedAt);
    current.lastTs = Math.max(current.lastTs, item.lastTs);
    current.turns = Math.max(current.turns, item.turns);
  }
  const recent = Array.from(merged.values()).sort((left, right) => right.lastTs - left.lastTs);
  return {
    live: recent[0] ?? null,
    active: recent.filter((item) => item.writing),
  };
}
```

Claude 用以下完整循环构造候选；它跳过 `subagents/**/journal.jsonl`，但保留 `agent-*.jsonl`：

```ts
const candidates: AgentLiveInfo[] = [];
for (const [path, cursor] of state.files) {
  const age = now - cursor.mtimeMs;
  if (age > GROW_MS) continue;
  const meta = state.meta.get(path);
  if (path.includes(`${sep}subagents${sep}`) && !meta?.actorId) continue;
  const sessionId = meta?.sessionId ?? sessionIdFromPath(path);
  const activityId = meta?.actorId ?? sessionId;
  const mine = folded.filter((event) => activityIdOf(event) === activityId);
  candidates.push({
    sessionId,
    actorId: meta?.actorId,
    actorKind: meta?.actorKind,
    cwd: meta?.cwd ?? "",
    task:
      (meta?.actorId ? state.workflowLabels.get(meta.actorId) : undefined) ||
      meta?.title ||
      meta?.lastUser ||
      activityId,
    writing: age <= WRITING_MS,
    lastTs: cursor.mtimeMs,
    startedAt: mine[0]?.ts ?? cursor.mtimeMs,
    turns: mine.length,
  });
}
const { live, active } = latestActivities(candidates);
return { events: folded, live, active, roots, filesRead };
```

Grok 用以下完整循环：

```ts
const candidates: AgentLiveInfo[] = [];
for (const [path, cursor] of state.files) {
  const age = now - cursor.mtimeMs;
  if (age > GROW_MS) continue;
  const sessionId = sessionIdFromPath(path);
  const meta = state.meta.get(sessionId);
  const mine = folded.filter((event) => event.sessionId === sessionId);
  candidates.push({
    sessionId,
    cwd: meta?.cwd ?? "",
    task: meta?.title || meta?.cwd || sessionId,
    writing: age <= WRITING_MS,
    lastTs: cursor.mtimeMs,
    startedAt: mine[0]?.ts ?? cursor.mtimeMs,
    turns: mine.length,
  });
}
const { live, active } = latestActivities(candidates);
return { events: folded, live, active, roots, filesRead };
```

Codex 用以下完整循环；`latestActivities` 会合并同 session 的多个 rollout：

```ts
const candidates: AgentLiveInfo[] = [];
for (const [path, cursor] of state.files) {
  const age = now - cursor.mtimeMs;
  if (age > GROW_MS) continue;
  const meta = state.meta.get(path);
  const sessionId = meta?.sessionId ?? sessionIdFromPath(path);
  const mine = folded.filter((event) => event.sessionId === sessionId);
  candidates.push({
    sessionId,
    cwd: meta?.cwd ?? "",
    task: meta?.title || meta?.cwd || sessionId,
    writing: age <= WRITING_MS,
    lastTs: cursor.mtimeMs,
    startedAt: mine[0]?.ts ?? cursor.mtimeMs,
    turns: mine.length,
  });
}
const { live, active } = latestActivities(candidates);
return { events: folded, live, active, roots, filesRead, official, officialHistory };
```

验收：三家乱序事件测试、Claude 两个子代理活动测试、Grok/Codex 两任务活动测试全绿。

建议 commit：`fix(quota): capture concurrent agent streams`

## 4. Step 2：Store 保存三家活动数组并按 actor 聚焦

### 4.1 RED 测试

在 `src/lib/quota/store.test.ts` 添加：

```ts
test("real ingestors keep all active parallel tasks and focus the latest actor", () => {
  const parent = "parent-session";
  const childA = { ...event("claude", "child-a", 10), sessionId: parent, actorId: "agent-a", task: "任务 A" };
  const childB = { ...event("claude", "child-b", 20), sessionId: parent, actorId: "agent-b", task: "任务 B" };
  const active = [
    { sessionId: parent, actorId: "agent-b", actorKind: "subagent" as const, cwd: "/tmp", task: "任务 B", writing: true, lastTs: 20, startedAt: 20, turns: 1 },
    { sessionId: parent, actorId: "agent-a", actorKind: "subagent" as const, cwd: "/tmp", task: "任务 A", writing: true, lastTs: 10, startedAt: 10, turns: 1 },
  ];
  useQuota.getState().ingestClaudeLogs([childA, childB], { replace: true, live: active[0], active });
  const state = useQuota.getState();
  assert.equal(state.activeClaude.length, 2);
  assert.equal(state.claudeWriting, true);
  assert.equal(state.claudeSession?.id, "agent-b");
  assert.equal(state.claudeSession?.task, "任务 B");

  useQuota.getState().ingestGrokLogs([event("grok", "grok-a", 30)], { active: [] });
  useQuota.getState().ingestCodexLogs([event("codex", "codex-a", 40)], { active: [] });
  assert.deepEqual(useQuota.getState().activeGrok, []);
  assert.deepEqual(useQuota.getState().activeCodex, []);
});

test("Claude exposes a live child even before that child's first usage event", () => {
  useQuota.setState({ events: [], realEvents: [], activeClaude: [], claudeSession: null });
  const live = {
    sessionId: "parent-session",
    actorId: "agent-new",
    actorKind: "subagent" as const,
    cwd: "/tmp",
    task: "刚启动的子任务",
    writing: true,
    lastTs: 50,
    startedAt: 50,
    turns: 0,
  };
  useQuota.getState().ingestClaudeLogs([], { replace: true, live, active: [live] });
  assert.equal(useQuota.getState().claudeSession?.id, "agent-new");
  assert.equal(useQuota.getState().claudeSession?.task, "刚启动的子任务");
  assert.equal(useQuota.getState().claudeWriting, true);
});
```

失败命令：

```bash
node --test --experimental-strip-types src/lib/quota/store.test.ts
```

### 4.2 实现

`store.ts` 从 `types.ts` import `activityIdOf` 以及 `AgentLiveInfo`、`ModelId`；`imported.ts` import `activityIdOf`。

在 `QuotaState` 和初始状态增加：

```ts
activeClaude: AgentLiveInfo[];
activeGrok: AgentLiveInfo[];
activeCodex: AgentLiveInfo[];
```

初值与切回真实模式的 reset 均为 `[]`。三个 ingestor 的 opts 统一为：

```ts
opts?: { replace?: boolean; live?: AgentLiveInfo | null; active?: AgentLiveInfo[] }
```

增加聚焦 helper：

```ts
function eventsForLive(events: UsageEvent[], live: AgentLiveInfo | null | undefined): UsageEvent[] {
  if (!live) return events;
  const key = live.actorId ?? live.sessionId;
  return events.filter((event) => activityIdOf(event) === key);
}
```

本 step 同时把 `src/lib/quota/imported.ts` 的 `sessionFromEvents` 改为 activity 语义，确保上面的 store RED 能在本 step 独立转绿：

```ts
export function sessionFromEvents(events: UsageEvent[]): SessionState | null {
  const live = events.filter((event) => !event.sessionId.startsWith("daily-summary-"));
  const last = live[live.length - 1] ?? events[events.length - 1];
  if (!last) return null;
  const activityId = activityIdOf(last);
  const mine = live.filter((event) => activityIdOf(event) === activityId);
  const startedAt = mine[0]?.ts ?? last.ts;
  return {
    id: activityId,
    task: last.task,
    model: last.model,
    modelRaw: last.modelRaw,
    startedAt,
    events: mine.length,
    tokens: mine.reduce((sum, event) => sum + rawTokens(event), 0),
  };
}
```

三个 ingestor 共用无 usage event 时的 fallback：

```ts
function sessionFromLive(live: AgentLiveInfo | null | undefined, model: ModelId): SessionState | null {
  if (!live) return null;
  return {
    id: live.actorId ?? live.sessionId,
    task: live.task,
    model,
    startedAt: live.startedAt,
    events: live.turns,
    tokens: 0,
  };
}
```

三个 ingestor 分别写入：

```ts
const active = opts?.active;
const focus = eventsForLive(agentEvents, live);

activeClaude: active ?? state.activeClaude,
claudeWriting: active ? active.length > 0 : live?.writing ?? state.claudeWriting,
claudeSession:
  sessionFromEvents(focus) ??
  sessionFromEvents(claude) ??
  sessionFromLive(live, "sonnet") ??
  state.claudeSession,
```

Grok/Codex 使用以下对应赋值：

```ts
activeGrok: active ?? state.activeGrok,
grokWriting: active ? active.length > 0 : live?.writing ?? state.grokWriting,
activeCodex: active ?? state.activeCodex,
codexWriting: active ? active.length > 0 : live?.writing ?? state.codexWriting,
```

Grok/Codex 原有手写 fallback 分别替换为 `sessionFromLive(live, "grok-4.6")` 和 `sessionFromLive(live, "gpt-5.6-sol")`。初始状态、`setDemoMode(false)`、`resetDemo()` 都把三个 `active*` 清为 `[]`；它们是瞬时状态，不加入 persist `partialize`。

Dashboard 调用三个 ingestor 时均使用完整参数形状：

```ts
useQuota.getState().ingestClaudeLogs(res.events, {
  replace: !state.claudeHydrated && res.events.length > 0,
  live: res.live,
  active: res.active,
});
useQuota.getState().ingestGrokLogs(res.events, {
  replace: !state.grokHydrated && res.events.length > 0,
  live: res.live,
  active: res.active,
});
useQuota.getState().ingestCodexLogs(res.events, {
  replace: !state.codexHydrated && res.events.length > 0,
  live: res.live,
  active: res.active,
});
```

验收：同父 session 的两个 Claude actor 保留两个活动项，当前会话聚焦最近 actor；空数组能明确清除已结束任务。

建议 commit：`feat(quota): track active parallel tasks`

## 5. Step 3：actor 级报告、时间线和详情

### 5.1 RED 测试

新建 `src/lib/quota/engine.test.ts`，完整内容为：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSessions } from "./engine.ts";
import { timelineSessions } from "./timeline-sessions.ts";
import { eventsForActivity } from "./types.ts";
import { WINDOW_MS, type UsageEvent } from "./types.ts";

function ev(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "event",
    agent: "claude",
    model: "sonnet",
    ts: Date.now(),
    sessionId: "session",
    task: "任务",
    tokensIn: 100,
    tokensOut: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
    ...partial,
  };
}

test("groupSessions separates actors that share one billing session", () => {
  const now = Date.now();
  const events = [
    { ...ev({ ts: now - 2_000 }), id: "a", sessionId: "parent", actorId: "agent-a", task: "任务 A" },
    { ...ev({ ts: now - 1_000 }), id: "b", sessionId: "parent", actorId: "agent-b", task: "任务 B" },
  ];
  const groups = groupSessions(events, now, WINDOW_MS);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.id).sort(), ["agent-a", "agent-b"]);
});

test("eventsForActivity opens only the selected actor", () => {
  const events = [
    ev({ id: "a", sessionId: "parent", actorId: "agent-a" }),
    ev({ id: "b", sessionId: "parent", actorId: "agent-b" }),
    ev({ id: "root", sessionId: "parent" }),
  ];
  assert.deepEqual(eventsForActivity(events, "agent-b").map((event) => event.id), ["b"]);
  assert.deepEqual(eventsForActivity(events, "parent").map((event) => event.id), ["root"]);
});

test("timelineSessions draws separate blocks for actors sharing a parent session", () => {
  const now = Date.now();
  const blocks = timelineSessions([
    ev({ id: "a", ts: now - 2_000, sessionId: "parent", actorId: "agent-a", task: "任务 A" }),
    ev({ id: "b", ts: now - 1_000, sessionId: "parent", actorId: "agent-b", task: "任务 B" }),
  ], "claude", now);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.id).sort(), ["agent-a", "agent-b"]);
});
```

失败命令：

```bash
node --test --experimental-strip-types src/lib/quota/engine.test.ts
```

### 5.2 实现

在 `src/lib/quota/types.ts` 增加并由详情弹窗复用：

```ts
export function eventsForActivity(events: UsageEvent[], activityId: string): UsageEvent[] {
  return events.filter((event) => activityIdOf(event) === activityId);
}
```

新建 `src/lib/quota/timeline-sessions.ts`，让时间线聚合本身可 TDD：

```ts
import type { AgentId, UsageEvent } from "./types.ts";
import { WINDOW_MS, activityIdOf } from "./types.ts";
import { rawTokens } from "./engine.ts";

export interface TimelineSession {
  id: string;
  start: number;
  end: number;
  tokens: number;
  task: string;
}

export function timelineSessions(
  events: UsageEvent[],
  agent: AgentId,
  now: number,
): TimelineSession[] {
  const from = now - WINDOW_MS;
  const slice = events.filter((event) => event.agent === agent && event.ts >= from && event.ts <= now);
  const map = new Map<string, TimelineSession>();
  for (const event of slice) {
    const id = activityIdOf(event);
    const current = map.get(id);
    if (!current) {
      map.set(id, { id, start: event.ts, end: event.ts, tokens: rawTokens(event), task: event.task });
    } else {
      current.start = Math.min(current.start, event.ts);
      current.end = Math.max(current.end, event.ts);
      current.tokens += rawTokens(event);
    }
  }
  return [...map.values()].map((session) => ({
    ...session,
    end: Math.max(session.end, session.start + 4 * 60_000),
  }));
}
```

以下消费者统一使用 `activityIdOf(event)` 而不是 `event.sessionId`：

- `groupSessions` 的 map key 和 `SessionGroup.id`。
- `timeline.tsx` 删除本地 `sessionsInWindow()`，`Lane` 改为调用已测试的 `timelineSessions(events, agent, now)`；block key 使用 `block.id`。
- `EventFeed` 的点击参数改为 `onOpen?.(activityIdOf(event))`。
- `SessionDialog` 的 rows 改为 `eventsForActivity(events, sessionId)`；`sessionId` prop 名保留以避免无关 API 扩散。

`sessionFromEvents` 已在 Step 2 前移完成，报告面板继续使用 `groupSessions` 返回的 activity id，因此不需要第二套映射。

验收：同一父 session 的两个 Claude actor 在报告和时间线中为两项；从 EventFeed 或报告打开任一项，弹窗只包含该 actor 的 rows。

建议 commit：`feat(quota): group sessions by activity`

## 6. Step 4：紧凑并行任务 UI

### 6.1 RED 测试

新建 `src/lib/quota/parallel-tasks.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parallelTaskSummary } from "./parallel-tasks.ts";
import type { AgentLiveInfo } from "./types.ts";

function task(sessionId: string): AgentLiveInfo {
  return {
    sessionId,
    cwd: "/tmp",
    task: `任务 ${sessionId}`,
    writing: true,
    lastTs: 1,
    startedAt: 1,
    turns: 1,
  };
}

test("parallelTaskSummary respects paused state and caps the compact list", () => {
  assert.equal(parallelTaskSummary([task("one")], true), null);
  assert.equal(parallelTaskSummary([task("a"), task("b")], false), null);
  const summary = parallelTaskSummary(["a", "b", "c", "d", "e"].map(task), true);
  assert.equal(summary?.total, 5);
  assert.deepEqual(summary?.visible.map((item) => item.sessionId), ["a", "b", "c", "d"]);
  assert.equal(summary?.overflow, 1);
});
```

失败命令：

```bash
node --test --experimental-strip-types src/lib/quota/parallel-tasks.test.ts
node scripts/parallel-agent-card-smoke.mjs development
```

第二条 RED 使用 Vite SSR 装载真实 `AgentCard`（不是复制 JSX 或只测 helper）。新建 `scripts/parallel-agent-card-smoke.mjs`：

```js
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const mode = process.argv[2] === "production" ? "production" : "development";
const server = await createServer({ mode, appType: "custom", server: { middlewareMode: true } });
try {
  const { AgentCard } = await server.ssrLoadModule("/src/components/synq/agent-card.tsx");
  const now = Date.now();
  const activeTasks = ["a", "b", "c", "d", "e"].map((id, index) => ({
    sessionId: "parent",
    actorId: `agent-${id}`,
    actorKind: index === 0 ? "workflow-subagent" : "subagent",
    cwd: "/tmp",
    task: `并行任务 ${id}`,
    writing: true,
    lastTs: now - index,
    startedAt: now - 1_000,
    turns: 1,
  }));
  const props = {
    name: "Claude",
    adapter: "runtime-smoke",
    plan: {
      id: "smoke",
      agent: "claude",
      name: "Smoke",
      priceUsd: 0,
      blurb: "",
      windowTokenBudget: 1,
      weekTokenBudget: 1,
      windowReasoningMin: 1,
      weekReasoningMin: 1,
      kind: "subscription",
    },
    meter: {
      agent: "claude",
      windowPct: 1,
      weekPct: 1,
      windowTokens: 0,
      weekTokens: 0,
      windowReasoningMin: 0,
      weekReasoningMin: 0,
      windowBudget: 1,
      weekBudget: 1,
      windowResetsAt: now + 1_000,
      weekResetsAt: now + 1_000,
      burnPctPerHour: 0,
      etaMs: null,
      apiUsdWindow: 0,
      apiUsdWeek: 0,
      status: "ok",
    },
    session: null,
    live: true,
    activeTasks,
    events: [],
    now,
    onToggle() {},
  };
  const liveHtml = renderToStaticMarkup(React.createElement(AgentCard, props));
  assert.match(liveHtml, /并行任务/);
  assert.match(liveHtml, /5 个活跃/);
  assert.match(liveHtml, /另有 1 个任务/);
  assert.match(liveHtml, /并行任务 a/);
  assert.doesNotMatch(liveHtml, /并行任务 e/);
  const pausedHtml = renderToStaticMarkup(React.createElement(AgentCard, { ...props, live: false }));
  assert.match(pausedHtml, /采集已暂停/);
  assert.doesNotMatch(pausedHtml, /5 个活跃/);
  process.stdout.write(`parallel-agent-card-smoke mode=${mode} ok\n`);
} finally {
  await server.close();
}
```

### 6.2 实现

新建 `src/lib/quota/parallel-tasks.ts`：

```ts
import type { AgentLiveInfo } from "./types.ts";

export interface ParallelTaskSummary {
  total: number;
  visible: AgentLiveInfo[];
  overflow: number;
}

export function parallelTaskSummary(tasks: AgentLiveInfo[], live: boolean): ParallelTaskSummary | null {
  if (!live || tasks.length <= 1) return null;
  const visible = tasks.slice(0, 4);
  return { total: tasks.length, visible, overflow: tasks.length - visible.length };
}
```

`AgentCard` 增加 prop：

```ts
activeTasks?: AgentLiveInfo[];
```

并在现有实时会话位置增加完整并行态：

```tsx
{parallel ? (
  <div className="mt-5 rounded-md bg-raised px-3 py-3">
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs tracking-wide text-faint uppercase">并行任务</p>
      <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-xs text-mute">
        {parallel.total} 个活跃
      </span>
    </div>
    <ul className="mt-2 space-y-1.5">
      {parallel.visible.map((task) => (
        <li key={task.actorId ?? task.sessionId} className="flex min-w-0 items-center gap-2 text-xs">
          <span className="size-1.5 shrink-0 rounded-full bg-ok" />
          <span className="min-w-0 flex-1 truncate text-ink">{task.task}</span>
          <span className="shrink-0 text-faint">
            {task.actorKind === "workflow-subagent" ? "工作流" : task.actorKind === "subagent" ? "子代理" : "会话"}
          </span>
        </li>
      ))}
    </ul>
    {parallel.overflow > 0 ? <p className="mt-2 text-xs text-faint">另有 {parallel.overflow} 个任务</p> : null}
  </div>
) : session && live ? (
  <div className="mt-5 rounded-md bg-raised px-3 py-3">
    <p className="text-xs tracking-wide text-faint uppercase">实时会话</p>
    <p className="mt-1 text-sm text-ink">{session.task}</p>
    <p className="mt-1 font-mono text-xs text-mute">
      {modelLabel(session.model, session.modelRaw)} · {session.events} 轮 · {formatTokens(session.tokens)}
    </p>
    {liveNote ? <p className="mt-1 text-xs text-mute">{liveNote}</p> : null}
  </div>
) : live ? (
  <div className="mt-5 rounded-md bg-raised px-3 py-3 text-sm text-mute">
    {liveNote ?? "正在监听日志"}
  </div>
) : (
  <div className="mt-5 rounded-md bg-raised px-3 py-3 text-sm text-mute">采集已暂停</div>
)}
```

组件 render 前定义 `const parallel = parallelTaskSummary(activeTasks ?? [], live)`，所以暂停采集后不会残留旧任务。Dashboard 读取 `activeClaude`、`activeGrok`、`activeCodex` 并传给对应卡片。单任务仍使用原实时会话视图；两个以上任务才显示紧凑列表。

验收：报告、时间线、弹窗按 Claude actor 分开；三家两个以上活动任务显示数量和列表；移动宽度不横向溢出。

建议 commit：`feat(ui): show parallel agent tasks`

## 7. 完整验证

依次执行：

```bash
node --test --experimental-strip-types src/lib/quota/claude-jsonl.test.ts src/lib/quota/grok-jsonl.test.ts src/lib/quota/codex-jsonl.test.ts src/lib/quota/store.test.ts src/lib/quota/engine.test.ts src/lib/quota/parallel-tasks.test.ts
node scripts/parallel-agent-card-smoke.mjs development
npm test
npm run typecheck
npm run lint
npm run build
node scripts/parallel-agent-card-smoke.mjs production
```

真实回放：

1. Claude：对真实 `subagents/agent-*.jsonl` 以最新文件 mtime 作为 `now`，断言多个 actor、父 session 保留、活动任务数大于一；真实 workflow actor 的 task 命中对应 `workflowProgress[].label`。
2. Codex：对当前真实多个 rollout 文件回放，断言不同 session 同时 active、同 session 多 rollout 去重。
3. Grok：对真实时间接近的两个 `updates.jsonl` 回放，断言两个 session 同时 active。
4. `parallel-agent-card-smoke.mjs` 在 development 与 production mode 下都必须实际渲染并断言“并行任务 / 5 个活跃 / 另有 1 个任务”，且暂停态只显示“采集已暂停”。
5. 启动开发服务与 Nitro 构建，各自 HTTP 200；浏览器可用时在真实页面检查桌面和约 390px 移动宽度，确认任务名截断且无横向溢出。

## 8. 计划自检

- Spec coverage：乱序不丢、Claude actor/workflow label、三家 active、Store 聚焦、报告拆分和并行 UI 均有对应 step。
- Placeholder scan：所有测试和实现片段均为可执行代码，无待填内容。
- Type consistency：`UsageEvent`、`AgentLiveInfo`、三个 scan result、三个 ingestor 和现有组件 props 均按当前源码签名核对。
- Step size：四个 step 分别只负责采集、状态、activity 消费、UI；每步可独立红绿验证并提交。

## 9. 执行结果

- `10b2cb3 fix(quota): capture concurrent agent streams`
- `6ce272e feat(quota): track active parallel tasks`
- `5fd7e13 feat(quota): group sessions by activity`
- `c479c24 feat(ui): show parallel agent tasks`
- 全量测试：228 passed，0 failed。
- `typecheck`、`lint`、`build`、development/production `AgentCard` smoke 均为 exit 0。
- 真实日志回放：Claude 2 个 actor / 1 个父计费 session，workflow label 命中；Grok 2 个并行 session；Codex 当前 2 个活跃 session。
- 开发服务与 Nitro 构建服务均返回 HTTP 200，标题为 `Synq — Claude × Grok × Codex 额度监控`。
