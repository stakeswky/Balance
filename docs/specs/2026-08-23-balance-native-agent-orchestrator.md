# Balance 原生 Agent 总调度规格

日期：2026-08-23
状态：已实现
目标版本：Balance 0.4.x
适用平台：macOS Apple Silicon 桌面版与本机开发模式

## 1. 目标

Balance 在现有额度监控基础上增加“总调度”能力。用户选择本机 Git 仓库并输入计划后，Balance：

1. 使用设备上已经安装、由用户自行登录的 Claude Code、Codex CLI、Grok CLI；
2. 结合任务规模与 Balance 已有订阅额度信息选择调度负责人；
3. 由负责人生成结构化任务计划；
4. 在用户确认计划后，将任务分配给不同 Agent；
5. 为每个任务建立 Git worktree，隔离代码改动；
6. 采集各 CLI 的机器可读事件，统一展示执行进度；
7. 逐项验证任务产出，在独立集成 worktree 中合并；
8. 最终生成结果分支，由用户自行决定是否应用到当前分支。

调度负责人默认是“保守可用容量最高”的已安装 Agent，用户可以手动指定 Claude、Codex 或 Grok。

## 2. 范围

### 2.1 支持的 Agent

本里程碑只支持：

- Claude Code；
- Codex CLI；
- Grok CLI / Grok Build。

Gemini 不属于本里程碑，不增加 Gemini 类型、设置项、适配器、文案或占位实现。

### 2.2 支持的仓库

- 单次调度只处理一个本机 Git 仓库；
- 仓库必须存在、可读，并能解析当前 `HEAD`；
- 仓库存在未提交修改时，分析阶段允许继续，但开始执行前必须阻止并解释原因；
- 如果草案是在 dirty 状态下生成，即使用户随后清理了仓库，也必须重新分析后才能开始，避免计划基于已经消失的未提交内容；
- detached HEAD、正在 rebase/merge、bare repository 均不允许开始执行；
- 不支持远程部署读取用户设备上的仓库或 CLI。

### 2.3 交付边界

- 本里程碑交付可恢复的本机调度状态、真实 CLI 子进程、worktree、任务验证与结果分支；
- 不自动合并到 `main` 或用户当前分支；
- 不 push、不建 PR、不部署；
- 不复制、导出或跨 Agent 转发任何供应商登录凭据。

## 3. 信息架构

主导航从：

```text
监控 / 报告 / 插件 / 设置
```

调整为：

```text
监控 / 报告 / 调度 / 设置
```

### 3.1 调度页

调度页按顺序包含：

1. 仓库路径输入与校验状态；
2. 计划输入；
3. 调度负责人：自动 / 手动；
4. Claude、Codex、Grok 的安装状态与保守可用容量；
5. “分析并生成方案”按钮；
6. 待确认的结构化任务方案；
7. 任务依赖、分配 Agent、规模、文件范围、验收命令；
8. “确认并开始调度”按钮；
9. 运行状态、事件时间线、取消按钮；
10. 集成、验证与结果分支。

分析和执行必须分成两个用户动作。LLM 生成的验收命令必须先展示给用户，用户确认后才能执行。

### 3.2 设置页

原 `PluginPanel` 的全部功能迁入设置页，并按以下分区组织：

#### Agent 与 CLI

- Claude、Codex、Grok 可执行文件绝对路径；
- 自动发现路径；
- 版本；
- 可执行状态；
- 手动重新检测；
- 每个 Agent 的启用开关；
- 每 Agent 最大并发数，首版固定上限为 1；
- 全局最大并发数，默认 3、最大 3。

#### 额度与日志

- 现有本机监控；
- 现有日志采集开关；
- 现有套餐、额度与告警；
- 现有极客模式；
- 现有演示数据。

#### 高级导入与协议

- 原适配器路径与读取策略；
- 原 JSON / JSONL 手动导入；
- 原 Claude 导出载入；
- 原 `UsageEvent` 事件协议。

### 3.3 监控、报告与托盘

- 监控页与报告页的现有能力保持；
- 托盘页仍只展示额度摘要；
- 托盘页不启动、取消或合并任务；
- 运行中的调度可以在主窗口关闭后继续；退出 Balance 时必须终止 Agent 子进程并把任务标记为 interrupted。

## 4. CLI 发现与配置

### 4.1 自动发现

不能依赖 GUI 应用的 `PATH`，也不能启动登录 Shell。按以下顺序查找常见绝对路径：

#### Claude

```text
~/.local/bin/claude
~/.claude/local/claude
/opt/homebrew/bin/claude
/usr/local/bin/claude
```

#### Codex

```text
$CODEX_HOME/bin/codex
/opt/homebrew/bin/codex
/usr/local/bin/codex
~/.local/bin/codex
```

#### Grok

```text
$GROK_HOME/bin/grok
~/.grok/bin/grok
/opt/homebrew/bin/grok
/usr/local/bin/grok
```

只接受存在、是普通文件或符号链接目标为普通文件、且当前用户可执行的路径。

### 4.2 手动路径

- 用户可以在设置中填写绝对路径；
- 相对路径、含 NUL、目录路径、不可执行文件必须拒绝；
- 保存前以 `--version` 做三秒超时探测；
- 不通过 shell 拼接；
- 不自动运行 `npm`、`npx`、安装脚本或自动更新命令。

### 4.3 环境变量

Agent 子进程从 Balance sidecar 接收显式最小环境：

```text
HOME
TMPDIR
LANG
LC_ALL
CLAUDE_CONFIG_DIR
CODEX_HOME
GROK_HOME
```

其中 HOME、CLAUDE_CONFIG_DIR、CODEX_HOME、GROK_HOME 都指向本次 run 的 0700 私有 session home，不直接指向用户 home。Balance 只在对应 session home 建立指向该 Agent 原生认证文件的符号链接，不复制凭据内容，不链接 config、hooks、plugins、skills、MCP 或历史；结束后只清理 session home。CLI 仍从用户原生登录文件读取认证，供应商 CLI 自己可能在刷新登录时更新原认证文件。不把 sidecar 的完整环境传给 Agent，不读取并注入 `CLAUDE_CODE_OAUTH_TOKEN`、API key 或其他凭据。

## 5. CLI Adapter 契约

每个 Agent 适配器实现同一契约：

```ts
type NativeAgentId = "claude" | "codex" | "grok";

interface NativeAgentAdapter {
  readonly id: NativeAgentId;
  probe(binaryPath: string, signal: AbortSignal): Promise<AgentRuntimeProbe>;
  plan(request: AgentPlanRequest, signal: AbortSignal): AsyncIterable<AgentProcessEvent>;
  execute(request: AgentExecuteRequest, signal: AbortSignal): AsyncIterable<AgentProcessEvent>;
}
```

所有 CLI 使用非交互模式，不嵌入 TUI，不依赖 PTY。
本里程碑不恢复或续跑已中断的供应商会话；sidecar 重启后只恢复可查看的运行记录，并把非终态运行标记为 interrupted。

### 5.1 Claude

- 非交互：`claude -p`；
- 输出：`--output-format stream-json --verbose`；
- 规划：`--permission-mode plan --json-schema <schema>`；
- 执行：`--permission-mode dontAsk` 与显式 `--allowedTools`；
- 禁止 `bypassPermissions` 与 `--dangerously-skip-permissions`；
- 使用 `--strict-mcp-config`，不自动加载项目 MCP；
- 使用空 `--setting-sources` 和内联空 settings，不加载用户或项目 hooks/settings；认证仍由 CLI 自己读取原生登录状态；
- 从最终 result 事件提取 `session_id` 与 usage。

### 5.2 Codex

- 非交互：`codex exec`；
- 输出：`--json`；
- 规划：`--sandbox read-only --output-schema <file>`；
- 规划与执行都使用 `--ignore-user-config --ignore-rules --strict-config`，关闭 hooks、plugins、apps、browser、multi-agent 等非必要 feature；
- 执行：`--sandbox workspace-write -c approval_policy="never"`；
- 显式 `--cd <worktree>`；
- 禁止 `--yolo` 与 `danger-full-access`；
- 从 `thread.started` 提取 thread ID，从 `turn.completed` 提取 usage。

### 5.3 Grok

- 非交互：`grok -p`；
- 规划输出：`--json-schema` 隐含的 `--output-format json`；执行输出：`--output-format streaming-json`；
- 始终添加 `--no-auto-update`；
- 规划：`--sandbox read-only --json-schema <schema>`；
- 执行：`--sandbox workspace` 与显式 allow/deny 规则；
- 规划与执行都使用 `--disable-web-search --no-subagents --verbatim`，只开放对应阶段所需内置工具；
- 使用隔离 HOME 与只含原生 auth symlink 的 GROK_HOME，启动前用 `grok inspect --json` 校验 hooks/plugins/MCP/configSources 均为空；不为空则 Grok 标记不可参与；
- 禁止 `--always-approve`；
- 从结果事件提取 session ID 与 usage。

### 5.4 统一事件

供应商输出原文保留在受限大小的诊断日志中，同时归一化为：

```ts
type OrchestratorEvent =
  | { type: "process_started"; pid: number }
  | { type: "session_started"; sessionId: string }
  | { type: "message"; text: string }
  | { type: "tool_started"; tool: string; detail: string | null }
  | { type: "tool_completed"; tool: string; success: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: "process_completed"; exitCode: number }
  | { type: "process_failed"; category: string; message: string };
```

- 未识别事件不得导致运行崩溃；
- 单行最大 1 MiB；
- 单任务原始日志最多 20 MiB；
- stdout 只按 JSONL/JSON 解析，stderr 单独保存；
- 解析失败必须成为可见诊断事件。
- 供应商输出在持久化和返回 UI 前统一脱敏，至少覆盖 Authorization、Bearer token、常见 API key/OAuth token 形状、当前进程白名单环境值与用户认证目录绝对路径；
- UI 默认只读取归一化事件，原始日志只用于本机诊断且不通过普通运行快照返回。

## 6. 调度负责人和额度分配

### 6.1 可参与条件

Agent 必须同时满足：

- 设置中启用；
- CLI 探测成功；
- Balance 有该 Agent 的额度数据，或用户明确允许“额度未知时参与”；
- 当前没有占满该 Agent 的并发槽位。

### 6.2 保守可用容量

计算优先级：

1. 当 L3 剩余额度区间置信度为 medium/high，且区间上界为正数时，使用 `remainingLowUsd / totalHighUsd` 得到可比较的保守剩余百分比；
2. 否则使用该 Agent 最紧官方窗口的剩余百分比；
3. 官方数据不可用时标记 unknown，不伪造分数。

负责人默认选择保守容量最高的 Agent。并列时依次比较：

1. 当前最紧窗口剩余百分比；
2. 最近成功运行率；
3. 固定稳定排序 `claude -> codex -> grok`。

用户手动指定的负责人只要满足可参与条件即可覆盖自动结果。

### 6.3 负责人预留

- 为负责人预留 20% 当前可用容量用于规划、复核和冲突处理；
- 分配 worker 任务时不得消耗负责人全部容量；
- 无 Agent 可满足负责人预留时，方案状态为 capacity_blocked，不能开始执行。

### 6.4 任务大小和分配

负责人必须为每个任务返回 `small | medium | large`，调度器映射为容量单位：

```text
small  = 1
medium = 3
large  = 6
```

任务按容量单位从大到小分配，选择“分配后归一化剩余容量最高”的可用 Agent。相同 Agent 同时只执行一个任务。

任务包含重叠文件范围时，调度器添加确定性依赖，使其串行执行。无法解析或范围为全仓时按冲突处理，不与其他写任务并行。

## 7. 结构化计划

负责人输出必须通过 JSON Schema 与本地 Zod 双重校验：

```ts
interface OrchestratorDraftPlan {
  title: string;
  summary: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    size: "small" | "medium" | "large";
    dependsOn: string[];
    expectedFiles: string[];
    acceptanceCriteria: string[];
    verificationCommands: Array<{
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
    }>;
    preferredAgent: NativeAgentId | null;
  }>;
}
```

校验规则：

- 任务数量 1 至 12；
- ID 唯一，只能使用小写字母、数字和短横线；
- 依赖必须存在且无环；
- `expectedFiles` 必须是仓库相对路径或 glob，不允许绝对路径与 `..`；
- 验收标准不得为空；
- 验证命令最多每任务 5 条，参数最多 30 个、单参数最多 500 字符；
- 验证命令使用结构化 executable/args 并以 `shell: false` 直接启动，不接受 shell 字符串、重定向、管道、命令替换或命令串联；
- `git` 验收只允许 `diff`、`status`、`show`、`rev-parse`，`node` 禁止 `-e`/`--eval`，`python3` 禁止 `-c`，包管理器禁止 install/add/publish 等改变依赖或对外发布的子命令；
- 用户确认前不执行任何验证命令或写任务。

结构化输出无效时，允许同一负责人带校验错误重试一次；第二次失败则结束分析并显示错误。

## 8. 任务与运行状态

### 8.1 Run 状态

```text
draft
ready
running
cancelling
integrating
verifying
completed
failed
cancelled
interrupted
capacity_blocked
```

### 8.2 Task 状态

```text
queued
blocked
preparing
running
verifying
integrating
completed
failed
cancelled
interrupted
```

所有状态转换由后端状态机控制；前端不能直接改状态。

### 8.3 持久化

运行真相保存在 sidecar 的本机状态目录，不放在浏览器 Zustand：

```text
~/Library/Application Support/Balance/orchestrator/
  runs/<run-id>/run.json
  runs/<run-id>/events.jsonl
  runs/<run-id>/stdout/<task-id>.jsonl
  runs/<run-id>/stderr/<task-id>.log
```

- 目录权限 0700；
- 文件权限 0600；
- `run.json` 原子写入；
- 不保存认证 token；
- 重新启动后，非终态运行标记为 interrupted；
- completed/failed/cancelled 运行默认保留 30 天；
- 原始 stdout/stderr 每任务按 20 MiB 上限截断。

## 9. Git 隔离与集成

### 9.1 运行基线

开始执行时记录：

- 仓库绝对路径；
- 起始分支；
- base SHA；
- Git 状态。

执行期间原仓库 HEAD 变化时，运行必须停止进入 failed，禁止把结果自动应用到变化后的分支。

### 9.2 目录布局

```text
~/Library/Application Support/Balance/orchestrator/runs/<run-id>/
  integration/
  tasks/<task-id>/
```

- 集成 worktree 使用内部分支 `balance/run-<short-id>-result`；
- 每个任务使用内部分支 `balance/run-<short-id>-<task-id>`；
- 不在用户当前 checkout 中执行 Agent；
- worktree 路径必须由 Balance 生成，不能来自 LLM 输出。
- 分析入口保存仓库 canonical path、device、inode、起始分支和 base SHA，执行前重新核对；路径任一中间段为符号链接或仓库身份变化时拒绝执行；
- 创建、使用和删除 worktree 前都从登记记录解析 canonical path，并确认位于对应 `runs/<run-id>/` 下。

### 9.3 任务提交

- Worker prompt 明确要求不提交；
- Balance 在验收通过后执行 `git add -A` 与任务提交；
- 提交消息格式为 `balance(<task-id>): <task title>`；
- 如果 Agent 自行产生提交，Balance 检测后把提交范围记录为诊断，并以任务分支最终 tip 作为集成来源；
- 任务失败时不集成其变化。
- 所有 Git 子进程禁用 system/global config 与 hooks，关闭提交签名和 fsmonitor；执行前拒绝仓库 local config 中的外部 command/helper/filter，以及任何 tracked 或 info attributes 中的 clean/smudge/process filter。
- 执行前拒绝仓库中的可执行 Agent 配置 `.mcp.json`、`.claude/settings.json`、`.claude/settings.local.json`、`.codex/config.toml`、`.grok/config.toml`；普通 AGENTS/CLAUDE 指令文件属于用户确认后的代码上下文，不作为 OS 级安全隔离。

### 9.4 集成

- 按拓扑顺序把任务提交 cherry-pick 到 integration worktree；
- cherry-pick 无冲突时继续；
- 冲突时暂停队列，调用调度负责人在 integration worktree 中解决；
- 冲突解决后必须重新执行受影响任务和全局验收；
- 无法解决时 abort cherry-pick、保留任务分支与诊断，运行进入 failed。

### 9.5 结果

- completed 只表示结果分支存在且最终验收通过；
- Balance 展示结果分支、base SHA、最终 SHA、变更文件、任务提交与验证结果；
- 本里程碑不实现自动合并当前分支；
- 用户可以复制结果分支名后自行处理。

## 10. 进程与取消

- Agent binary 必须以绝对路径直接 spawn，`shell: false`；
- 每个任务使用独立进程组；
- stdout/stderr 持续 drain，不能因背压死锁；
- 任务有最长运行时间，默认 45 分钟，最大 120 分钟；
- 用户取消时：先发 SIGINT，5 秒后仍存活发 SIGTERM，再等 5 秒发 SIGKILL；
- 退出 Balance 或 sidecar 被停止时，对全部进程组执行同一清理；
- 进程组信号失败时不得只终止 leader 后宣称完成；必须枚举并终止该运行登记的 descendants，或把清理标记为失败并由 watchdog 继续处理；
- 进程被外部终止时任务进入 interrupted；
- 取消后不再启动新任务、不再集成未验收变化。

## 11. 安全约束

- 所有调度 Server Function 复用 loopback host、peer IP 与 same-origin 检查；
- WebView 不获得 Shell capability；
- Agent 不能看到其他任务 worktree 作为 cwd；
- 默认不授予仓库外写权限；
- worktree 隔离是改动隔离，不宣传为凭据或内核级安全边界；
- 用户首次对某仓库开始执行时，确认“信任这个仓库并允许本机 Agent 读取代码”；
- 计划分析只读；
- LLM 生成的结构化验证命令、工作目录和最小环境范围必须展示并由用户确认；验证命令使用独立临时 HOME、固定系统 PATH，不继承 `NODE_OPTIONS` 或 `DOCKER_HOST`；
- 禁止 `sudo`、`rm -rf`、`git reset --hard`、`git clean -fdx`、`git push`、`git checkout --`；
- 不使用从 Claude quota 读取逻辑获得的 OAuth token 启动 Agent；
- 不记录环境变量全量或认证文件内容。
- loopback 检查不是独立认证边界：桌面版启动时由 Rust 生成 256-bit 随机 capability，同时注入 sidecar 环境和主 WebView 首次 URL fragment；fragment 不发送给 HTTP server，前端读取后立即从地址栏移除，并在每个调度请求中提交；sidecar 使用常量时间比较，拒绝缺失或错误 capability；
- 开发模式在未设置 `BALANCE_ORCHESTRATOR_TOKEN` 时只保留 loopback 守卫，并在调度页显示“开发模式本机保护”；正式桌面包必须存在随机 capability，否则调度 API fail closed；
- Agent 必须读取用户原生登录目录才能完成认证，这属于用户已确认的本机 Agent 信任边界；Balance 不把凭据内容复制到任务、日志或其他 Agent。

## 12. Server API

提供下列本机 Server Functions，全部进行 Zod 输入校验与 loopback 检查：

```ts
getNativeAgentSettings(): Promise<OrchestratorSettings>
detectNativeAgentRuntimes(): Promise<Record<NativeAgentId, AgentRuntimeProbe>>
saveNativeAgentSettings(input: { settings: OrchestratorSettings }): Promise<OrchestratorSettings>
validateRepository(input: { repoPath: string }): Promise<RepositoryValidation>
analyzeOrchestratorPlan(input: AnalyzeRequest): Promise<PlanDraft>
startOrchestratorRun(input: StartRunRequest): Promise<{ runId: string }>
getOrchestratorRun(input: { runId: string; afterSeq?: number }): Promise<RunSnapshot>
cancelOrchestratorRun(input: { runId: string }): Promise<RunSnapshot>
listOrchestratorRuns(): Promise<RunSummary[]>
```

- 桌面版调用统一携带上述本机 capability；对外业务类型不把 capability 保存进 run 或日志；
- `startOrchestratorRun` 必须校验用户提交的计划与已保存 draft 完全一致；
- 后台任务由 sidecar 进程内单例 supervisor 持有；
- UI 使用轮询获取事件，首版不引入 WebSocket/SSE；
- 相同 draft 只能启动一次；
- cancel 重复调用必须幂等。

## 13. 失败与恢复

| 场景                     | 行为                                      |
| ------------------------ | ----------------------------------------- |
| CLI 不存在或版本探测失败 | Agent 不参与自动分配，设置显示原因        |
| CLI 未登录               | 当前任务失败并提示用户在原生 CLI 完成登录 |
| 额度未知                 | 默认不自动分配；用户可在设置允许参与      |
| 计划结构无效             | 同一负责人重试一次，仍失败则结束分析      |
| 创建 worktree 失败       | 不启动 Agent，运行 failed                 |
| Agent 非零退出           | 保存 stderr，任务 failed，不集成          |
| Agent 超时               | 终止进程组，任务 failed                   |
| 用户取消                 | 停止新任务，终止活动任务，运行 cancelled  |
| 验收失败                 | 任务 failed，保留 worktree 和日志         |
| cherry-pick 冲突         | 负责人尝试一次；仍冲突则 abort 并 failed  |
| sidecar 重启             | 非终态运行改为 interrupted，不自动续跑    |
| 原仓库 HEAD 改变         | 运行 failed，不触碰用户 checkout          |
| 磁盘不足                 | 停止新任务，保存能写入的诊断并 failed     |

## 14. 非目标

- Gemini；
- 云端 Agent、远程执行或跨设备调度；
- PTY/TUI 嵌入；
- 自动安装或自动升级 Agent CLI；
- 代用户登录或管理供应商凭据；
- 精确预测供应商内部 quota；
- 容器级、虚拟机级或不同 Unix 用户级的强安全隔离；
- 自动 push、PR、部署或合并到用户当前分支；
- 多仓库单次调度；
- Windows/Linux 打包版完整验收。

## 15. 验收标准

1. 导航中不再出现旧“插件”页，出现“调度”；旧插件功能全部能在设置访问。
2. 设置能检测本机 Claude、Codex、Grok 的路径和版本；任何位置都没有 Gemini。
3. 用户能选择干净 Git 仓库、输入计划并生成通过 schema 校验的任务草案。
4. 自动负责人使用保守容量最高的可用 Agent；手动指定能覆盖自动选择。
5. 用户未确认草案前，不创建写 worktree、不运行写 Agent、不执行验收命令。
6. 确认后每个任务在独立 worktree 运行，UI 能看到统一事件和状态。
7. CLI 通过绝对路径、`shell: false` 启动，默认安全参数符合本规格。
8. 任务成功后由 Balance 验收并提交；失败任务不进入结果分支。
9. 多任务按依赖和文件冲突正确串并行；每 Agent 最大并发为 1。
10. 结果在独立 `balance/run-*-result` 分支，用户当前 checkout 不被修改。
11. 取消能终止 Agent 进程组且不再启动新任务。
12. sidecar 重启后遗留运行显示 interrupted，不伪装完成。
13. 状态和日志文件权限分别为 0600/0700，日志不含凭据。
14. 远端非 loopback 请求不能调用调度 API。
15. 单元、类型、构建、Git 集成与本机 fake CLI 测试通过。
16. 使用至少一个真实已登录的原生 CLI 在临时 Git 仓库完成“分析 → 确认 → worktree 执行 → 验收 → 结果分支”的端到端路径。
17. 启动真实 Balance 桌面应用，完成设置检测、调度页分析、执行、完成状态查看，无横向溢出和阻断性控制台错误。
18. 使用会挂起的 fake CLI 验证：关闭主窗口后运行继续；用户取消后状态为 cancelled 且进程树消失；菜单退出后状态落为 interrupted；重启后能查看 interrupted 记录且不会自动续跑。
