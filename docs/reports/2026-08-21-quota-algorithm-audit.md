# 订阅额度算法审计报告（2026-08-21）

状态：调研完成，修复计划见 `docs/plans/2026-08-21-quota-algorithm-optimization.md`
方法：14 个并行 agent（3 研究员 + 5 维度分析员 + 6 对抗验证员），36 条原始发现 → 去重 25 条 → top 6 经对抗验证（5 CONFIRMED / 1 PARTIAL）。
原始资料：`2026-08-21-quota-algorithm-audit-raw.json`（全部发现、验证 verdict、研究员 key facts 与 URL）；
数值模拟与基准脚本：`2026-08-21-quota-algorithm-audit-sims/`（均直接 import 仓库真实导出函数运行，可复现）。

> **基线备注**：审计进行期间，工作区曾短暂处于「synq 品牌」的未提交 WIP 状态（`PRICING_VERSION = "2026-08-20-synq-3"`、组件目录 `src/components/synq/`），随后被还原到 HEAD `e02f486`（Balance 品牌，`PRICING_VERSION = "2026-08-21-balance-1"`、`src/components/balance/`）。本报告与 raw json 中的 synq 字面量按此映射理解；`src/lib/quota/` 下的算法代码与行号引用在两个状态间一致，已经对抗复核员按 Balance 现状逐一重验。

## 1. 总体结论

算法骨架正确且无先例可抄：调研 ccusage、sub2api、Claude-Code-Usage-Monitor、CodexBar 等同类项目，无一实现 synq 式「同窗差分 usdPerPct 校准」；唯一同思路公开实验（claudecodecamp 反推 Claude Code 限额）证实核心前提「配额消耗 ≈ API 等价美元近似线性」。同窗差分本质是比率估计量（ratio-of-sums）的稳健化，Δpct 加权恰好抵消 1/Δpct 的 Jensen 偏置。

三类真实缺陷（均经对抗验证 + 数值模拟确认）：

1. 差分管线对「小数百分比 + 高频采样」近乎失活（Grok 确定受害，Codex wham 可用时受害）。
2. 陈旧官方数据与实时金额错位配对，系统性污染采样并误触发降级。
3. 若干官方语义假设已过时（Claude 5h 窗口不平铺、Codex fast 打破 25 credits/USD、seven_day_sonnet 池未解析等）。

另有性能问题：启动冷扫 + 历史重放实测冻结主线程约 4 秒，稳态每 2.5s 大量无效重算。

## 2. 已验证发现（6 条）

| # | 判定 | 位置 | 问题 |
| --- | --- | --- | --- |
| V1 | CONFIRMED (high/statistical) | `src/lib/quota/quota-value.ts:276` | `dPct < 1` 的相邻采样对被整段丢弃且不链式合并。小数百分比（Codex used_percent 为 f64、Grok creditUsagePercent 带小数）+ ~30s 有效刷新下，模拟 0.1% 步长、覆盖 30% 消耗的 300 个采样产出 0 条斜率，L2/L3 恒 none；Grok 日志回放路径约 41% Δpct 信息被丢。修法：锚点链式差分（累积到 Δpct≥1 再发射，遇 coverage/external/reset 断链）。 |
| V2 | CONFIRMED (high/bug) | `src/lib/quota/quota-value.ts:506-514` | `samplesFromOfficial` 用 wall-clock now 截取事件但百分比来自 `slice.fetchedAt`，且不检查 `windowStale/weekStale`。Claude OAuth /usage 强 429 退避（最长 1h）期间陈旧 pct 配上实时增长的累计金额：模拟显示平台样本金额被固化抬高、差分斜率 9 倍膨胀/压低、cheap 门误触发、置信度逐级劣化。对照组 `samplesFromOfficialHistory` 用 fetchedAt 对齐是正确的。 |
| V3 | CONFIRMED (high→实际 medium/bug) | `src/lib/quota/quota-value.ts:508` | 陈旧切片被 `advanceWindow` 平铺前滚成当前窗口幻影样本（timestampMs 早于窗口 start），`normalizeWindowSamples` 单调过滤在持久层把低于幻影值的真实样本永久拒收（模拟：26h 前 pct=63 入库后，pct 2~10 真实样本全灭）。Codex 无 auth.json（日志唯一来源，默认形态）长期可触发；Claude OAuth 退避跨 5h reset 同样触发。文档 §18「官方成功刷新才生成样本」被违反。 |
| V4 | CONFIRMED (high/performance) | `src/lib/quota/quota-value.ts:480` | 历史重放 O(H×E)：本机实测 codex 历史切片 H=6,852（codex-log.server.ts 去重 key 含 fetchedAt 几乎不去重）× 20k 事件 = 1.8s 主线程冻结，只产出 49 个采样（98% 算力浪费）。参照 Grok floor(pct) 折叠先例 15 行改动即降到 186ms 且输出逐字节相同。另叠加启动冷全扫 2.2s + 6.5MB serverFn 载荷（cursor/realEvents 不持久化）。 |
| V5 | PARTIAL (medium/statistical) | `src/lib/quota/quota-value.ts:397` | ±15% 最小误差带不随信息量缩放。整数取整误差上界 ~±1/ΣΔpct：爆发烧量（<1.5h 耗尽 5h 窗）下 low 档区间覆盖率实测 64~70%；但 app 常开 + 正常烧速时平台保留机制让样本贴齐整数边界，覆盖率 94~100%——边角性质问题。修法（已实测）：`band = max(band, 1/sumPct)`，low 档覆盖 69%→91%。 |
| V6 | CONFIRMED (medium/statistical) | `src/lib/quota/quota-value.ts:361` | MAD 过滤用无权中位数做中心，点估计用 Δpct 加权中位数，两个「中心」矛盾。模拟：8 条 (w=1,v=0.20) 噪声 + 2 条 (w=10,v=0.50) 准确斜率 → 高权重被整批误杀，点估计 $20（一致估计 ≈$46）且置信度仍 medium。cheap 门用同一被污染中心，在其该防的「部分外部用量」场景下永不触发。修法：加权 MAD + 双中心分歧守卫 + cheap 片段按文档 §12.2 真正剔除。 |

## 3. 官方语义核实（外部资料研究员）

价格快照 `2026-08-20-synq-3` 与三家现价逐项一致（Sonnet 5 $2/$10 已转长期价、Codex 7/30 降价后价、272k/200k 长上下文倍率均对）。以下假设已过时或有缺口：

| 假设 | 状态 | 要点 |
| --- | --- | --- |
| Claude 5h 窗口平铺推进 | 已过时 | 官方语义是「从首条消息启动」，不平铺；`advanceWindow`/`slicesFromClaudeHistory` 的固定推进在闲置后必然错切窗口。7d 周池是账户固定 cadence，平铺仍成立。 |
| Codex 25 credits/USD 统一费率（漂移门控豁免依据） | fast 模式下不成立 | 官方 rate card：/fast 按 ×2.5（GPT-5.6/5.5）/×2（GPT-5.4）credits 计费且模型名不变；Claude fast 亦有 ×6（opus-4-6/4-7）/×2 倍率（ccusage fast-multiplier-overrides.json）。 |
| Codex cache write 计价 | 官方明文免费 | `pricing-data.ts` 的 perM 默认给所有模型伪造 input×1.25/×2 写缓存价，Codex/Grok 均不应有此费项。 |
| Grok costUsdTicks 换算不可证实 | 已过时 | ccusage 对 Grok CLI 1.0.0 的 58 个 turn 实证 1 tick = 1e-10 USD；且 turn_completed 聚合多请求，用整 turn contextTokens 判长上下文（synq 现状）会系统性高估最高 2 倍。 |
| OAuth /usage 只有 five_hour/seven_day | 有缺口 | 实际还返回 seven_day_sonnet / seven_day_opus / extra_usage（used_credits 美元口径 + 小数 utilization）；文档 §13.3 承诺的 Sonnet 池未落地；extra_usage 是唯一官方美元数据，overage 阶段 usdPerPct=monthly_limit/100 解析式已知。 |
| Codex session 日志无绝对 reset 时间 | 有缺口 | 日志携带 `resets_in_seconds`（+行级 timestamp 可反推），但 `official.ts` 只读 `reset_at??resets_at` → wham 429/离线时 Codex 永远 rolling，L2/L3 永不出现。 |
| 价格表覆盖面 | 缺口 | 缺 GPT-5.5、GPT-5.4-mini、Daybreak Blue/Red、grok-4.3/4.20 等在售模型（价格可由 rate card ÷25 精确反推）；dated 别名只登记了 3 个。 |
| 百分比单调上升 | 已过时 | 长期 canary 实测 Anthropic 有补偿性 reset（中窗 used% 大幅下降而 resets_at 不变）；现实现静默丢样后跨不连续点畸形斜率模拟高估 17 倍。 |
| Claude 数据源 | 更优方案存在 | OAuth /usage 被强 429（retry-after:0）；Claude Code ≥1.2.80 每回合向 statusline stdin 注入 rate_limits（used_percentage + epoch resets_at，无需网络），claude-powerline 等均以此为首选。 |

关键来源（完整列表见 raw json）：

- https://help.openai.com/en/articles/20001106-codex-rate-card （Codex credit 牌价 = API 价 ×25、cache write 免费、fast 倍率）
- https://learn.chatgpt.com/docs/pricing （Codex 逐模型 credits）
- https://platform.claude.com/docs/en/about-claude/pricing 、 https://docs.x.ai/developers/pricing （价格核对）
- https://support.claude.com/en/articles/11049741-what-is-the-max-plan （5h 窗口从首条消息启动）
- https://github.com/anthropics/claude-code/issues/31637 （OAuth /usage 强 429）
- https://ccusage.com/guide/grok/ （Grok ticks=1e-10 USD 实证、turn 聚合陷阱）
- https://www.claudecodecamp.com/p/i-tried-to-reverse-engineer-claude-code-s-usage-limits （5h 预算中位 $164/周 $1,378，quota≈API 美元线性）
- https://ajin.im/is/building/did-claude-just-reset-usage/ （补偿性 reset 三种模式）
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs （RateLimitSnapshot：used_percent f64、resets_in_seconds）

## 4. 统计文献结论（要点）

- Theil-Sen（全对斜率中位数）崩溃点 29.3%、渐近效率高；Siegel repeated median 崩溃点 50%。n≤128 时 O(n²) 直接可行。但全对配对必须先按可疑台阶分段——朴素全对在 +4% 外部台阶下偏差 -31%（比现状 -20% 更差），分段后 -1.1%。蒙特卡洛（4000 reps/场景）：分段全对 Theil-Sen 比现管线 RMSE 低 2~7 倍。
- Sen 斜率的分布自由 CI 由配对斜率次序统计量构造（Gilbert 1987），随数据量收缩且有名义覆盖率；n<20 不要用 percentile bootstrap（Hesterberg 2015：小样本严重欠覆盖）。
- 取整量化误差与原变量不独立，经典 EIV 修正需重复测量数据（synq 没有）；更适合区间删失建模或长基线配对摊薄。
- 相邻差分共享端点 → 误差负相关 MA(1)，不能当独立样本做离散度/MAD 推断；单个坏采样同时拉偏两条斜率。
- James-Stein/层级部分池化是小样本冷启动标准解：跨窗只池化「窗口级点估计」（非原始样本）不违反禁混样条款。

## 5. 未验证发现（19 条，按类别）

以下未经对抗验证，置信度低于第 2 节，落地前需先复核（计划中每条对应 step 已内置复核）：

**统计/设计**：weightedMedian 下偏（等权偶数取低值，quota-value.ts:209）；跨窗先验解决冷启动（8 窗历史保留却零消费，quota-value.ts:550）；windowId 60s 四舍五入半分钟边界翻转致窗口分裂（quota-value.ts:73）；历史回放与实时路径锚点不一致致回填样本白做（official.ts:183）；20k 事件截断致周窗 cumUsd 回退、斜率压低（store.ts:103）；cheap 检测缺「模型组合变便宜」核对（quota-value.ts:380）；同窗百分比下降被静默丢弃而非按文档开新校准段（quota-value.ts:304）；slice(1,-1) 无条件裁剪首尾（quota-value.ts:343）。

**计价 fail-closed**：缺模型信息静默按旗舰模型计价（claude-jsonl.ts:109、codex-log.server.ts:157、grok-log.server.ts:175、parse.ts:42）；dated Sonnet 4.6 落 family-fallback 低估 33%（pricing-data.ts:117 别名漏配）；perM 给 Grok/Codex 伪造 cache-write 价（pricing-data.ts:42）；image token 全链路缺失且 coverage 不降（cost.ts:55）；claude parseTs 死三元（数值秒漏乘 1000，claude-jsonl.ts:35）；负数/NaN 静默 clamp、cachedExceedsInput 标志被丢弃（tokens.ts:2）。

**性能**：每 2.5s 两遍全树遍历 + 逐文件 statSync（claude-log.server.ts:177，1,724 文件实测 32ms/次）；官方本地文件每 2.5s 全量读（official.server.ts:689）；ingest 零新事件仍重建重排 20k 数组击穿前端 memo（store.ts:367）；costBreakdown 无 per-event 缓存（cost.ts:19，每周期 10+ 次重复计价）；启动冷全扫 2.2s + 6.5MB 载荷（claude-log.server.ts:190，cursor/realEvents 不持久化）。

**官方数据（来自研究员 ideas，可信度高）**：seven_day_sonnet/opus/extra_usage 未解析；resets_in_seconds 未支持；Grok ticks 版本化验证可落地；Grok 长上下文 turn 聚合误判；fast/speed 档位未建模；Grok legacy 月度 credits 周期被误标 weekly 窗（official.ts:304）。

## 6. 各维度总体评价（分析员原文摘要）

- **统计**：设计认真——同窗差分、Δpct 加权、fail-closed 都对；缺陷集中在配对方式与区间构造，修复成本都不高。
- **正确性**：与文档高度一致；两类系统性缺口是采样时间对齐与差分管线对非理想输入的韧性。
- **计价**：核心语义扎实（互斥扣除、5m/1h 拆分、ticks 只存不换算都对）；问题集中在 fail-closed 边界被默认值/别名漏配打穿。
- **采样**：隐私承诺经核实成立（不存 token/账户/prompt/cwd）；「同百分比不重复保存」已实现；高危是幻影样本与小数百分比斜率全灭。
- **性能**：算法本身克制、增量机制方向对；短板全在「重放/重算」维度，均有本机基准实测。
