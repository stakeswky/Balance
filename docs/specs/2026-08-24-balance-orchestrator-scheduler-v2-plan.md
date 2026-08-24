# Balance Scheduler V2 实施计划

日期：2026-08-24  
目标分支：`fix/orchestrator-scheduler-v2`  
起始提交：`be638ef29f4636e9210961b53f023a672270b4a6`

## 已核实的现状

- `createTaskWorktree()` 使用分析时的 `repository.head`，依赖任务虽然等待前置任务提交完成，但看不到前置任务已经产生的代码。
- 所有任务结束后才统一 cherry-pick；依赖约束只提供时间顺序，没有提供 Git 基线继承。
- `globalMaxConcurrency`、每 Agent 一槽位只在一次 `scheduleRun()` 内生效；不同 run 和 planning 不共享限制。
- planning、execution、conflict repair 都直接调用 `startAgentProcess()`，没有进程级 Agent lease。
- 新鲜官方额度和 L3 估值进入同一保守分数，L3 会覆盖官方百分比；coordinator 还会被硬扣 20% 执行容量。
- `capacity_blocked` 会清空全部 assignment；完整计划与当前可执行批次没有分离。
- planning 归一化事件只保存在临时数组，成功后也没有进入 run 记录。
- run JSON 没有 schema 版本，strict parse 失败会被隔离为 corrupt，无法兼容新增字段。
- watchdog SIGTERM 测试在 hook 注册前使用固定 100ms 延迟，默认并行全套存在竞态。

## 统一代码契约

以下契约在对应步骤中一次落地，后续步骤只扩展语义，不重复改名。

```ts
export type AgentRole = "planning" | "execution" | "repair";
export type TaskPriority = "critical" | "high" | "normal";

export interface AgentRoleSuccessRates {
  planning: number | null;
  execution: number | null;
  repair: number | null;
}

export interface QuotaCapacityEvidence {
  officialRemainingPct: number | null;
  officialObservedAt: number | null;
  officialResetsAt: number | null;
  officialFresh: boolean;
  officialSource: string | null;
  remainingLowUsd: number | null;
  totalHighUsd: number | null;
  valueConfidence: ValueConfidence;
  l3ObservedAt: number | null;
  diagnostics: string[];
}

export interface AgentSchedulingProfile {
  agent: NativeAgentId;
  enabled: boolean;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  canPlan: boolean;
  canExecute: boolean;
  canRepair: boolean;
  executionUnits: number;
  admissionSource: "official" | "l3-fallback" | "unknown-allowed" | "excluded";
  planningRisk: string | null;
  repairRisk: string | null;
  exclusionReasons: string[];
  roleSuccessRates: AgentRoleSuccessRates;
  quota: QuotaCapacityEvidence;
}

export interface AgentLease {
  agent: NativeAgentId;
  runId: string;
  taskId: string;
  role: AgentRole;
  acquiredAt: number;
  release(): Promise<void>;
}

export interface AgentLeaseManager {
  setGlobalMaxConcurrency(value: 1 | 2 | 3): void;
  acquire(input: {
    agent: NativeAgentId;
    runId: string;
    taskId: string;
    role: AgentRole;
    signal: AbortSignal;
  }): Promise<AgentLease>;
  shutdown(): Promise<void>;
  snapshot(): { active: number; waiting: number };
}

export interface DeferredTask {
  taskId: string;
  reason:
    | "quota"
    | "dependency"
    | "agent_unavailable"
    | "task_too_large"
    | "reservation_conflict"
    | "stale_quota";
  blockedBy: string[];
  requiredUnits: number;
  eligibleAgents: NativeAgentId[];
  eligibleAfter: number | null;
}

export interface ScheduleDraft {
  runnableTasks: AssignedTask[];
  deferredTasks: DeferredTask[];
  diagnostics: string[];
}

export interface CapacityReservationManager {
  reserve(input: {
    agent: NativeAgentId;
    runId: string;
    waveId: string;
    units: number;
    availableUnits: number;
    expiresAt: number;
  }): Promise<CapacityReservation>;
  releaseRun(runId: string): Promise<void>;
  shutdown(): Promise<void>;
  snapshot(): { active: number };
}
```

Run schema 使用数字版本 `schemaVersion: 2`。读取没有版本的旧记录时，迁移器补齐 `priority: "normal"`、`splittable: false`、空 schedule、legacy quota 诊断和 legacy planning summary，然后再由 V2 strict schema 解析。写入永远只写 V2。

## Step 1：Scheduler V2 设计规格

先增加失败门槛：文档测试断言 V2 规格包含依赖基线、跨 run lease、官方额度硬准入、角色预算、soft reservation、partial schedule、旧数据迁移和状态机。规格内建立原规格 18 项验收矩阵，每行明确实现步骤、自动测试、运行时证据和允许 skip 的条件。

实现文件：

- 新增 `docs/specs/2026-08-24-balance-orchestrator-scheduler-v2.md`。
- 更新规格索引测试，禁止重新引入 coordinator 20% 执行扣减。

验证：文档测试必须从缺文件失败变为通过，`git diff --check` 通过。

提交：`docs(orchestrator): define scheduler v2 invariants`

## Step 2A：可信 Git 基线 API

先改测试：

- `git.test.ts` 创建 A 提交后，把 A cherry-pick 到 integration；读取 integration HEAD；以该 SHA 创建 B worktree；断言 B 能读取 A 创建的真实文件。
- `scheduler.test.ts` 记录每次 `createTaskWorktree()` 的 `baseSha`，断言第一波使用初始 integration HEAD，下一波使用包含 A 的新 HEAD。
- 断言任务在 cherry-pick 成功前保持 `integrating`，成功后才为 `completed`。

实现：

```ts
export async function createTaskWorktree(input: {
  repository: RepositorySnapshot;
  runId: string;
  taskId: string;
  stateRoot: string;
  baseSha: string;
}): Promise<WorktreeRegistration>;

export async function readWorktreeHead(path: string): Promise<string>;
```

`createTaskWorktree()` 在执行 `git worktree add` 前验证 `baseSha` 是当前 run 的 integration HEAD，且 `git merge-base --is-ancestor repository.head baseSha` 成功；拒绝任意对象、其他 run 分支和非祖先 SHA。`readWorktreeHead()` 使用受控 Git 环境和 canonical registered worktree。

验证：`git.test.ts` 覆盖 B 读取 A、非法 SHA、非祖先和原 checkout 不变。

提交：`fix(orchestrator): create tasks from trusted integration heads`

## Step 2B：逐波执行与即时集成

先改 `scheduler.test.ts`：记录每波 base、commit、pick、状态；断言同波共享 base，下一波读取新 HEAD，pick 前为 integrating，pick 后 completed，冲突 repair 失败不释放依赖任务。

`scheduleRun()` 创建 integration 后循环：读取 integration HEAD，选出所有依赖已经进入 integration 的稳定 wave，从同一 `baseSha` 创建本波 worktree，并行执行，按计划原始顺序即时集成本波成功提交。集成成功后才把 task 加入 `integrated` 集合并标记完成。任一失败时停止新 wave，但保留已经集成的提交和结果分支。最终验证仍在 integration worktree 执行。取消发生在 cherry-pick 前保留未集成任务 commit，发生在 cherry-pick 成功后不回滚已集成结果；进行中的 cherry-pick 必须 abort 后再终止。

`prepareAgentCommand` 从可选依赖改为生产与测试都必须提供的 fail-closed 依赖，所有 task 级 worktree/controller/prepared environment 使用一个 `try/finally` 清理边界。

验证：`scheduler.test.ts`、fake CLI E2E、凭据隔离与 Git 安全回归测试。

提交：`fix(orchestrator): integrate dependency waves from current result head`

## Step 3A：进程级 Agent lease manager

先增加 `agent-lease.test.ts`：

- 两个 run FIFO 请求 Codex，活动 Codex lease 最大值为 1。
- 第一个 release 后第二个获得 lease。
- waiter AbortSignal 取消后被移除且永不获得 lease。
- planning、execution、repair 使用同一 Agent 队列。
- global limit 和每 Agent limit 同时生效。
- shutdown 拒绝 waiter、清空活动 lease，重复 release 幂等。

实现 `agent-lease.server.ts` 的上述 `AgentLeaseManager`：单队列按请求序号确定性扫描，同 Agent 固定并发 1，在可配置全局槽位可用时授予各 Agent 队首。`acquire()` 的取消监听在 settle 时移除。`shutdown()` 拒绝所有 waiter、使活动 lease 失效并让后续 acquire fail closed。

验证：只运行 lease manager 单测，包含 acquire/shutdown race、重复 release 和 snapshot 归零。

提交：`feat(orchestrator): add process-wide native agent leases`

## Step 3B：planning、execution 与 repair 全部接入 lease

Supervisor 持有唯一 manager，并把 `acquireAgentLease` 作为必填 scheduler 依赖。planning 每次尝试前获取 planning lease；scheduler 的普通任务和 conflict repair 分别获取 execution、repair lease；所有调用使用 `try/finally` 释放。Supervisor start 先登记一个可中断的占位 handle，再启动 scheduler，消除 shutdown 看不到刚启动 run 的窗口；取消和 shutdown 先 abort planning/schedule，再关闭 manager。

验证：lease 单测、两个 `scheduleRun()` 并行的 supervisor/scheduler 集成测试、取消和 shutdown 测试。

提交：`fix(orchestrator): serialize native agent work across runs`

## Step 4：watchdog readiness

先把全套测试中的失败稳定复现为“父进程在 READY 前不得发送 SIGTERM”。

测试子进程在安装 `balance.orchestrator.shutdown` hook 后输出精确一行 `BALANCE_WATCHDOG_READY`。`spawnHookedChild()` 使用 stdout pipe，按行读取，只有收到唯一 READY 才返回 child；超时必须清理 child 并使测试失败。删除固定 100ms sleep。

验证：watchdog 文件连续运行五次、默认 `npm test` 至少连续运行两次，exactly-once 和 bounded timeout 断言保留。

提交：`test(orchestrator): remove watchdog signal race`

阶段一门槛：相关测试、fake E2E、desktop E2E、typecheck、lint、Rust 测试、默认全套全部记录；推送 `origin/fix/orchestrator-scheduler-v2`。

## Step 5A：可审计额度 evidence 与服务器真值边界

先扩展 strict Zod 测试和旧客户端拒绝测试，再同步 `types.ts`、`schemas.ts`、`actions.ts`、dashboard/client 映射。未来时间允许的最大偏差、snapshot 最大年龄和 source 字符集使用集中常量。

服务器使用现有 `readOfficialQuota()` 刷新官方数据，并从服务器本机事件/校准样本重算可用 L3 fallback；客户端 evidence 只承载 UI 展示快照和风险提示，永远不能通过提交 `officialFresh: true` 或百分比改变硬准入。服务器既无法读取新鲜官方数据、也无法从本机可信样本重算 L3 时，进入 `waiting_quota`；只有设置里已经显式保存 `allowUnknownQuota` 才能走 unknown 策略。enabled、installed、binaryPath 始终由服务器设置/runtime 产生。

验证：伪造 76%、未来时间、过期 snapshot、跨 Agent source、NaN/Infinity/未知字段全部在启动原生进程前拒绝。

提交：`feat(orchestrator): persist auditable quota evidence`

## Step 5B：官方准入、L3 风险与角色画像

先重写 capacity 测试矩阵：

- 官方 76%、L3 50% 时 `executionUnits === 7` 且 admission source 为 official。
- 官方 0% 时 planning/execution/repair 全 false。
- 官方 5% 时 executionUnits 为 0、canPlan 为 true、canRepair 为 false并有风险诊断。
- Codex 76%、Claude 0%、Grok 5% 的 large 分配给 Codex，不存在 coordinator 容量扣减。
- 缺官方数据时 medium/high L3 才能作为 fallback；unknown 仍需显式 opt-in。

实现精确替代签名：

```ts
export function buildAgentSchedulingProfiles(input: {
  capacities: readonly AgentCapacity[];
  now: number;
}): AgentSchedulingProfile[];

export function chooseCoordinator(
  profiles: readonly AgentSchedulingProfile[],
  choice: CoordinatorChoice,
): NativeAgentId;
```

`chooseCoordinator()` 只从 `canPlan` 候选选择；任务 assignment 只从 `canExecute` 候选选择；repair 从 `canRepair` 候选单独选择。不再修改 coordinator 的 executionUnits。

客户端 evidence 保存官方观测时间、重置时间、fresh/source 和 L3 观测时间。Zod 拒绝未来超过允许时钟偏差的时间、非有限值、越界百分比和未知字段。

验证：capacity/client/actions/planner 测试与 typecheck。

提交：`feat(orchestrator): separate quota admission from valuation risk`

## Step 6：规划审计与角色成功率

增加持久化 `AgentActivityRecord`，字段仅包含 agent、role、runId、taskId、startedAt、finishedAt、success、sessionId、归一化 usage 和脱敏诊断，不保存环境、命令、认证路径或 token。

planning 过程缓冲归一化事件；runId 在启动 planning 前生成；无论结构成功或失败都写 agent activity。成功 run 的 `planning` summary 和全部脱敏 planning events 写入 run/events。`recentSuccessRates()` 按角色、按 finishedAt 倒序取最近 20 条，不再用 worker 结果代表 planning/repair。

测试：planning session/usage/时间被持久化；planning 失败计入成功率；三个角色的样本相互隔离；日志无 secret fixture。

提交：`feat(orchestrator): persist planning usage and role outcomes`

## Step 7A：集中 freshness 与多时点重新准入

集中定义 `QUOTA_SNAPSHOT_MAX_AGE_MS` 和允许时钟偏差。分析前校验服务器刷新 snapshot；规划完成后再次刷新，失败且已有 snapshot 过期时 run 进入 `waiting_quota`。Start request 和 continue request 触发服务器刷新；每波和 repair 前再次验证。不得只信任客户端 boolean freshness。

验证：分析前、规划后、start、wave、repair 五个时点各有下降/过期测试，且没有原生进程提前启动。

提交：`feat(orchestrator): revalidate quota at execution boundaries`

## Step 7B：跨 run 软容量预订

实现 `CapacityReservationManager`：

```ts
interface CapacityReservation {
  id: string;
  agent: NativeAgentId;
  runId: string;
  waveId: string;
  units: number;
  createdAt: number;
  expiresAt: number;
  release(): Promise<void>;
}
```

在上述 `CapacityReservationManager.reserve()` 内原子完成“清理过期 reservation、减去其他 run 有效 reservation、验证本波 units、幂等建立 reservation”。同 run/wave 重复请求返回同一 reservation。任务/波结束、取消、失败、shutdown 全部 release。task scoped controller 在 worktree 创建前建立，所有 await 阶段共享 `try/finally`，因此取消发生在 worktree/runtime/preparation/lease/process 任一阶段都不会泄漏 reservation、lease 或 worktree。

测试两个 run 不会重复预订 Codex 同一容量；取消和 shutdown 后计数归零；旧 snapshot 不启动进程。

提交：`feat(orchestrator): reserve wave capacity across runs`

阶段二门槛：更新 V2 规格，跑相关测试、两个 E2E、typecheck、lint、Rust、默认全套；推送同一远程分支。

## Step 8：容量感知 planning contract

扩展 task：

```ts
export interface OrchestratorTaskPlan {
  id: string;
  title: string;
  description: string;
  size: TaskSize;
  priority: TaskPriority;
  splittable: boolean;
  preferredAgent: NativeAgentId | null;
  dependsOn: string[];
  expectedFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: VerificationCommand[];
}
```

planning prompt 注入 JSON capacity envelope，包含 availableAgents、角色、executionUnits、单任务上限、总容量、全局和每 Agent 并发、observedAt/resetsAt。Prompt 明确定义 small/medium/large，要求最少必要任务、完整路线图、priority、splittable 和本地调度器最终决定权。

测试 JSON Schema 与 Zod 都要求新字段；fake agent fixture 返回新结构；prompt snapshot 包含完整 envelope 和反膨胀约束。

提交：`feat(orchestrator): make planning capacity aware`

## Step 9：确定性 partial batch 选择器

新增纯函数：

```ts
export function selectScheduleBatch(input: {
  tasks: readonly OrchestratorTaskPlan[];
  profiles: readonly AgentSchedulingProfile[];
  integratedTaskIds: ReadonlySet<string>;
  globalMaxConcurrency: 1 | 2 | 3;
}): ScheduleDraft;
```

枚举最多 12 个任务的所有子集；只保留依赖闭合子集，再以确定性回溯分配 Agent。每 Agent 本批固定最多一个同时运行任务，全局不超过 limit，原子任务不能拆分。比较元组依次为 critical 完成数、闭包完成数、高优先级完成数、使用单位、负任务数、稳定计划位图、稳定 Agent 顺序。

返回完整 `ScheduleDraft`，为每个未选任务生成明确 DeferredTask。总容量不足不再返回空计划；可运行部分为 `partial_ready`，全部可运行是 `draft`，暂时无可运行是 `waiting_quota`，不可拆且超过所有策略最大能力是 `unschedulable`。

可拆分且过大的 large 只允许 coordinator 发起一次局部结构修复；修复输入只包含目标 task 和容量上限，输出替换该 task 的子图并重新走完整 schema、依赖、文件冲突和 fingerprint 校验。

测试 39 units/6 units 保留九项完整计划并选一个合法闭包；不可拆任务 unschedulable；可拆任务只重试一次；稳定输入重复运行得到字节一致结果。

提交：`feat(orchestrator): schedule dependency-closed partial batches`

## Step 10A：V2 run schema、旧数据迁移与部分状态机

Run 增加 `schemaVersion: 2`、quotaSnapshot、agentProfiles、schedule、planning summary。状态增加 `partial_ready`、`waiting_quota`、`partial_completed`、`unschedulable`。Task 保留完整计划的每项状态，deferred task 使用 `blocked` 但原因来自 schedule。

实现 `export function migrateLegacyRun(raw: unknown): OrchestratorRun`：无版本旧 run 先使用冻结的 legacy strict schema 解析，再转换为 V2；迁移发生在 corrupt quarantine 之前。旧 capacity_blocked 只读展示并带兼容诊断，不自动继续。未知未来 schema 版本 fail closed；malformed JSON 仍 quarantine；V2 写后读必须严格相等。`unschedulable` 和 `interrupted` 为只读终态，`waiting_quota`、`partial_ready`、`partial_completed` 可经受控 continue 转换。

验证：run-store migration/状态转换/恢复测试。

提交：`feat(orchestrator): version partial scheduling run state`

## Step 10B：继续执行与部分结果生命周期

`continueOrchestratorRun()` 使用服务器刷新 snapshot，保持 immutable full plan 和原始确认 fingerprint，排除 completed tasks，用最新 integration HEAD 重新 select batch。输入包含 `idempotencyKey`，格式为 32 个小写十六进制字符；run 持久化最近请求键和对应 schedule generation。同 run/key 重复请求返回原结果，不重复执行或预订；同 key 携带不同 fingerprint 直接拒绝。immutable fingerprint 覆盖仓库身份、prompt 和 full plan，不覆盖可变 schedule/quota；client 修改 title/dependsOn/expectedFiles/priority/splittable 必须拒绝。interrupted 永远只读。仓库身份或 immutable plan fingerprint 变化要求重新确认。

Scheduler 完成本批且仍有 deferred 时进入 `partial_completed`；继续从已有 integration worktree/result branch 开始，不重做 completed task。失败保留已集成结果，依赖失败的任务 blocked。

测试完整状态转换、旧 run fixture、继续不重跑、stale wait、额度刷新恢复、幂等 continue、interrupted 拒绝继续。

提交：`feat(orchestrator): continue partial runs from integration head`

## Step 11A：continue action 与 client 状态闭环

新增严格 POST action `continueOrchestratorRun`，输入使用现有 `authorization` capability、runId、immutable fingerprint、32 hex `idempotencyKey` 和 client display snapshot。所有 endpoint 继续经过现有 combined guard 和常量时间 capability 比较。重复 start/continue、并发重复请求、错误 authorization、旧 fingerprint、同 key 不同 payload、重启后的相同幂等键都有 action/supervisor 测试。Client 保存完整 plan、runnable/deferred、profiles；轮询集合和终态集合覆盖新状态。

验证：actions/client/supervisor 单测。

提交：`feat(orchestrator): expose quota refresh and continuation api`

## Step 11B：UI 完整闭环与浏览器 E2E

UI 每个 Agent 显示 CLI、官方百分比/时间/重置、L3 风险、执行单位、三角色、reservation 和排除原因。任务始终遍历完整 `plan.tasks`，显示 priority、size、splittable、依赖、文件、验收命令、分配、本批/延后原因/eligibleAfter。

提供“按当前额度执行”“刷新额度并继续”“重新分析或调整目标”。39/6 场景显示完整九项、本批一项、延后八项，不再只有“可信额度不足”。

测试 UI 静态契约、Playwright partial/wait/continue、页面切换持久状态、旧插件功能仍在设置、结果 branch/base/final SHA/提交/验证元数据可见和控制台零阻断错误。

提交：`feat(orchestrator): expose complete schedule diagnostics`

## Step 12A：fake CLI 与浏览器集成 E2E

先扩展 fake CLI/Playwright 测试并跑出缺少 V2 UI/状态的失败，再实现必要 fixture 与测试入口。覆盖依赖 B 读取 A、跨 run Codex 最大并发 1、39/6 partial、额度下降 wait、刷新 continue、取消/shutdown 清理、设置迁移和页面切换持久状态。

验证：fake CLI E2E、浏览器 orchestrator E2E；提交 `test(orchestrator): cover scheduler v2 browser lifecycle`。

## Step 12B：桌面 E2E 与安全回归

先扩展桌面 E2E 断言，再构建真实 debug app。覆盖设置、分析、部分执行、等待、继续、完成、重启只读和进程树清理。

安全回归矩阵必须保留 dirty/detached/rebase/bare/symlink/repository identity、unsafe Git config/filter/Agent config、受控 verification cwd/env/grammar、未知 JSONL、1 MiB 行、20 MiB 截断、stdout/stderr 分离、timeout 信号阶梯、外部终止和 descendants 清理；这些已有边界不得因 V2 重构放宽。

验证：desktop debug build、desktop E2E、Git/process/capability/auth isolation 测试、Rust/Tauri 测试；提交 `test(orchestrator): verify scheduler v2 desktop safety`。

## Step 12C：规格与验收矩阵收口

更新 V2 规格为实现态，逐条填满原规格 18 项和本次 18 项核心矩阵的实现、测试命令与证据路径。文档测试先因空证据失败，填入真实结果后通过。

只填入已经取得的真实测试结果和证据路径，不预填后续结果；提交 `docs(orchestrator): finalize scheduler v2 specification`。

## Step 12D：完成前全量验证

按 `verify-before-done` 运行：orchestrator/quota/planner/scheduler/supervisor/watchdog、浏览器 E2E、桌面 E2E、typecheck、lint、默认 npm test、Rust/Tauri、desktop debug build。记录每条真实 pass/fail/skip 和证据路径。真实供应商 CLI 只在登录、额度和安全边界允许时 smoke；否则明确未执行。此步骤不修改产品代码；任一失败进入下一步骤的明确 finding 列表。

## Step 12E：对抗终审与定向修复

并行只读终审 correctness、security、spec/schema compatibility。每个确认 finding 建立一个独立 TDD fix commit，先跑失败复现，再修复并重跑受影响测试；所有 finding 关闭后重新执行 Step 12D 中受影响的命令。

## Step 12F：交付推送

只执行交付检查：工作树 clean、`git diff --check`、本地提交列表、main HEAD 未变化。推送 `origin/fix/orchestrator-scheduler-v2`，再核对远程 SHA 与本地一致。不合并或推送 main，不建 PR，不 force push。

提交：`docs(orchestrator): finalize scheduler v2 specification`
