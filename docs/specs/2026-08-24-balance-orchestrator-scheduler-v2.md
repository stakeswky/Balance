# Balance 原生 Agent Scheduler V2 规格

日期：2026-08-24  
状态：实施中  
基线：`feat/balance-orchestrator@be638ef29f4636e9210961b53f023a672270b4a6`

## 1. 目的

Scheduler V2 修复四类系统性问题：依赖任务没有继承代码基线、Agent 并发只在单 run 内生效、额度估值与执行准入混在一起、容量不足时完整计划被整体清空。V2 保留原有 CLI 隔离、capability、Git 安全和验证命令边界，并增加可恢复的部分调度闭环。

## 2. 不变量

### 2.1 Git 与依赖

1. 一个任务启动时，其 worktree 必须包含所有传递依赖基线的已集成结果。
2. integration worktree 是结果真相；下一波任务只能从当时的 integration HEAD 创建。
3. 同一波互相独立的任务从同一个 integration HEAD 并行创建。
4. 本波成功提交按拓扑顺序和原计划顺序确定性集成。
5. task 只有 cherry-pick 或受控 conflict repair 成功后才能进入 `completed`；提交完成但尚未集成时必须保持 `integrating`。
6. 用户 checkout 永远不修改，原仓库 HEAD、branch 和 clean identity 在每个安全边界继续校验。
7. integration 和 task worktree 路径只能由 run store 登记生成；任务基线必须是当前 run result branch 上、且以原始 base 为祖先的 commit。

### 2.2 进程级 Agent lease

1. sidecar 只有一个进程级 Agent lease manager。
2. Claude、Codex、Grok 各自同时最多一个 planning、execution 或 repair lease。
3. lease 跨 run 生效，并和 `globalMaxConcurrency` 同时约束。
4. 同 Agent waiter 保持 FIFO；不同 Agent 在全局槽位允许时可并行。
5. acquire 对 AbortSignal 敏感；取消 waiter 后不会再启动进程。
6. lease 在成功、失败、取消、超时、spawn error、验证失败、提交失败、cherry-pick 失败和 cleanup error 路径都由 `finally` 释放。
7. shutdown 拒绝 waiter、终止活动进程、清空 lease，并拒绝新的 acquire。

### 2.3 额度硬准入与角色

1. 新鲜官方额度决定硬准入；L3 美元估值不得覆盖新鲜官方百分比并压低 executionUnits。
2. L3 只负责风险、价值、持续时间、次级排序，或在服务器没有新鲜官方数据时使用本机可信样本做保守 fallback。
3. 客户端提交的百分比、fresh/source、enabled、installed 或 binaryPath 都不能成为服务器真值。
4. planning / execution / repair 是三个独立角色。
5. 官方剩余大于 0、但不足一个执行单位的 Agent 可以是 planning-only；官方 0% 不得自动承担任何角色。
6. coordinator 的 executionUnits 保持完整，规划预算与执行预算分别审计。
7. planning、execution、repair 成功率分别统计，缺历史为 null。

### 2.4 Freshness 与跨 run 软预订

1. 规划前、规划后、用户开始、每波开始、repair 前都重新验证服务器 quota snapshot。
2. stale 或无法验证的 snapshot 不启动原生进程，而进入 `waiting_quota`；显式 unknown 策略只能来自持久化设置。
3. soft reservation 按 Agent、run、wave 记录，只预订当前波，不锁住未来完整计划。
4. reservation 在 manager 内原子检查其他 run 占用并幂等创建。
5. reservation 不宣称锁定供应商真实 quota；它只防止 sidecar 内多个 run 重复计算同一容量。
6. 完成、失败、取消、超时和 shutdown 都释放 reservation；过期项可安全回收。

### 2.5 完整计划、部分调度与继续

1. 完整计划与当前批次分离；任何容量结果都保留 full plan。
2. `partial_ready` 表示本批可运行且仍有 deferred；`waiting_quota` 表示暂时没有安全任务；`partial_completed` 表示结果分支已有本批成果但 full plan 未完成；`unschedulable` 表示结构上无法运行。
3. deferred 原因至少区分 quota、dependency、agent_unavailable、task_too_large、reservation_conflict、stale_quota。
4. batch selector 对最多 12 项做确定性精确搜索，满足依赖闭合、Agent 容量、每 Agent 1、全局并发和文件冲突依赖。
5. 原子 large 不能由多个 Agent 拼接；splittable large 最多接受一次局部拆分修复，不重写无关计划。
6. continue 使用新的服务器 snapshot，不重跑 completed task，并从最新 integration HEAD 创建后续 worktree。
7. continue 使用持久化 idempotency key；相同 key 重复请求返回原结果，不重复执行或预订。
8. interrupted run 永远只读；旧 `capacity_blocked` run 只读兼容，不自动继续。

## 3. 核心类型

### 3.1 Quota snapshot

每个 Agent 的 quota audit 至少记录官方剩余、观测时间、重置时间、fresh/source、L3 区间与置信度、L3 观测时间、最终 admissionSource 和 diagnostics。所有数字必须 finite；百分比限定 0 至 100；未来时间只允许集中定义的时钟偏差。

服务器优先调用现有官方读取和本机 quota/calibration 数据。UI snapshot 仅用于展示与风险对照。服务器无法得到可信 snapshot 时进入 waiting，而不是相信客户端自报额度。

### 3.2 Role profile

每个 Agent 产生 `canPlan`、`canExecute`、`canRepair`、`executionUnits`、`planningRisk`、`repairRisk`、`exclusionReasons` 和分角色成功率。自动 planner 只从 canPlan 选择；worker 只从 canExecute 选择；repair 每次冲突前重新从 canRepair 选择。

### 3.3 Schedule

full plan task 增加 `priority: critical | high | normal` 和 `splittable: boolean`。Schedule 保存 runnableTasks、deferredTasks、quota snapshot、profiles 和 diagnostics。LLM 的 preferredAgent 只是建议，本地 selector 是最终分配权威。

## 4. 执行算法

1. 分析前服务器刷新 quota，建立 role profiles 与 capacity envelope。
2. planning 获取全局 lease，输出 full plan；归一化 planning 事件和 usage 写入审计记录。
3. 规划结束后刷新 quota，本地 selector 计算当前依赖闭合 batch。
4. 用户确认 immutable full-plan fingerprint。
5. start 时刷新 quota、重新选择 batch并原子预订当前 wave。
6. 创建 integration worktree；读取 integration HEAD；从该 SHA 创建 wave task worktree。
7. task 获取 execution lease，执行、验证、提交并进入 integrating。
8. 按稳定顺序把成功提交集成；冲突前刷新 quota、选择 repair agent、获取 repair lease。
9. 集成成功才标记 completed；更新 integration HEAD 后释放 wave reservation。
10. 继续下一 wave，或进入 partial_completed、waiting_quota、unschedulable、failed、cancelled、interrupted、completed。
11. 最终 completed 只在 full plan 全部完成且最终 integration 验证成功后产生。

## 5. 失败语义

- task 失败：它的依赖任务 blocked；本波停止启动新任务；已经成功集成的提交保留在 result branch。
- conflict repair 失败：abort cherry-pick，保留前序结果，不把失败 commit 标记 completed。
- quota stale/下降：不启动新 Agent，释放当前未使用 reservation，进入 waiting_quota。
- cancel：停止新 wave，取消 waiter/process，释放 lease/reservation；已集成结果不回滚。
- shutdown：终止 planning/execution/repair，拒绝 waiter，非终态 run 恢复为 interrupted 且只读。
- unschedulable：只用于结构上不可能运行的不可拆 task，不伪装成“等待重置即可”。

## 6. 持久化、旧 run 迁移和兼容

V2 run 写入 `schemaVersion: 2`。读取时先判版本：

- 无版本：使用冻结 legacy strict schema 解析，再迁移 priority/splittable、quota/schedule/planning 默认值；
- 版本 2：V2 strict parse；
- 未知未来版本：fail closed；
- malformed：保留现有 quarantine；
- 合法 legacy 不能被 quarantine。

immutable fingerprint 覆盖仓库 identity、prompt 和 full plan，不覆盖会变化的 quota 或 schedule。continue 不能更改任务 title、description、priority、splittable、dependsOn、expectedFiles、验收条件或命令。

## 7. 安全边界

V2 不降低以下既有约束：loopback + capability、常量时间 capability 比较、绝对 binary + shell false、最小环境、每 Agent 私有 auth symlink、日志脱敏、用户确认后的闭合验证命令、unsafe Git config/filter/Agent config 拒绝、canonical worktree 登记、用户 checkout 不写、结果只在 `balance/run-*-result` 分支。

## 8. UI

Agent 卡显示 CLI、官方剩余和时间、重置、L3 风险、executionUnits、三角色、其他 run reservation 和排除原因。任务列表永远遍历 full plan，显示 priority、size、splittable、依赖、文件、验收、assigned agent、本批/延后、原因和 eligibleAfter。操作包含“按当前额度执行”“刷新额度并继续”“重新分析或调整目标”。

## 9. 原规格验收矩阵

| 编号 | 不变量或验收行为 | 实现步骤 | 自动测试 | 运行时证据 |
| --- | --- | --- | --- | --- |
| O01 | 导航包含调度且旧插件功能归设置 | 11B | UI contract | 浏览器设置与调度截图 |
| O02 | 仅 Claude/Codex/Grok，无 Gemini | 11B | runtime/UI tests | 桌面设置截图 |
| O03 | 选择干净 Git 仓库并生成 strict plan | 8,12A | planner/fake E2E | 分析草案截图 |
| O04 | 自动/手动负责人符合角色准入 | 5B | capacity tests | Agent profile 面板 |
| O05 | 用户确认前无写 worktree/命令 | 10B | scheduler tests | fake E2E event log |
| O06 | 独立 worktree 与统一事件 | 2A,2B,6 | git/scheduler tests | desktop event timeline |
| O07 | 绝对 CLI、shell false、安全参数 | 12B | adapters/process tests | debug app E2E log |
| O08 | 验证后提交，失败不集成 | 2B | scheduler/git tests | result branch history |
| O09 | 依赖/冲突串并行，每 Agent 1 | 2B,3B,9 | scheduler/lease tests | concurrency evidence |
| O10 | 用户 checkout 不变，独立结果分支 | 2A,10B | git/fake E2E | HEAD 与 result SHA |
| O11 | 取消进程树且不启动新任务 | 3B,7B | process/scheduler tests | cancellation artifact |
| O12 | 重启恢复 interrupted 且不续跑 | 10A,10B | run-store/desktop E2E | restart screenshot |
| O13 | 0700/0600 且日志脱敏 | 6,12B | store/process tests | permission/log evidence |
| O14 | 非 loopback/capability 错误拒绝 | 11A | actions/guard tests | rejected request evidence |
| O15 | 单元、类型、构建、Git/fake E2E | 12D | full suite | command transcript |
| O16 | 真实 CLI 安全 smoke 或明确跳过 | 12D | bounded smoke | smoke report |
| O17 | 真实桌面主路径和零阻断错误 | 12B | desktop E2E | screenshots/console log |
| O18 | 关闭/取消/退出/重启生命周期 | 12B | desktop E2E | four lifecycle artifacts |

## 10. Scheduler V2 验收矩阵

| 编号 | 不变量或验收行为 | 实现步骤 | 自动测试 | 运行时证据 |
| --- | --- | --- | --- | --- |
| V01 | Codex76/Claude0/Grok5 可运行 large | 5B,9 | capacity/selector tests | partial plan screenshot |
| V02 | 官方76、L3 50仍按官方容量 | 5B | capacity tests | quota diagnostics |
| V03 | B 实际读取 A 已集成代码 | 2A,2B | git/scheduler semantic test | result Git history |
| V04 | 跨 run Codex 实际并发不超过1 | 3A,3B | lease/supervisor tests | concurrency counter |
| V05 | 39/6 保留 full plan并延后其余 | 9,11B | selector/browser E2E | full/active/deferred UI |
| V06 | start 额度下降重新调度或等待 | 7A,10B | freshness tests | waiting screenshot |
| V07 | 刷新继续不重做 completed | 10B,11A | continue tests | branch history |
| V08 | 非零低额度可 planning-only | 5B | capacity tests | Agent role UI |
| V09 | 官方0不参与自动角色 | 5B | capacity tests | exclusion UI |
| V10 | 不可拆过大进入 unschedulable | 9,10A | selector/state tests | unschedulable UI |
| V11 | 可拆 large 最多一次局部修复 | 9 | planner tests | bounded repair event |
| V12 | waiting/partial 始终显示 full plan | 11B | UI/Playwright tests | status screenshots |
| V13 | 旧 run 兼容读取 | 10A | migration fixtures | legacy run view |
| V14 | cancel/shutdown 清空资源 | 3B,7B | lifecycle tests | manager snapshots |
| V15 | SIGTERM 默认全套稳定 | 4,12D | watchdog/full suite | test transcript |
| V16 | checkout/main/remote 不自动修改 | 2A,12F | Git assertions | SHA comparison |
| V17 | 结果只在独立 result 分支 | 2B,10B | git/E2E | result branch name |
| V18 | capability/auth/Git/verification 安全不退化 | 12B | security regression | security transcript |

## 11. 非目标

- 合并或推送 main；
- 自动创建 PR、部署或把结果应用到用户当前 checkout；
- 供应商真实 quota 锁定；
- Gemini；
- 背景定时自动续跑；
- 容器或虚拟机级强隔离。
