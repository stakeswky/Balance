# Balance 原生 Agent 总调度实施计划

日期：2026-08-23
规格：`docs/specs/2026-08-23-balance-native-agent-orchestrator.md`
分支：`feat/balance-orchestrator`
工作树：`/Volumes/data/dev/synq-balance-orchestrator`

## 0. 执行约束

- 严格按 Step 1 至 Step 15 执行，不跳步、不合并步骤。
- 每个 Step 都先补失败测试并记录失败，再实现，再运行该 Step 的验证命令。
- 每个 Step 独立提交，提交正文末尾写入本 Step 真实通过的 `Verified-by:` 命令。
- Agent CLI 和仓库验收命令一律使用绝对路径与参数数组、`shell: false` 启动；不执行 LLM 生成的 shell 字符串。
- 不加入 Gemini 类型、配置、适配器、文案、依赖或空实现。
- 不修改用户原工作树，不把结果合并到用户当前分支，不 push、不建 PR、不部署。
- 所有 Agent 任务都在任务 worktree 中运行，整合只发生在独立 integration worktree。
- 每个 Agent 同时只运行一个任务；首版全局最多并行三个任务。
- 所有运行时写入只落到 `BALANCE_STATE_DIR`，桌面版默认值为 `~/Library/Application Support/Balance/orchestrator`。

## 1. 已核实的真实 API 与类型

以下签名已从当前仓库和本机依赖核实，执行时以它们为准：

```ts
export type AgentId = "claude" | "codex" | "grok";

export function quotaValueFor(
  events: UsageEvent[],
  agent: AgentId,
  official: OfficialSlice | null | undefined,
  kind: "five_hour" | "weekly",
  now: number,
  samples: QuotaSample[],
  dataFromMs?: number | null,
): QuotaValue;
```

`QuotaValue`、`QuotaSample`、`ValueConfidence` 直接从 `src/lib/quota/quota-value.ts` 导入，不重声明缩减接口。Server Function 直接沿用仓库现有 `createServerFn({ method }).validator((value: unknown) => schema.parse(value)).handler(async ({ data }) => data)` 链，不声明自造的 `ServerFn` 类型。

Node 运行时使用 `node:child_process` 的 `spawn(command, args, { cwd, env, detached, shell: false, signal })`；按行读取使用 `readline.createInterface({ input, crlfDelay: Infinity, signal })`；POSIX 进程组信号使用 `process.kill(-pid, signal)`。组信号失败时由登记的进程树清理器枚举 descendants，不能只终止 leader 后报告成功。

CLI 参数已在本机版本核实：

```text
claude -p <prompt> --output-format stream-json --verbose --strict-mcp-config --mcp-config {} --setting-sources "" --settings {} --permission-mode plan --json-schema <inline-schema>
codex exec --json --ignore-user-config --ignore-rules --strict-config --disable hooks --disable plugins --disable apps --disable browser_use --disable multi_agent --sandbox read-only -c approval_policy="never" --cd <cwd> --output-schema <schema-file> <prompt>
grok -p <prompt> --output-format json --no-auto-update --disable-web-search --no-subagents --verbatim --sandbox read-only --permission-mode plan --json-schema <inline-schema>
```

## 2. 固定数据契约

Step 1 必须完整落下以下公共契约，后续步骤不得另造平行类型：

```ts
import type { AgentId } from "../quota/types.ts";
import type { ValueConfidence } from "../quota/quota-value.ts";

export type NativeAgentId = AgentId;
export type TaskSize = "small" | "medium" | "large";
export type CoordinatorChoice = "auto" | NativeAgentId;
export type RunStatus =
  | "draft"
  | "ready"
  | "running"
  | "cancelling"
  | "integrating"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "capacity_blocked";
export type TaskStatus =
  | "queued"
  | "blocked"
  | "preparing"
  | "running"
  | "verifying"
  | "integrating"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface VerificationCommand {
  executable:
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | "cargo"
    | "go"
    | "git"
    | "node"
    | "python3"
    | "pytest"
    | "make"
    | "cmake"
    | "xcodebuild"
    | "swift"
    | "gradle"
    | "test"
    | "./gradlew";
  args: string[];
}

export interface AgentRuntimeProbe {
  agent: NativeAgentId;
  ok: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface QuotaCapacityEvidence {
  remainingLowUsd: number | null;
  totalHighUsd: number | null;
  valueConfidence: ValueConfidence;
  officialRemainingPct: number | null;
}

export interface RepositoryValidation {
  valid: boolean;
  reasons: string[];
  canonicalPath: string | null;
  device: number | null;
  inode: number | null;
  branch: string | null;
  baseSha: string | null;
  dirty: boolean | null;
}

export interface WorktreeRegistration {
  path: string;
  device: number;
  inode: number;
  branch: string;
}

export interface AgentCapacity {
  agent: NativeAgentId;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  remainingLowUsd: number | null;
  totalHighUsd: number | null;
  valueConfidence: ValueConfidence;
  officialRemainingPct: number | null;
  recentSuccessRate: number | null;
  allowUnknownQuota: boolean;
}

export interface OrchestratorTaskPlan {
  id: string;
  title: string;
  description: string;
  size: TaskSize;
  preferredAgent: NativeAgentId | null;
  dependsOn: string[];
  expectedFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: VerificationCommand[];
}

export interface OrchestratorPlan {
  title: string;
  summary: string;
  tasks: OrchestratorTaskPlan[];
}

export interface AssignedTask extends OrchestratorTaskPlan {
  assignedAgent: NativeAgentId;
}

export interface PlanDraft {
  runId: string;
  repositoryPath: string;
  repositoryDevice: number;
  repositoryInode: number;
  repositoryDirtyAtAnalysis: boolean;
  baseBranch: string;
  baseSha: string;
  coordinator: NativeAgentId;
  prompt: string;
  plan: OrchestratorPlan;
  assignedTasks: AssignedTask[];
  fingerprint: string;
  createdAt: number;
}

export type OrchestratorEvent =
  | { type: "process_started"; pid: number }
  | { type: "session_started"; sessionId: string }
  | { type: "message"; text: string }
  | { type: "tool_started"; tool: string; detail: string | null }
  | { type: "tool_completed"; tool: string; success: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: "diagnostic"; stream: "stdout" | "stderr"; message: string }
  | { type: "process_completed"; exitCode: number }
  | { type: "process_failed"; category: string; message: string };

export interface RunEventRecord {
  seq: number;
  runId: string;
  taskId: string | null;
  agent: NativeAgentId | null;
  at: number;
  event: OrchestratorEvent;
}

export interface TaskRunState extends AssignedTask {
  status: TaskStatus;
  worktree: WorktreeRegistration | null;
  commitSha: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface OrchestratorRun {
  id: string;
  status: RunStatus;
  repositoryPath: string;
  baseBranch: string;
  baseSha: string;
  coordinator: NativeAgentId;
  resultBranch: string | null;
  integrationWorktree: WorktreeRegistration | null;
  repositoryTrustedAt: number | null;
  error: string | null;
  draft: PlanDraft;
  tasks: TaskRunState[];
  createdAt: number;
  updatedAt: number;
}

export interface NativeAgentSetting {
  agent: NativeAgentId;
  enabled: boolean;
  binaryPath: string | null;
  allowUnknownQuota: boolean;
}

export interface OrchestratorSettings {
  globalMaxConcurrency: 1 | 2 | 3;
  agents: Record<NativeAgentId, NativeAgentSetting>;
}
```

结构化计划使用 Zod 严格校验：任务数 1 至 12；ID 只允许 `[a-z0-9][a-z0-9-]{0,47}`；标题 1 至 120 字；description 1 至 4000 字；expectedFiles 必须为仓库相对路径或 glob 且不能包含 `..`；acceptanceCriteria 每任务至少一条；verificationCommands 每任务 1 至 5 条、参数最多 30 个、单参数最多 500 字；依赖必须存在、不能自依赖、DAG 无环。

## Step 1：公共类型、计划校验与指纹

**文件**

- 新增 `src/lib/orchestrator/types.ts`
- 新增 `src/lib/orchestrator/plan.ts`
- 新增 `src/lib/orchestrator/plan.test.ts`
- 修改 `package.json`

**先写失败测试**

`plan.test.ts` 必须覆盖：合法计划通过；未知字段失败；任务数 0 与 13 失败；非法 ID 失败；未知依赖失败；自依赖失败；循环依赖失败；绝对路径和父目录路径失败；空 acceptanceCriteria 与 verificationCommands 失败；未知 executable 失败；参数 NUL、换行、超过数量或长度失败；`git` 全局 option、`-c`、`--config-env`、`--ext-diff`、`--no-index` 与非固定安全形状失败；`node -e/--eval` 与 `python3 -c` 失败；包管理器 install/add/publish 失败；合法 `npm run test`、`cargo test` 与 `git diff --check` 通过；从 Zod 生成的 JSON Schema 与 Zod 对同一有效/无效 fixture 结果一致；文件交叠任务被稳定串行化；同输入指纹稳定、字段改变后指纹变化。

**完整实现契约**

`plan.ts` 只导出：

```ts
export const orchestratorPlanSchema: z.ZodType<OrchestratorPlan>;
export const orchestratorPlanJsonSchema: ReturnType<typeof z.toJSONSchema>;
export function parseOrchestratorPlan(value: unknown): OrchestratorPlan;
export function validateVerificationCommand(command: VerificationCommand): VerificationCommand;
export function serializeOverlappingTasks(plan: OrchestratorPlan): OrchestratorPlan;
export function topologicalTaskIds(plan: OrchestratorPlan): string[];
export function fingerprintPlan(input: Omit<PlanDraft, "fingerprint" | "createdAt">): string;
```

`orchestratorPlanJsonSchema` 必须直接由 `z.toJSONSchema(orchestratorPlanSchema, { target: "draft-07" })` 生成，planner 和三个 adapters 只能导入这一份，不手写第二份 schema。Git 验收 argv 只允许四个完整形状：`["diff", "--check"]`、`["status", "--short"]`、`["rev-parse", "--verify", "HEAD"]`、`["show", "--stat", "--oneline", "HEAD"]`，不接受前置 option、额外 ref/path 或 option 变体。文件交叠规则为：规范化 `/` 分隔符后，路径完全相同、任一路径是另一目录前缀、任一路径包含 glob、或任一任务声明全仓范围时视为交叠；按原任务顺序把前一个任务 ID 加到后一个任务 dependsOn，并再次做 DAG 校验。指纹为 `sha256`，输入先按任务顺序及对象键稳定序列化。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/plan.test.ts
npm run typecheck
```

**验收**：公共类型中只有 Claude、Codex、Grok；外部计划严格使用规格字段；所有计划入口都经同一 schema；验收命令只能是结构化 argv。

**提交**：`feat(orchestrator): define validated task plans`

## Step 2：保守容量、负责人选择与任务分配

**文件**

- 新增 `src/lib/orchestrator/capacity.ts`
- 新增 `src/lib/orchestrator/capacity.test.ts`

**先写失败测试**

覆盖：禁用或未安装 Agent 被排除；额度未知默认排除；明确允许后参与；`valueConfidence` 为 medium/high 且 L3 上下界有效时使用 `remainingLowUsd / totalHighUsd`；否则逐 Agent 回退官方剩余百分比；自动负责人选最大保守百分比；同分依次按 officialRemainingPct、最近 20 个终态任务成功率、Claude/Codex/Grok 稳定顺序；手动负责人合法时生效、不可用时失败；负责人严格保留 20%；small/medium/large 映射 1/3/6；每 Agent 单槽；大任务先分；首轮最多三个 Agent；preferredAgent 只有在可参与且不会突破容量时生效；总任务单位超出可分配容量时返回 capacity_blocked 且不产生超分配方案。

**完整算法**

```ts
export const TASK_UNITS: Readonly<Record<TaskSize, number>> = {
  small: 1,
  medium: 3,
  large: 6,
};

export interface ScoredAgent extends AgentCapacity {
  scoreSource: "l3" | "official" | "unknown-allowed";
  conservativeRemainingPct: number;
  capacityUnits: number;
}

export type AssignmentResult =
  | { status: "ready"; tasks: AssignedTask[]; diagnostics: string[] }
  | { status: "capacity_blocked"; tasks: []; diagnostics: string[] };

export function scoreEligibleAgents(capacities: readonly AgentCapacity[]): ScoredAgent[];
export function chooseCoordinator(
  capacities: readonly AgentCapacity[],
  choice: CoordinatorChoice,
): NativeAgentId;
export function assignTasks(
  tasks: readonly OrchestratorTaskPlan[],
  capacities: readonly AgentCapacity[],
  coordinator: NativeAgentId,
): AssignmentResult;
```

每个 Agent 独立计算统一的 0 至 100 保守剩余百分比：当 `valueConfidence` 为 medium/high、`remainingLowUsd >= 0`、`totalHighUsd > 0` 时取 `100 * remainingLowUsd / totalHighUsd`；否则取新鲜 `officialRemainingPct`；两者都没有但 allowUnknownQuota=true 时只给 1 个保底单位并标记 unknown-allowed。百分比限制在 0 至 100，容量单位为 `floor(pct / 10)`；已明确允许 unknown 的容量单位为 1。自动负责人同分时依次比较 officialRemainingPct、recentSuccessRate、固定 Agent 顺序。负责人的 worker 可分配单位为 `floor(capacityUnits * 0.8)`，不设置最低值。任务按单位降序、原索引升序，选择“放入后剩余单位 / 总单位”最高者；相同值按保守百分比和固定 Agent 顺序决胜。preferredAgent 只在放入后不超容量时优先。所有任务无法在总容量内放下时返回 capacity_blocked，不创建写 worktree、不超分配。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/capacity.test.ts
npm run typecheck
```

**验收**：负责人和分配完全由纯函数决定，可复现且能解释；每个 Agent 都独立 fallback；未知额度不会被展示成已知值或挤占已知容量。

**提交**：`feat(orchestrator): allocate tasks by conservative capacity`

## Step 3：CLI 设置持久化、路径发现与探测

**文件**

- 新增 `src/lib/orchestrator/paths.server.ts`
- 新增 `src/lib/orchestrator/settings.server.ts`
- 新增 `src/lib/orchestrator/runtime.server.ts`
- 新增 `src/lib/orchestrator/runtime.test.ts`

**先写失败测试**

使用临时目录与假二进制覆盖：平台默认状态目录；`BALANCE_STATE_DIR` 覆盖；桌面模式拒绝缺失、相对、非当前用户所有或含符号链接的状态目录；目录 0700；设置文件 0600；设置默认值；非法 JSON 回退并保留可见诊断；三种 CLI 的候选顺序；CLI 符号链接到普通文件可用且保存 canonical target；相对路径、目录、不可执行文件、断链拒绝；`--version` 三秒超时；探测不使用 shell；保存前必须探测成功；原子写失败不破坏旧文件。

**完整接口**

```ts
export function orchestratorStateDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export function ensurePrivateDirectory(path: string): Promise<void>;
export function atomicWritePrivateJson(path: string, value: unknown): Promise<void>;
export function defaultOrchestratorSettings(): OrchestratorSettings;
export interface SettingsStoreOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
export function loadOrchestratorSettings(options?: SettingsStoreOptions): Promise<OrchestratorSettings>;
export function saveOrchestratorSettings(
  settings: OrchestratorSettings,
  options?: SettingsStoreOptions,
): Promise<void>;
export function candidateBinaryPaths(agent: NativeAgentId, env?: NodeJS.ProcessEnv): string[];
export function validateBinaryPath(path: string): Promise<string>;
export function probeBinary(
  agent: NativeAgentId,
  binaryPath: string,
  signal?: AbortSignal,
): Promise<AgentRuntimeProbe>;
export function discoverNativeAgents(
  settings: OrchestratorSettings,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<Record<NativeAgentId, AgentRuntimeProbe>>;
```

设置 schema 使用 `.strict()`；保存时固定重建三个 Agent 键，拒绝额外键。原子写步骤为同目录 `wx` 临时文件 0600、写入、fsync、关闭、rename、目标 chmod 0600、目录 fsync；所有失败路径关闭句柄并清理临时文件。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/runtime.test.ts
npm run typecheck
```

**验收**：GUI 不依赖 PATH 或登录 shell；设置和探测只作用于明确绝对路径；凭据没有进入设置文件。

**提交**：`feat(orchestrator): discover native agent CLIs safely`

## Step 4：CLI 命令构造、事件归一化与结构化结果提取

**文件**

- 新增 `src/lib/orchestrator/adapters.ts`
- 新增 `src/lib/orchestrator/adapters.test.ts`

**先写失败测试**

逐项快照三种 Agent 的 plan/execute 参数，断言无 `--yolo`、`danger-full-access`、`bypassPermissions`、`--dangerously-skip-permissions`、`--always-approve`；断言 Claude 严格空 MCP 与空 setting sources、Codex ignore config/rules、关闭非必要 features、approval_policy 与 cwd、Grok no-auto-update/无 web/无 subagent；覆盖隔离 session HOME 为 0700、只出现 auth symlink、不复制认证内容、不链接配置/hooks/MCP/history、cleanup 只删 run 内 session home；Grok inspect 空配置通过、任一 hook/plugin/MCP/config layer 失败；覆盖三种 JSONL 已知事件、未知事件、破损 JSON、stderr、usage、session/thread ID、结构化 plan 提取；覆盖 bearer/API key/OAuth token、所有注入 env 值、原始 HOME/认证目录、JSON escaped 和 URL encoded 路径脱敏，断言原始日志、run error 和 UI 事件都不泄露。

**完整接口**

```ts
export interface AgentCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentSessionEnvironment {
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
  cleanup(): Promise<void>;
}

export function prepareAgentSessionEnvironment(input: {
  agent: NativeAgentId;
  runRoot: string;
  sourceEnv?: NodeJS.ProcessEnv;
}): Promise<AgentSessionEnvironment>;
export function verifyGrokIsolation(binaryPath: string, environment: AgentSessionEnvironment): Promise<void>;
export function buildPlanCommand(input: {
  agent: NativeAgentId;
  binaryPath: string;
  repositoryPath: string;
  prompt: string;
  schemaPath: string | null;
  inlineSchema: string;
}): AgentCommand;
export function buildExecuteCommand(input: {
  agent: NativeAgentId;
  binaryPath: string;
  worktreePath: string;
  task: AssignedTask;
}): AgentCommand;
export function normalizeAgentLine(
  agent: NativeAgentId,
  stream: "stdout" | "stderr",
  line: string,
): OrchestratorEvent[];
export function extractStructuredPlan(agent: NativeAgentId, rawLines: readonly string[]): unknown;
export function redactAgentOutput(line: string, secrets: readonly string[]): string;
```

`prepareAgentSessionEnvironment` 在 `<runRoot>/agent-home/<agent>` 建立 0700 HOME：Claude 只把用户 canonical `.claude/.credentials.json` 链接到隔离 `CLAUDE_CONFIG_DIR`；Codex 只把 canonical `$CODEX_HOME/auth.json` 链接到隔离 CODEX_HOME；Grok 只把 canonical `$GROK_HOME/auth.json` 链接到隔离 GROK_HOME。它不链接 settings、hooks、plugins、skills、MCP、history 或 session。环境只包含隔离 HOME/TMPDIR、LANG、LC_ALL、对应 Agent config home 与 `NO_COLOR=1`。Grok 每次 probe 后用同一环境运行 `inspect --json`，hooks/plugins/mcpServers/configSources.layers 任一非空就 fail closed。

AgentSessionEnvironment.secrets 是创建时冻结的去重集合，完整包含：实际注入的所有非空 env 值、原始用户 HOME canonical path、三个原生配置目录 canonical path、所链接认证文件 canonical path、desktop capability；redactor 另匹配大小写不敏感的 Authorization/Bearer/API key/OAuth/token JSON 与 shell 形状、JSON escaped slash 和 URL encoded path 变体。stdout、stderr、diagnostic、message、tool detail、run error、events API 和原始日志都只接收 redacted 文本，唯一未脱敏输入只存在按行解析函数的栈内局部变量。

Claude plan 参数固定为 `-p prompt --output-format stream-json --verbose --strict-mcp-config --mcp-config {} --setting-sources "" --settings {} --permission-mode plan --json-schema inlineSchema --allowedTools Read,Glob,Grep`；execute 改为 `--permission-mode dontAsk --allowedTools Read,Edit,Write,Glob,Grep,Bash`，不带 schema。Codex plan 与 execute 都固定 `exec --json --ignore-user-config --ignore-rules --strict-config --disable hooks --disable plugins --disable apps --disable browser_use --disable multi_agent -c approval_policy="never" --cd cwd`，plan 追加 `--sandbox read-only --output-schema schemaPath`，execute 追加 `--sandbox workspace-write`。Grok plan 固定 `-p prompt --output-format json --no-auto-update --disable-web-search --no-subagents --verbatim --sandbox read-only --permission-mode plan --json-schema inlineSchema --tools Read,Glob,Grep`；execute 使用 `--output-format streaming-json --sandbox workspace --permission-mode dontAsk --tools Read,Edit,Write,Glob,Grep,Bash`，不带 schema。未知 stdout JSON 产生 diagnostic；stderr 始终产生 diagnostic；不能解析的 stdout 也产生 diagnostic，不抛异常。所有行先经 `redactAgentOutput` 再持久化、归一化或返回 UI。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/adapters.test.ts
npm run typecheck
```

**验收**：三个适配器参数可审计；所有供应商输出都能保留且不会因格式升级使调度崩溃。

**提交**：`feat(orchestrator): add native CLI adapters`

## Step 5：受控进程运行器与取消升级

**文件**

- 新增 `src/lib/orchestrator/process-runner.server.ts`
- 新增 `src/lib/orchestrator/process-runner.test.ts`

**先写失败测试**

假子进程覆盖：`shell:false`、`detached:true`、stdout/stderr 同时 drain；一行超过 1 MiB 失败；原始日志达到 20 MiB 后截断并产生一次诊断；正常退出；非零退出；spawn error；外部 AbortSignal；默认 45 分钟与最大 120 分钟超时；取消顺序 SIGINT、等待五秒、SIGTERM、等待五秒、SIGKILL；负 PID 进程组信号失败时枚举并终止已登记 descendants，不能只 kill leader 后返回成功；所有 listener 和 timer 清理。

**完整接口**

```ts
export interface ProcessRunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdoutLines: string[];
  stderrLines: string[];
}

export interface RunningProcess {
  pid: number;
  completion: Promise<ProcessRunResult>;
  cancel(): Promise<void>;
}

export interface ProcessRuntime {
  spawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  descendantPids(pid: number): Promise<number[]>;
  killPid(pid: number, signal: NodeJS.Signals): void;
  setTimer(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
}

export function startAgentProcess(input: {
  command: AgentCommand;
  agent: NativeAgentId;
  signal: AbortSignal;
  timeoutMs?: number;
  onEvent(event: OrchestratorEvent): Promise<void> | void;
  runtime?: ProcessRuntime;
}): RunningProcess;
```

默认 runtime 的 `descendantPids` 在 macOS 使用 `/bin/ps -axo pid=,ppid=` 构建父子图，只处理当前运行登记根 PID 的后代；每次发信号前检查 PID 仍属于该树。测试 runtime 不向真实进程发信号。completion 只结算一次。取消在进程已经退出时幂等返回。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/process-runner.test.ts
npm run typecheck
```

**验收**：关闭或取消不会留下子进程树；大输出不会无限占用内存。

**提交**：`feat(orchestrator): supervise native agent processes`

## Step 6：运行状态、事件日志、恢复与单实例锁

**文件**

- 新增 `src/lib/orchestrator/run-store.server.ts`
- 新增 `src/lib/orchestrator/run-store.test.ts`

**先写失败测试**

覆盖：创建 draft run；原子更新；追加已脱敏 JSONL 事件；事件 seq 从 1 单调递增；读取 run/list/events(afterSeq)；状态非法迁移拒绝；重启扫描把 draft/ready/running/cancelling/integrating/verifying 变为 interrupted 且任务非终态也变为 interrupted；capacity_blocked 与全部终态保持；损坏 run 文件隔离并出诊断；并发写按 run 串行；状态目录权限；单实例锁存在时拒绝第二个调度实例，持有进程消失时回收陈旧锁；超过 30 天的终态记录只有在没有登记 worktree 时才能清理。

**完整状态机**

```text
draft -> ready | capacity_blocked | cancelled | interrupted
ready -> running | cancelled | interrupted
running -> cancelling | integrating | verifying | failed | interrupted
cancelling -> cancelled | interrupted
integrating -> cancelling | verifying | failed | interrupted
verifying -> cancelling | completed | failed | interrupted
```

任务状态为：

```text
queued -> blocked | preparing | cancelled | interrupted
blocked -> queued | cancelled | interrupted
preparing -> running | failed | cancelled | interrupted
running -> verifying | failed | cancelled | interrupted
verifying -> integrating | failed | cancelled | interrupted
integrating -> completed | failed | cancelled | interrupted
```

运行目录固定为 `runs/<runId>/run.json`、`runs/<runId>/events.jsonl`、`runs/<runId>/stdout/`、`runs/<runId>/stderr/`、`runs/<runId>/integration/`、`runs/<runId>/tasks/<taskId>/`。runId 为 `run_<YYYYMMDDHHmmss>_<12 hex>`，不接受调用方自定义路径片段。所有诊断文本在 append 前必须经过 Step 4 的 redactor。

**完整接口**

```ts
export function createRunStore(root?: string): RunStore;

export interface RunStore {
  initialize(): Promise<void>;
  create(run: OrchestratorRun): Promise<void>;
  get(runId: string): Promise<OrchestratorRun | null>;
  list(): Promise<OrchestratorRun[]>;
  update(runId: string, mutate: (run: OrchestratorRun) => OrchestratorRun): Promise<OrchestratorRun>;
  appendEvent(record: Omit<RunEventRecord, "seq">): Promise<RunEventRecord>;
  events(runId: string, afterSeq?: number): Promise<RunEventRecord[]>;
  recoverInterrupted(): Promise<string[]>;
  pruneExpired(now: number): Promise<string[]>;
  acquireInstanceLock(): Promise<() => Promise<void>>;
}
```

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/run-store.test.ts
npm run typecheck
```

**验收**：退出或崩溃后用户能看到 interrupted；文件权限和原子性符合规格；不会有两个 sidecar 同时调度同一状态目录。

**提交**：`feat(orchestrator): persist recoverable run state`

## Step 7：Git 仓库校验、隔离 worktree 与结果分支

**文件**

- 新增 `src/lib/orchestrator/git.server.ts`
- 新增 `src/lib/orchestrator/git.test.ts`

**先写失败测试**

用 `mkdtemp` 创建真实仓库覆盖：非仓库、bare、detached HEAD、merge、rebase、无 HEAD；分析允许 dirty 并返回 dirty=true；执行拒绝当前 dirty，且 dirty 状态分析出的 draft 即使仓库随后变 clean 也必须重新分析；入口 canonicalize 并记录 device/inode/base branch/base SHA；分析后仓库被 symlink 替换或身份变化时拒绝；创建 `runs/<runId>/integration` 与 `runs/<runId>/tasks/<taskId>`；分支名清洗；Balance 身份提交；无改动任务失败；cherry-pick 成功；冲突后 abort 恢复干净；恶意 post-checkout/pre-commit hook 不执行；local filter/process、gpg program、fsmonitor、credential helper、core.sshCommand 被拒绝；任一 tracked/info `.gitattributes` 声明 filter 被拒绝；仓库含 `.mcp.json`、`.claude/settings.json`、`.claude/settings.local.json`、`.codex/config.toml` 或 `.grok/config.toml` 时执行被拒绝并显示原因；清理只删除登记且 canonical path 位于本 run 目录、没有中间 symlink 的 worktree；原仓库 HEAD 与当前分支不改变；结果只留 `balance/run-<short-id>-result`。

**完整接口**

```ts
export interface RepositorySnapshot {
  root: string;
  device: number;
  inode: number;
  branch: string;
  head: string;
  dirty: boolean;
}

export function inspectRepository(path: string, mode: "analyze" | "execute"): Promise<RepositorySnapshot>;
export function createIntegrationWorktree(input: {
  repository: RepositorySnapshot;
  runId: string;
  stateRoot: string;
}): Promise<WorktreeRegistration>;
export function createTaskWorktree(input: {
  repository: RepositorySnapshot;
  runId: string;
  taskId: string;
  stateRoot: string;
}): Promise<WorktreeRegistration>;
export function commitTaskWorktree(path: string, message: string): Promise<string>;
export function cherryPickTask(integrationPath: string, commitSha: string): Promise<void>;
export function abortCherryPick(integrationPath: string): Promise<void>;
export function assertOriginalHeadUnchanged(repository: RepositorySnapshot): Promise<void>;
export function removeRegisteredWorktree(input: {
  store: RunStore;
  repositoryRoot: string;
  runId: string;
  slot: { kind: "integration" } | { kind: "task"; taskId: string };
  stateRoot: string;
}): Promise<void>;
```

所有 Git 调用使用 `/usr/bin/git` 与参数数组，并统一传 `-c core.hooksPath=/dev/null -c commit.gpgSign=false -c tag.gpgSign=false -c core.fsmonitor=false`；环境固定 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_SYSTEM=/dev/null`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0`。仓库 local config 只读扫描并拒绝 `filter.*`、`diff.*.command`、`merge.*.driver`、`gpg.*`、`credential.*`、`core.fsmonitor`、`core.sshCommand` 与外部 helper；用 `git ls-tree` 找出所有 tracked `.gitattributes`，同时检查 `.git/info/attributes`，任何 filter 属性都拒绝。设置 `user.name=Balance Orchestrator`、`user.email=balance@localhost`；超时与最大输出固定。创建 worktree 后立刻保存 WorktreeRegistration。清理函数只能根据 runId 与 slot 从 RunStore 读取登记，调用方不能传目标路径；登记缺失，或 canonical path/device/inode/branch 任一不符都拒绝。目录严格使用 `<stateRoot>/runs/<runId>/integration` 与 `tasks/<taskId>`；每一步重查中间 symlink。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/git.test.ts
npm run typecheck
```

**验收**：每个任务和整合相互隔离；当前分支不动；失败冲突不留下半完成 cherry-pick。

**提交**：`feat(orchestrator): isolate tasks with git worktrees`

## Step 8：规划服务与可确认草案

**文件**

- 新增 `src/lib/orchestrator/planner.server.ts`
- 新增 `src/lib/orchestrator/planner.test.ts`

**先写失败测试**

注入 fake adapter/store/git/runtime 覆盖：仓库分析；自动与手动负责人；运行时不可用；生成 schema 文件只在状态目录；一次成功；第一次格式错误时带校验错误重试一次；第二次失败结束；任务交叠串行化；容量分配；草案指纹；规划只读且不会创建任务 worktree；计划中的验收命令原样保存并等待确认。

**完整接口**

```ts
export interface AnalyzeRequest {
  repositoryPath: string;
  prompt: string;
  coordinator: CoordinatorChoice;
  quotaEvidence: Record<NativeAgentId, QuotaCapacityEvidence>;
}

export interface PlannerDependencies {
  inspectRepository(path: string, mode: "analyze"): Promise<RepositorySnapshot>;
  runtimeFor(agent: NativeAgentId): Promise<AgentRuntimeProbe>;
  runPlanCommand(input: {
    command: AgentCommand;
    agent: NativeAgentId;
    signal: AbortSignal;
  }): Promise<{ stdoutLines: string[]; events: OrchestratorEvent[] }>;
  createSchemaFile(runId: string, schema: object): Promise<string>;
  recentSuccessRates(): Promise<Record<NativeAgentId, number | null>>;
  loadSettings(): Promise<OrchestratorSettings>;
  detectRuntimes(settings: OrchestratorSettings): Promise<Record<NativeAgentId, AgentRuntimeProbe>>;
  store: RunStore;
  now(): number;
  randomHex(bytes: number): string;
}

export function analyzePlan(
  request: AnalyzeRequest,
  dependencies: PlannerDependencies,
): Promise<PlanDraft>;
```

prompt 必须加入固定系统边界：只分析、不改文件；输出严格 schema；任务最多 12；每任务声明 description、size、dependsOn、expectedFiles、acceptanceCriteria、结构化 verificationCommands 和 preferredAgent；不请求凭据；Agent enum 只有三种受支持值。客户端只提交原始 QuotaCapacityEvidence，不得提交 enabled/installed/binaryPath/派生分数；Planner 从 server-side settings 和真实 probe 重建这些字段，用 RunStore 最近 20 个终态任务重算 recentSuccessRate，并对 evidence 的数值范围、置信度和 finite 值重新校验后在服务端计算 AgentCapacity。第二次请求包含首轮 Zod issue 的 JSON，不包含本机环境变量或凭据。成功后创建 status=draft 的 run；容量不足时创建 status=capacity_blocked 的可查看方案；结构化输出两次失败时返回明确错误且不创建半成品 run。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/planner.test.ts
npm run typecheck
```

**验收**：分析不改仓库；用户能先看完整分配与命令；格式错误只有一次受控修复机会。

**提交**：`feat(orchestrator): generate confirmable execution plans`

## Step 9：任务执行、验收、提交与波次调度

**文件**

- 新增 `src/lib/orchestrator/scheduler.server.ts`
- 新增 `src/lib/orchestrator/scheduler.test.ts`

**先写失败测试**

注入 fake process/git/store 覆盖：trustedRepository 必须严格为 true 并把 repositoryTrustedAt 写入 run；确认 fingerprint、仓库 device/inode 与 base SHA 任一不匹配都拒绝；dirty-at-analysis draft 必须重新分析；draft 原子转 ready 再 running；capacity_blocked 不能开始；开始前当前 dirty 拒绝；创建 integration 与每任务 worktree；依赖就绪才运行；同一 Agent 不并发；不同 Agent 同一波并发；全局并发上限；CLI 非零退出停止该依赖链；结构化验收命令逐条用 shell:false 运行；验收失败不提交；成功后由 Balance 生成 `balance(<taskId>): <title>` 并提交；每个波次完成后按拓扑 cherry-pick；无改动失败；取消先进入 cancelling、阻止新任务并终止在途进程，最后进入 cancelled；原 HEAD 变化立即 failed；成功经过 integrating 与 verifying 后进入 completed；结果分支为 `balance/run-<short-id>-result`；清理任务 worktree；保留 integration worktree 供用户检查。

**完整接口**

```ts
export interface StartRunRequest {
  runId: string;
  fingerprint: string;
  trustedRepository: true;
  confirmedRepository: {
    path: string;
    device: number;
    inode: number;
    baseSha: string;
  };
}

export interface ScheduleHandle {
  completion: Promise<OrchestratorRun>;
  cancel(): Promise<void>;
}

export interface SchedulerDependencies {
  store: RunStore;
  inspectRepository(path: string, mode: "execute"): Promise<RepositorySnapshot>;
  createIntegrationWorktree: typeof createIntegrationWorktree;
  createTaskWorktree: typeof createTaskWorktree;
  commitTaskWorktree: typeof commitTaskWorktree;
  cherryPickTask: typeof cherryPickTask;
  abortCherryPick: typeof abortCherryPick;
  assertOriginalHeadUnchanged: typeof assertOriginalHeadUnchanged;
  removeRegisteredWorktree: typeof removeRegisteredWorktree;
  runtimeFor(agent: NativeAgentId): Promise<AgentRuntimeProbe>;
  startProcess(input: Parameters<typeof startAgentProcess>[0]): RunningProcess;
  runVerification(input: {
    command: VerificationCommand;
    cwd: string;
    signal: AbortSignal;
  }): Promise<ProcessRunResult>;
  now(): number;
}

export function scheduleRun(
  request: StartRunRequest,
  dependencies: SchedulerDependencies,
): Promise<ScheduleHandle>;
```

除 `git` 与 `./gradlew` 外，验收命令运行器固定为：

```ts
spawn("/usr/bin/env", [command.executable].concat(command.args), {
  cwd: taskWorktree,
  env: {
    HOME: verificationHome,
    TMPDIR: verificationTmp,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  },
  detached: true,
  shell: false,
});
```

verificationHome 与 verificationTmp 都位于当前 run 私有目录并为 0700；不继承 `NODE_OPTIONS`、`DOCKER_HOST`、代理变量或用户 HOME。`./gradlew` 先 canonicalize，必须是 task worktree 内普通可执行文件且非 symlink，再用绝对路径直接 spawn。只有已通过 Step 1 校验、已显示在草案中且 fingerprint 未变的命令能执行。CLI 完成后验收，验收成功后提交，提交成功后进入 integration；不能把失败任务的工作树改动带入结果分支。
`git` 使用 `/usr/bin/git` 绝对路径，runner 在已校验的四种 argv 前固定加入 `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= -c core.attributesFile=/dev/null`，对 diff/show 追加内建 `--no-ext-diff` 等价安全形状；环境再固定 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_SYSTEM=/dev/null`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_EXTERNAL_DIFF=`、`GIT_DIFF_OPTS=`、`GIT_ATTR_NOSYSTEM=1`。verificationHome 与 verificationTmp 都位于当前 run 私有目录并为 0700；不继承 `NODE_OPTIONS`、`DOCKER_HOST`、代理变量或用户 HOME。`./gradlew` 先 canonicalize，必须是 task worktree 内普通可执行文件且非 symlink，再用绝对路径直接 spawn。只有已通过 Step 1 校验、已显示在草案中且 fingerprint 未变的命令能执行。CLI 完成后验收，验收成功后提交，提交成功后进入 integration；不能把失败任务的工作树改动带入结果分支。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/scheduler.test.ts
npm run typecheck
```

**验收**：任务真正隔离、按依赖和额度分配执行；只有通过验收的提交进入结果分支。

**提交**：`feat(orchestrator): execute isolated task waves`

## Step 10：冲突修复与失败闭环

**文件**

- 修改 `src/lib/orchestrator/scheduler.server.ts`
- 修改 `src/lib/orchestrator/scheduler.test.ts`

**先写失败测试**

覆盖：cherry-pick 冲突后先 abort；只调用负责人一次；负责人在 integration worktree 收到冲突文件和原任务摘要；修复后运行冲突任务全部验收命令；只提交冲突修复相关变化；修复失败、无改动、验收失败均使 run failed；不会自动重试第二次；取消时不调用冲突修复；修复后原仓库 HEAD 仍不变。

**完整行为**

新增 `resolveIntegrationConflict(input, dependencies)`：生成固定提示，列出冲突任务 ID、commit SHA、冲突文件、任务目标、已经确认的验收命令；调用 coordinator execute adapter，工作目录只给 integration worktree；完成后运行该任务验收命令并以 `fix(orchestrator): resolve <taskId> integration conflict` 提交。任何失败都保存原始 diagnostic 和用户可读 error。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/scheduler.test.ts
npm run typecheck
```

**验收**：整合冲突只有一次可审计的负责人修复机会，失败时 integration 分支保持可检查且当前分支不受影响。

**提交**：`feat(orchestrator): resolve integration conflicts safely`

## Step 11：HMR 安全 Supervisor 与本机 Server Functions

**文件**

- 新增 `src/lib/orchestrator/supervisor.server.ts`
- 新增 `src/lib/orchestrator/actions.ts`
- 新增 `src/lib/orchestrator/actions.test.ts`
- 修改 `src/lib/quota/local-request.server.ts`

**先写失败测试**

覆盖：全局单例；初始化恢复 interrupted；重复 start 幂等拒绝；list/get/events；afterSeq 增量事件；validateRepository 返回 canonical path/branch/SHA/dirty 与阻断原因；cancel 幂等；shutdown 等待取消所有进程并把非终态 run 标为 interrupted；所有 API 调用 loopback guard；桌面模式 capability 缺失/错误 fail closed、正确 token 常量时间通过、开发模式缺 token 只允许 loopback；Zod 拒绝额外字段、路径 NUL、空 prompt、非法 agent、trustedRepository 非 true、仓库确认身份不一致、客户端夹带 enabled/binaryPath/派生 capacity；设置保存前探测；不向客户端返回完整原始日志、环境、authorization 或凭据。

**完整请求契约**

```ts
interface AuthorizedInput {
  authorization: string;
}

type GetSettingsInput = AuthorizedInput;
type SaveSettingsInput = AuthorizedInput & { settings: OrchestratorSettings };
type DetectRuntimesInput = AuthorizedInput;
type ValidateRepositoryInput = AuthorizedInput & { repoPath: string };
type AnalyzePlanInput = AuthorizedInput & AnalyzeRequest;
type StartRunInput = AuthorizedInput & StartRunRequest;
type GetRunInput = AuthorizedInput & { runId: string; afterSeq?: number };
type CancelRunInput = AuthorizedInput & { runId: string };
type ListRunsInput = AuthorizedInput;

interface RunSnapshot {
  run: OrchestratorRun;
  events: RunEventRecord[];
  nextSeq: number;
}

interface RunSummary {
  id: string;
  status: RunStatus;
  repositoryPath: string;
  coordinator: NativeAgentId;
  resultBranch: string | null;
  createdAt: number;
  updatedAt: number;
}

interface OrchestratorSupervisor {
  initialize(): Promise<void>;
  getSettings(): Promise<OrchestratorSettings>;
  saveSettings(settings: OrchestratorSettings): Promise<OrchestratorSettings>;
  detectRuntimes(): Promise<Record<NativeAgentId, AgentRuntimeProbe>>;
  validateRepository(repoPath: string): Promise<RepositoryValidation>;
  analyze(input: AnalyzeRequest): Promise<PlanDraft>;
  start(input: StartRunRequest): Promise<{ runId: string }>;
  get(runId: string, afterSeq?: number): Promise<RunSnapshot>;
  cancel(runId: string): Promise<OrchestratorRun>;
  list(): Promise<RunSummary[]>;
  shutdown(): Promise<void>;
}
```

`actions.ts` 直接导出九个推导类型的链式实现：`getNativeAgentSettings`、`saveNativeAgentSettings`、`detectNativeAgentRuntimes`、`validateRepository`、`analyzeOrchestratorPlan`、`startOrchestratorRun`、`getOrchestratorRun`、`cancelOrchestratorRun`、`listOrchestratorRuns`。输入 schema 全部 `.strict()`：authorization 为 1 至 128 字符；runId 匹配 `^run_[0-9]{14}_[a-f0-9]{12}$`；repoPath 为 1 至 4096 字符且无 NUL；prompt 为 1 至 20000 字符；afterSeq 为非负整数；trustedRepository 只能是 literal true；confirmedRepository 的 path/device/inode/baseSha 全部严格校验；settings、QuotaCapacityEvidence 和 coordinator 复用前面模块的 schema。

每个 action 都使用 `createServerFn({ method: "POST" }).validator((value: unknown) => inputSchema.parse(value)).handler(async ({ data }) => { assertOrchestratorRequestAllowed(data.authorization); const supervisor = await getOrchestratorSupervisor(); return supervisor.method(data); })` 的对应展开，不声明 `ServerFn` 别名。`assertOrchestratorRequestAllowed(authorization: string, env: NodeJS.ProcessEnv = process.env): void` 先复用 `assertQuotaRequestAllowed()`，再在桌面模式把输入与 `BALANCE_ORCHESTRATOR_TOKEN` 做 `timingSafeEqual`；正式桌面 token 缺失时 fail closed。RunSnapshot 只含归一化事件和 nextSeq，不含原始 stdout/stderr。`globalThis` 只保存一个 `Promise<OrchestratorSupervisor>`，初始化失败清空槽位以便重试。注册 `Symbol.for("balance.orchestrator.shutdown")` 的异步 shutdown hook，供桌面 watchdog 调用。

**验证**

```text
node --test --experimental-strip-types src/lib/orchestrator/actions.test.ts src/lib/quota/local-request.server.test.ts
npm run typecheck
```

**验收**：所有调度入口只允许本机同源且桌面 capability 正确的请求；仓库校验 API/UI 数据闭合；HMR 不会生成两个调度器；退出能统一清理。

**提交**：`feat(orchestrator): expose guarded local orchestration APIs`

## Step 12：设置页回收插件能力与 CLI 配置

**文件**

- 修改 `src/components/balance/settings-panel.tsx`
- 修改 `src/components/balance/plugin-panel.tsx`
- 新增 `src/components/balance/native-agent-settings.tsx`
- 新增 `scripts/orchestrator-settings-ui.test.mjs`

**先写失败测试**

静态 UI 测试读取源码并断言：SettingsPanel 渲染 NativeAgentSettings 与 PluginPanel；PluginPanel 不再作为顶层 view；三种 Agent 路径、开关、版本和探测状态存在；`src/components` 与 `src/lib/orchestrator` 不出现未支持的第四种 Agent 标识；全局并发只能 1 至 3；每 Agent 文案固定单并发；保存调用 server action；探测失败可见；原适配器、导入、Claude 导出、事件协议仍存在。Playwright 回归在设置页实际切换原采集开关、导入一条用量、触发 Claude 导出入口、切换演示数据和套餐告警，并确认报告页仍可进入。

**完整交互**

`SettingsPanel` 改为 `SettingsPanel({ agents }: { agents: readonly AgentId[] })`。页面顺序为更新卡、Agent 与 CLI、本机监控、日志采集、极客模式、套餐额度告警、演示数据、高级导入与协议。`NativeAgentSettings` mount 时加载设置并探测；路径输入失焦不执行二进制，只有“保存并检测”触发 probe；保存全部成功才 toast 成功；失败保留输入并逐 Agent 展示错误。PluginPanel 加标题“高级导入与协议”，其内部原功能不删。

**验证**

```text
node --test scripts/orchestrator-settings-ui.test.mjs
npm run typecheck
```

**验收**：原插件功能全部在设置可达；本地 CLI 配置清楚且不自动安装；界面完全没有 Gemini。

**提交**：`feat(settings): manage native agent orchestration`

## Step 13：调度页、导航、容量展示与轮询

**文件**

- 新增 `src/components/balance/orchestrator-panel.tsx`
- 新增 `src/lib/orchestrator/client.ts`
- 修改 `src/components/balance/header.tsx`
- 修改 `src/components/balance/dashboard.tsx`
- 修改 `scripts/minimal-mode-e2e.mjs`
- 新增 `scripts/orchestrator-ui.test.mjs`

**先写失败测试**

静态测试与 Playwright 覆盖：导航显示“调度”且无“插件”；页面含仓库、计划、自动/手动负责人、三个 Agent 容量卡；仓库输入后调用 validateRepository 并显示 canonical path、分支、SHA、dirty 或具体阻断原因；分析后显示任务 description、acceptanceCriteria、依赖、分配、规模、文件、所有结构化验收命令、工作目录和最小环境提示；确认前无 start；用户勾选信任仓库后才提交完整确认身份；运行时每秒增量轮询；取消按钮；终态停止轮询；completed 显示 result branch 和 integration path；capacity_blocked 与失败可见；刷新后从 list 恢复最近 run 和 afterSeq 事件；interrupted 明确显示“仅可查看，不能自动续跑”；源码不出现未支持的第四种 Agent 标识。组件必须提供稳定 `data-testid`，Step 15 使用真实 server actions，不用前端 mock。

**完整数据接线**

Dashboard 从现有 quota 结果为三个 Agent 构造 `Record<NativeAgentId, QuotaCapacityEvidence>`：weekly 与 five-hour 的 `QuotaValue` 只有在 confidence 为 medium/high、remainingLowUsd 非负、totalHighUsd 为正时参与，按 `remainingLowUsd / totalHighUsd` 的比例选更小者并保留对应上下界；`officialRemainingPct` 只从非 stale 且非 null 的 windowPct/weekPct 中取 `100 - max(usedPct)`，两者都缺失时为 null，结果限制 0 至 100。enabled、binaryPath、probe 与 recentSuccessRate 不由 UI 提交，Supervisor 在服务端补齐并重算 AgentCapacity。调度页不把运行状态写入 Zustand 持久化 store。

`client.ts` 导出 `useOrchestratorController(capacities)`，内部状态为 authorization、repositoryPath、repositoryValidation、prompt、coordinatorChoice、draft、run、events、afterSeq、loading、error。桌面首次加载从 `location.hash` 的 `balance-token` 读取 capability；fragment 不发送给 sidecar，读取后立即用 `history.replaceState` 移除；开发模式使用空值并由 loopback guard 保护。validate/analyse/start/cancel 都防重复点击；start 提交 draft 中保存的 canonical path/device/inode/baseSha；轮询只请求 afterSeq 后事件；unmount 清 timer，但不取消服务端任务。历史列表可选择并重新载入终态或 interrupted 详情，不提供 resume 操作。

**验证**

```text
node --test scripts/orchestrator-ui.test.mjs
npm run typecheck
npm run build
npm run test:e2e:minimal
```

**验收**：调度成为主导航能力；计划和命令确认边界清楚；旧视图路径更新且现有监控/报告不回归。

**提交**：`feat(ui): add native agent orchestration workspace`

## Step 14：Tauri 私有状态目录与退出清理

**文件**

- 修改 `src-tauri/Cargo.toml`，新增与 lockfile 一致的 `libc = "=0.2.189"`
- 修改 `src-tauri/src/lib.rs`
- 修改 `src-tauri/capabilities/default.json` 仅在测试要求格式化时变更，不新增 shell 权限
- 修改 `scripts/tauri-scaffold.test.mjs`
- 修改 `scripts/verify-desktop-security.mjs`
- 新增 `scripts/orchestrator-watchdog.test.mjs`

**先写失败测试**

Rust 与 Node 测试覆盖：`data_dir()/Balance/orchestrator`；创建目录 0700 且拒绝 symlink/错误 owner；release 模式忽略 `BALANCE_E2E_STATE_DIR`，debug 模式只接受位于系统 temp 下、当前用户所有、无 symlink 的测试目录；sidecar env_clear 后显式注入 canonical `BALANCE_STATE_DIR`、256-bit `BALANCE_ORCHESTRATOR_TOKEN` 和原白名单；host 环境同名变量不能覆盖计算值；主窗口首次 URL fragment 带 hex token 且 HTTP 请求不含 token，前端接收后移除；debug E2E 把同一 token 写入测试状态目录的 `e2e-token` 0600，release 不写；watchdog 收到 stdin 的 `BALANCE_SHUTDOWN`、stdin 关闭或 SIGTERM 时先调用 shutdown hook，最多等待十五秒再退出；现有 main window CloseRequested 明确保留 `prevent_close + hide` 且不调用 stop；菜单 quit 和真正 app exit 先写 shutdown sentinel、Rust 等待十七秒，sidecar 未自行退出才 kill；WebView capability 无 shell execute/spawn 权限。

**完整 Rust 接线**

新增 `orchestrator_state_dir(app: &AppHandle) -> Result<PathBuf, String>`，使用 `app.path().data_dir()` 后拼 `Balance/orchestrator`，逐段 `symlink_metadata` 拒绝 symlink，`create_dir_all`，Unix 下核对当前 uid owner 并用 `PermissionsExt::set_mode(0o700)`；仅 `cfg(debug_assertions)` 分支支持上面的 temp E2E 覆盖。新增 `random_capability() -> Result<String, String>`，从 `/dev/urandom` 读取 32 bytes 并编码为 64 个小写 hex 字符；同一值通过 `.env("BALANCE_ORCHESTRATOR_TOKEN", token)` 注入 sidecar，并作为 main WebView 首次 URL 的 `#balance-token=<hex>` fragment。构造 sidecar Command 同时 `.env("BALANCE_STATE_DIR", state_dir)`。

`graceful_stop_sidecar` 先把 lifecycle 标为 stopping，在 mutex 内对仍存在的 `CommandChild.write(b"BALANCE_SHUTDOWN\n")`，然后最多等待十七秒让 `drain_sidecar_events` 清空 child；超时才 take child 并 kill。Node watchdog 对 stdin data sentinel、end/close/error 和 SIGTERM 使用同一个幂等 async handler，读取 `globalThis[Symbol.for("balance.orchestrator.shutdown")]`，`Promise.race` shutdown 与十五秒 timer，最后 `process.exit(0)`。Tauri 父进程被 SIGKILL 时，内核关闭其 sidecar stdin pipe，仍存活的 sidecar 走 stdin close 清理；如果 sidecar 自身被 SIGKILL，则不声称能运行 handler，只在下次启动通过 recoverInterrupted 兜底。

**验证**

```text
node --test scripts/tauri-scaffold.test.mjs scripts/orchestrator-watchdog.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop:verify:security
```

**验收**：桌面 app 使用私有状态目录和不可猜 capability；正常退出先给调度器完整 5 秒/5 秒取消窗口，超时才强杀；前端没有获得 shell 能力。

**提交**：`feat(desktop): secure orchestrator lifecycle`

## Step 15：假 CLI 全链路、真实 CLI 验证与文档

**文件**

- 新增 `scripts/orchestrator-e2e.mjs`
- 新增 `scripts/fixtures/fake-agent-cli.mjs`
- 修改 `package.json`
- 修改 `README.md`
- 修改 `docs/macos-desktop.md`
- 修改规格状态为 `已实现`

**先写失败测试**

假 CLI 是单个可执行 Node 脚本：`--version` 返回稳定版本；Claude/Codex/Grok 规划模式按各自输出格式返回同一两任务 DAG；执行模式根据 prompt 在当前 worktree 写指定文件并输出 session、message、usage、completed；通过环境变量选择非零退出、破损 JSON、超长行、挂起、子孙进程和冲突。E2E 在临时 Git 仓库启动真实 web server，通过 UI 保存假 CLI 绝对路径、validateRepository、分析、检查 description/acceptanceCriteria/结构化命令、确认、等待 completed，然后用 Git 断言：原分支 HEAD 未变；两个任务来自不同 worktree；结果分支名匹配 `balance/run-*-result` 且含两个提交；文件内容正确；run.json 为 completed；事件完整；进程全部退出。另跑非零退出、破损 JSON、取消挂起任务、关闭窗口继续、退出 sidecar interrupted、重启只读查看五条路径，断言 UI 状态和进程树。

真实 CLI E2E 使用临时仓库和用户已登录的 Claude、Codex 或 Grok 中至少一个可用 CLI，执行只创建一份无敏感内容的文本文件，验收命令为 `{ "executable": "test", "args": ["-f", "balance-e2e.txt"] }`，结果只留在临时仓库 result branch，完成后删除临时仓库。脚本通过 `BALANCE_REAL_CLI_E2E=1` 显式启用；CI 未启用时输出可审计 skip，但本里程碑本机交付必须至少成功运行一家。真实 CLI 不请求、读取或打印 token。

**脚本接线**

`package.json` 增加：

```json
{
  "scripts": {
    "test": "node --test --experimental-strip-types scripts/**/*.test.mjs src/lib/quota/*.test.ts src/lib/desktop-update/*.test.ts src/lib/orchestrator/*.test.ts",
    "desktop:build:debug": "tauri build --debug --target aarch64-apple-darwin --bundles app",
    "test:e2e:orchestrator": "node scripts/orchestrator-e2e.mjs"
  }
}
```

README 只宣传 macOS 本机、Claude/Codex/Grok、自带登录、先确认后执行、结果分支、不自动合并。桌面文档写明状态目录、退出语义、CLI 路径发现、故障排查和安全边界。

**验证**

```text
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e:minimal
npm run test:e2e:orchestrator
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop:prepare
npm run desktop:build:debug
```

随后按 `verify-before-done` 使用 `mktemp -d /tmp/balance-desktop-e2e.XXXXXX` 建立测试状态目录，启动真实 app bundle 可执行文件 `src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/Balance.app/Contents/MacOS/balance-desktop`，设置 `BALANCE_E2E_STATE_DIR` 指向该目录并把 stdout/stderr 落到目录内 native.log。等待 `http://127.0.0.1:4780` health 后，从 0600 `e2e-token` 读取 capability，Playwright 访问带 fragment 的本机页面，走“设置 fake CLI → 仓库校验 → 调度 → 查看结果分支”并截图。以 macOS CloseRequested 关闭主窗口后确认 sidecar 和挂起任务 PID 仍存活；重新显示窗口后取消，断言 cancelled 与完整进程树消失。

第二次启动同一 debug app 与测试状态目录，开始新的挂起任务后使用 `osascript -e 'tell application id "com.balance.desktop" to quit'` 触发真正 app quit；等待主进程与 sidecar 退出，断言 run.json 为 interrupted。再次用同一状态目录启动，读取新 e2e-token，确认历史页显示 interrupted、事件仍在、原任务 PID 不存在、十秒内没有新 task/process_started 事件，即证明没有自动续跑。日志证据包括 native.log、截图、run.json、events.jsonl、`ps` 进程树和 Git `show-ref/log`。最后至少运行一个真实原生 CLI 的临时仓库任务。

**验收**：假 CLI 全链路覆盖三家和成功/失败/取消/退出恢复；真实 CLI 至少一家；真实桌面应用路径通过；构建、lint、类型、单测、Rust 测试全部通过；运行时证据可复核。

**提交**：`test(orchestrator): verify native agent workflow end to end`

## 3. 规格覆盖矩阵

| 规格子项 | 对应 Step |
|---|---:|
| Claude/Codex/Grok，排除 Gemini | 1、3、4、12、13、15 |
| 自动/手动负责人、额度与规模分配 | 2、8、13 |
| CLI 绝对路径发现、探测、设置 | 3、12、14 |
| 凭据隔离、无 shell 启动、安全 flags | 3、4、5、14 |
| 结构化计划、用户确认、命令展示 | 1、8、11、13 |
| Agent 单槽、全局并发、依赖调度 | 2、9 |
| worktree 隔离、验证、提交、结果分支 | 7、9、10 |
| 冲突一次修复与失败闭环 | 10 |
| 事件、日志限制、取消、退出清理 | 4、5、6、11、14 |
| 本机 loopback 守卫、无 WebView shell | 11、14 |
| 插件能力回收到设置、调度成为主导航 | 12、13 |
| 持久化、恢复、刷新恢复运行 | 6、11、13 |
| 假 CLI 与真实 CLI 全链路 | 15 |

## 4. 计划自检

- **spec coverage**：规格目标、范围、UI、CLI、安全、容量、计划、执行、Git、生命周期、API、故障和验收均已映射到 Step。
- **placeholder scan**：实施步骤没有待补代码标记、空实现或伪实现；每个新增模块给出固定接口、完整算法或完整行为。
- **type consistency**：公共 Agent 类型复用现有 `AgentId`；额度复用 `QuotaValue.remainingLowUsd` 与官方百分比；Server Function、Node spawn、readline、Tauri 路径均按当前真实 API。
- **step size**：每 Step 是一个独立 TDD 单元，最多聚焦一个模块边界；Step 9 与 Step 10 刻意拆开正常调度和冲突修复。
- **destructive action**：不 merge 当前分支、不 push、不部署；删除仅限已登记且 realpath 位于私有状态目录的临时 worktree。
