# Antigravity CLI 本机逐模型用量规格

日期：2026-08-25  
状态：已实现  
关联规格：`docs/specs/2026-08-25-antigravity-cli-quota.md`

## 目标

在保留 Antigravity 官方 Gemini、Claude/GPT 两组额度百分比的同时，从本机 `agy` 会话数据库读取真实模型调用用量，并按具体模型分别显示 token 与公开 API 价格等价金额。

## 数据源与可信边界

1. 账户总余量继续以 `retrieveUserQuotaSummary` 返回的两组 5 小时/每周百分比为准。
2. 本机逐请求用量来自 `~/.gemini/antigravity-cli/conversations/*.db`：
   - `steps.metadata` 是 protobuf；顶层 field 1 为调用时间，field 9 为 `ModelUsageStats`。
   - `ModelUsageStats` field 1/2/3/4/5/9/10 分别为模型枚举、输入、输出总量、缓存写入、缓存读取、思考输出、正文输出。
   - `executor_metadata.data` 顶层 field 10 → field 1 的模型配置中，field 1 是模型枚举，field 28 是动态模型 ID。
3. 2026-08-25 真机数据库核验补充（4 库 549 行、268 条用量行）：
   - 只有携带 field 9 的行才是用量行（实测均为 `step_type=15`）；实现以 field 9 存在性为准，不依赖 `step_type`。
   - field 3 输出总量在全部样本中恒等于 field 9 + field 10；field 4（缓存写入）在真实数据中从未出现，解析时保留该字段但不得假设其存在。
   - `ModelUsageStats` 另含规格外字段 field 6（常量）、field 7（后端 bot UUID）、field 8（嵌套会话元数据，含 sessionID）、field 11（追踪 ID）；这些字段一律丢弃，不得进入 DTO、日志或前端。
4. 只向浏览器返回时间、模型 ID、调用次数和 token 数；逐请求 DTO 不包含 ID。不得返回会话 ID、Prompt、回复正文、工具参数、文件路径、OAuth token、由路径派生的哈希或原始 protobuf。
5. 本机记录不等于账户完整账单：已删除会话、桌面 IDE、其他电脑或其他账号产生的用量可能不在当前 CLI 数据库中。界面必须明确标注“本机记录”。

## 逐请求模型

每条可解析调用至少包含：

- `ts`
- `model`
- `quotaGroup`：Gemini 模型归入 `gemini`，Claude/GPT-OSS 归入 `claude-gpt`
- `tokensIn`
- `tokensOut`：包含思考与正文，不再重复叠加 `thinkingTokens`
- `thinkingTokens`
- `responseTokens`
- `cacheRead`
- `cacheWrite`

未知模型枚举不得丢弃 token；以 `unknown-<enum>` 显示并禁止计价。

## 计价规则

计价按每次调用的具体模型独立完成，再汇总到模型和额度组，禁止先合并 token 后套一个统一单价。

### Gemini

- Gemini 3.7 Flash 与 3.6 Flash：2026-12-31 前输入 `$0.75/M`、输出含思考 `$3.75/M`、缓存读取 `$0.075/M`；2027-01-01 起分别为 `$1.50/M`、`$7.50/M`、`$0.15/M`。
- Gemini 3.5 Flash：输入 `$1.50/M`、输出含思考 `$9.00/M`、缓存读取 `$0.15/M`。
- Gemini 3.1 Pro：单次上下文 `tokensIn + cacheRead + cacheWrite` 不超过 200K 时输入 `$2.00/M`、输出 `$12.00/M`、缓存读取 `$0.20/M`；超过 200K 时分别为 `$4.00/M`、`$18.00/M`、`$0.40/M`。
- High/Medium/Low 只改变思考强度，不改变同一基础模型的单位价格。
- 金额标记为“Google API 等价”。

### Claude

- Claude Sonnet 4.6：输入 `$3/M`、输出含思考 `$15/M`、缓存读取 `$0.30/M`。
- Claude Opus 4.6：输入 `$5/M`、输出含思考 `$25/M`、缓存读取 `$0.50/M`。
- 金额标记为“Anthropic 公价估算”，不得称为 Antigravity 内部扣费。

### GPT-OSS 与缓存写入

- GPT-OSS 120B 没有 OpenAI 官方 API 单价，只显示 token 与调用次数，金额显示“无官方单价”。
- 当前 protobuf 没有缓存 TTL；`cacheWrite > 0` 时不对这部分 token 计价，并把金额显示为下限值 `≥ $x`。
- 未识别模型同样不计价。

## 界面行为

### 简约模式

- 继续分开显示“Gemini 模型”和“Claude / GPT 模型”两组官方剩余额度。
- 每组增加本机本周 token、模型数量/调用次数及可计价金额。
- 金额必须由该组内每个模型分别计价后相加；存在无价 token 时显示下限符号或“无官方单价”。

### 极客模式

- 保留四个官方额度池。
- 增加本机 5 小时 token、本周 token、本周调用次数、本周 API 等价金额。
- 按模型逐行显示输入、缓存读取、输出、思考、调用次数和金额语义。
- 不把 Antigravity 本机 token 混入官方百分比，也不据此反推订阅总金额。

### 设置与图表

- 设置页仍不伪造 Antigravity Free/Pro/Ultra 套餐；官方未返回套餐层级时继续显示自动读取。
- 本次不把 Antigravity 加入 Claude/Grok/Codex 的时间线和通用用量报告；Antigravity 卡片内提供独立明细。

## 运行时与安全

- 使用桌面 sidecar 已固定的 Node `v22.23.2` 内置 `node:sqlite`，以 `new DatabaseSync(path, { readOnly: true })` 读取；不得依赖系统 `sqlite3` CLI。
- 只扫描 `~/.gemini/antigravity-cli/conversations` 下的普通 `*.db` 文件；单文件错误、锁定、损坏或未知 schema 必须跳过，不能让其他 provider 刷新失败。
- 对目录项先 `lstat`，拒绝符号链接；规范化后的数据库路径必须仍是 conversations 目录的直接子文件。
- protobuf 解码必须有长度、字段数、varint 和安全整数上限；畸形数据不得抛到页面。
- 扫描必须限制数据库数、单库读取行数和单次返回事件数；达到上限时返回 `truncated: true`，界面明确提示本机记录受扫描上限限制。
- Dashboard 最多每 30 秒触发一次 Antigravity 本机扫描，2.5 秒 UI 刷新不得反复全量读取 SQLite。
- 活跃数据库的 WAL 由 SQLite 自己只读合并，不复制或修改 `.db`、`.db-wal`、`.db-shm`。

## 验收

1. 脱敏 SQLite fixture 能解出时间、模型映射及输入/输出/思考/缓存 token；畸形 protobuf、超限行数、符号链接、未知模型和损坏数据库 fail closed，活跃 WAL 可只读解析。
2. 同一时间窗内多个 Gemini、Claude、GPT-OSS 模型保持独立行，并按各自单价/语义计算。
3. 简约模式两组各自显示官方剩余和本机本周用量；极客模式显示四个官方池与逐模型明细。
4. 本机真实 `agy` 数据能在页面显示，数值与只读数据库探针一致；浏览器控制台无错误，接口响应只含白名单字段，不含 ID、凭据、Prompt、回复正文、本地路径或路径哈希。
5. `npm test`、`npm run typecheck`、`npm run build` 与 Antigravity 浏览器 E2E 全部通过。
