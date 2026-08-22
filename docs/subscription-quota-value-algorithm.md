# 订阅配额 API 等价金额算法

状态：已实现（2026-08-20）
适用项目：余量 / Balance
覆盖范围：Claude Code、Grok、Codex 订阅额度与本地 JSONL 用量
参考实现：`sub2api` 项目的模型计价与窗口统计思路

当前实现使用 `PRICING_VERSION = 2026-08-21-balance-1`。Claude 同时计算 5h 与 7d 窗口，Grok 计算官方共享周池，Codex 保持官方主窗口并额外提供公开 rate card 的 credit 等价。三者的美元结果都是 API 等价金额；只有 Codex 产生 credit 等价，Claude/Grok 不借用 OpenAI credit 单位。

## 1. 目标

余量已能获得两类真实数据：

1. 供应商给出的官方订阅利用率，例如 Claude 5h/7d、Grok 周额度、Codex 5h/7d。
2. 本机 Agent 日志中的模型、输入 token、输出 token、缓存 token 和时间戳。

本算法将两者组合，提供三层结果：

| 层级 | 输出 | 性质 |
| --- | --- | --- |
| L1 | 当前窗口已消耗的 API 等价金额 | 可直接计算 |
| L2 | 整个订阅窗口的 API 等价价值区间 | 基于连续采样估算 |
| L3 | 当前剩余额度的 API 等价价值区间 | 基于连续采样估算 |

这里的“金额”统一指：**如果用公开 API 完成相同模型和 token 组合，理论上需要支付的美元金额**。

它不是供应商账户余额，也不是可以退款、转移或提现的金额。

## 2. 非目标

本算法不做以下承诺：

- 不把订阅月费按百分比简单切分。例如 ChatGPT Pro 周额度剩余 42%，不等于月费还剩 42%。
- 不声称供应商内部 quota credit 与公开 API 价格线性对应。
- 不把缺失的其他设备、网页端或远程机器用量伪装成本机已观测用量。
- 不给未知模型套用任意“看起来相近”的价格后再标成精确值。
- 不把不同窗口、不同产品池或 reset 前后的样本混在一起校准。

## 3. 名词与金额口径

### 3.1 官方利用率

记当前官方已用百分比为：

```text
u ∈ [0, 100]
```

官方利用率只负责回答“额度用了多少”，不直接参与单次请求计价。

### 3.2 API 等价金额

对请求事件 `e`，API 等价金额为：

```text
cost(e) = inputCost
        + outputCost
        + cacheReadCost
        + cacheWriteCost
        + imageCost
```

同一窗口内的已观测金额为：

```text
observedUsd(window) = Σ cost(e), e ∈ window
```

### 3.3 订阅价格

套餐月费独立保存为 `subscriptionPriceUsd`，只用于 ROI 或成本回收展示：

```text
roi = monthlyApiEquivalentUsd / subscriptionPriceUsd
```

套餐月费不得参与窗口剩余金额计算。

## 4. 总体数据流

```text
Agent JSONL
  → 去重
  → token 语义归一化
  → 精确模型解析
  → 价格解析
  → 单事件 CostBreakdown
  → 按官方窗口聚合
  → L1 已用 API 等价金额

官方 quota API / 本地官方历史
  → 利用率、窗口开始/结束时间
  → 与累计 CostBreakdown 组成 QuotaSample
  → 同窗口差分校准
  → L2/L3 金额区间与置信度
```

官方百分比和本地金额必须分别保留来源。不能让本地 token 推导值覆盖官方百分比。

## 5. 建议数据模型

### 5.1 归一化用量事件

```ts
interface NormalizedUsageEvent {
  id: string;
  agent: "claude" | "grok" | "codex";
  timestampMs: number;
  sessionId: string;

  // 用于展示的模型族，以及用于价格查询的原始模型名。
  modelFamily: string;
  modelRaw: string;

  // 所有字段均为互斥口径，不能重复包含。
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;

  serviceTier: "standard" | "priority" | "flex" | "unknown";
  source: "claude-jsonl" | "grok-jsonl" | "codex-jsonl" | "import";

  // 供应商客户端直接上报的金额类字段；不得与 API 等价金额混用。
  reportedCost: ProviderReportedCost | null;
}

interface ProviderReportedCost {
  totalRawValue: number;
  byModelRawValue: Record<string, number>;
  rawUnit: "usd-ticks" | "usd" | "unknown";
  usdValue: number | null;
  divisor: number | null;
  sourceField: string;
  schemaVersion: string | null;
  semantics: "unverified" | "api-equivalent" | "provider-internal";
}
```

约束：

- token 必须是有限非负整数。
- `id` 必须能跨重复扫描稳定去重。
- `modelRaw` 不得只保留 `opus`、`sonnet` 等模型族。
- 当日志没有某字段时填 0，不得通过总 token 反向猜测缓存类型。
- 金额类原始字段必须原样保存；换算比例和语义未验证时，`usdValue` 必须为 `null`。

### 5.2 模型价格

```ts
interface ModelPricing {
  model: string;
  source: string;
  version: string;
  effectiveAt: number | null;

  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheWrite5mPerToken: number;
  cacheWrite1hPerToken: number;
  imageInputPerToken: number;
  imageOutputPerToken: number;

  priorityInputPerToken: number | null;
  priorityOutputPerToken: number | null;
  priorityCacheReadPerToken: number | null;

  longContextThreshold: number | null;
  longContextInputMultiplier: number;
  longContextOutputMultiplier: number;
}
```

### 5.3 单事件成本明细

```ts
interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  imageUsd: number;
  totalUsd: number;

  pricingModel: string | null;
  pricingVersion: string | null;
  pricingQuality: "exact" | "family-fallback" | "unknown";
}
```

`CostBreakdown` 只表示按公开价格重算的 API 等价金额。`ProviderReportedCost` 是独立证据，二者不得共享 `totalUsd` 字段或互相静默覆盖。

### 5.4 官方窗口

```ts
interface OfficialQuotaWindow {
  agent: "claude" | "grok" | "codex";
  kind: "five_hour" | "weekly" | "product";
  product: string | null;
  usedPercent: number;
  startsAt: number | null;
  resetsAt: number | null;
  fetchedAt: number;
  source: string;
}
```

### 5.5 校准采样

```ts
interface QuotaSample {
  windowId: string;
  agent: "claude" | "grok" | "codex";
  product: string | null;
  timestampMs: number;
  usedPercent: number;
  cumulativeObservedUsd: number;
  pricedTokenCoverage: number;
  modelMix: Record<string, number>;
  pricingVersion: string;
}
```

## 6. Token 归一化

### 6.1 Claude

Anthropic 日志中的字段通常已经互斥：

```text
uncachedInputTokens = input_tokens
cacheReadTokens     = cache_read_input_tokens
cacheWrite5mTokens  = cache_creation.ephemeral_5m_input_tokens
cacheWrite1hTokens  = cache_creation.ephemeral_1h_input_tokens
outputTokens        = output_tokens
```

如果只有 `cache_creation_input_tokens` 总数而没有 5m/1h 明细：

- 将总数按公开 5m cache-write 价格计入 L1，因此该金额是保守下界；
- 该部分 token 不计入 `pricedTokenCoverage`，避免把无法区分 5m/1h 的写入标成精确覆盖；
- coverage 低于展示阈值时，UI 按“价格覆盖不足”或 `≥ $X` 降级，不产生伪精确金额。

### 6.2 Codex / OpenAI

OpenAI 风格的 `input_tokens` 包含 `cached_input_tokens`，必须先去重：

```text
cacheReadTokens = max(cached_input_tokens, 0)
uncachedInputTokens = max(input_tokens - cacheReadTokens, 0)
```

不得使用下面的错误公式：

```text
input_tokens × inputPrice + cached_input_tokens × cachePrice
```

因为它会让 cached token 同时按完整输入价和缓存价计费。

### 6.3 Grok

Grok CLI 的 Responses/OpenAI 兼容字段按 Codex 规则处理：

```text
cacheReadTokens = max(cachedReadTokens, 0)
uncachedInputTokens = max(inputTokens - cacheReadTokens, 0)
```

已抽查的真实 Grok `turn_completed` 样本满足：

```text
totalTokens = inputTokens + outputTokens
```

因此在该日志版本中，`cachedReadTokens` 是 `inputTokens` 的子集，必须先扣除再按缓存读取价计费。解析器仍应按日志 schema/version 固化规则，不能把单个样本的观察无条件推广到所有历史版本。

同一事件还可能包含：

```text
costUsdTicks
modelUsage.<model>.costUsdTicks
```

解析器应保存总值以及按模型拆分的原始 ticks，但在查到客户端 schema、常量或可复现实验并确认换算比例前，不得凭字段名猜测 `1 USD = 10^N ticks`。未验证时只把它作为诊断证据，`usdValue = null`。

如果某个 Grok 日志版本明确保证 `inputTokens` 已排除缓存，应在解析器中以版本化规则声明，不能运行时猜测。

### 6.4 原始 token 与计费 token

UI 的“总 token”定义为互斥 token 之和：

```text
rawTokens = uncachedInputTokens
          + outputTokens
          + cacheReadTokens
          + cacheWrite5mTokens
          + cacheWrite1hTokens
          + imageInputTokens
          + imageOutputTokens
```

计费 token 与 quota 百分比仍是两个独立口径。

## 7. 价格解析

### 7.1 查找顺序

```text
1. modelRaw 精确命中
2. 官方别名映射后精确命中
3. 明确登记的版本别名命中
4. 明确登记的模型族 fallback
5. unknown
```

不得使用无约束的字符串模糊匹配把未知模型静默映射到默认模型。

### 7.2 价格数据策略

- 仓库内保存经过校验的精简价格快照，保证构建和离线预览可复现。
- 每条价格记录带 `source/version/effectiveAt`。
- 可选的在线更新只更新内存缓存，不依赖生产运行时文件写入。
- 在线价格无效或字段缺失时继续使用仓库快照。
- 展示金额时提供价格版本或更新时间。
- 实现应独立重写 TypeScript 计价逻辑，不直接复制 LGPL 项目的整套 Go 模块。

### 7.3 历史一致性

同一窗口内应固定价格版本。否则价格表更新会让累计金额在没有新请求时突然变化。

推荐优先级：

1. 事件已保存 `CostBreakdown`：直接使用。
2. 有事件时间对应的历史价格：按事件时间计价。
3. 只有当前价格：允许回算，但将 `pricingQuality` 降级并标记“按当前价格回算”。

### 7.4 当前价格快照

当前仓库快照版本为 `2026-08-21-balance-1`，按供应商公开标准 API 价分别保存 Claude Fable 5、Opus 5/4.x、Sonnet 5、Sonnet 4.6、Haiku 4.5，以及 Grok 4.6、Grok 4.5、grok-build-0.1。别名必须归到同一精确价格键，例如 `grok-4.6-build → grok-4.6`，避免仅因命名不同制造模型组合漂移。

价格与订阅语义的官方校验来源：

- [Anthropic Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [xAI API pricing](https://docs.x.ai/developers/pricing)
- [Grok subscription usage FAQ](https://docs.x.ai/grok/faq)

## 8. 单事件计价公式

### 8.1 标准计价

记：

```text
I  = uncachedInputTokens
O  = outputTokens
R  = cacheReadTokens
W5 = cacheWrite5mTokens
W1 = cacheWrite1hTokens
II = imageInputTokens
IO = imageOutputTokens
```

则：

```text
inputUsd      = I  × inputPerToken
outputUsd     = O  × outputPerToken
cacheReadUsd  = R  × cacheReadPerToken
cacheWriteUsd = W5 × cacheWrite5mPerToken
              + W1 × cacheWrite1hPerToken
imageUsd      = II × imageInputPerToken
              + IO × imageOutputPerToken

totalUsd = inputUsd
         + outputUsd
         + cacheReadUsd
         + cacheWriteUsd
         + imageUsd
```

### 8.2 Service tier

“API 等价金额”默认使用公开 API 标准档价格。

只有日志明确给出 `priority` 或 `flex`，且价格表存在对应档位时，才额外计算 `tierAdjustedUsd`。主 UI 仍展示标准档等价金额，详情页可以展示档位调整金额。

不能把订阅套餐等级误当成 API service tier。

### 8.3 长上下文

上下文规模定义为：

```text
contextTokens = I + R + W5 + W1
```

当精确模型价格声明了长上下文阈值，且 `contextTokens` 超过阈值时：

```text
inputUsd      ×= longContextInputMultiplier
cacheReadUsd  ×= longContextInputMultiplier
cacheWriteUsd ×= longContextInputMultiplier
outputUsd     ×= longContextOutputMultiplier
```

模型没有明确长上下文规则时不应用倍率。

### 8.4 金额来源与数值规则

#### 8.4.1 双账本原则

系统同时保留两种金额，且 UI 和存储字段必须显式区分：

| 金额 | 计算来源 | 用途 |
| --- | --- | --- |
| `apiEquivalentUsd` | 互斥 token × 版本化公开 API 价格 | L1/L2/L3 的统一主口径 |
| `reportedUsd` | 供应商客户端事件直接上报 | 对账、诊断；语义确认后可作为补充展示 |

`reportedUsd` 只有同时满足以下条件时才能生成：

1. 精确日志版本的 ticks 换算比例已由客户端 schema、官方实现或固定输入实验验证；
2. 字段语义已确认是美元 API 成本，而不是内部 quota、遥测权重或订阅 credits；
3. 总字段与逐模型字段在允许的舍入误差内可对账；
4. 验证结论带版本，版本变化后重新验证。

即使 `reportedUsd` 已验证，也不应自动替换 `apiEquivalentUsd`。只有确认其语义就是同一公开 API 标准价口径时，才能把它用于误差校验；否则两者并列展示为“API 等价金额”和“客户端上报成本”。

#### 8.4.2 精度与异常

- 内部统一使用美元浮点数，聚合完成后再格式化。
- 中间过程不得 `toFixed()`。
- 最终 UI 小额至少显示 4 位小数，报表保留 6 至 8 位。
- 任一输入为 `NaN`、负数或无限值时，该事件计价失败并进入 coverage 统计。

## 9. 官方窗口对齐

### 9.1 窗口起点

窗口起点按以下顺序确定：

```text
1. 官方 startsAt
2. 官方 resetsAt - 官方窗口长度
3. 已检测到的最近 reset 时间
4. now - 窗口长度，仅作为 rolling fallback
```

窗口长度：

```text
five_hour = 5h
weekly    = 7d
```

Grok 已有 `weekStartedAt` 时必须优先使用，不能退化为 `now - 7d`。

Claude 的本地官方历史只有利用率采样，需要从 reset 反推锚点：

- 5h 百分比从任意正值下降到 `0` 或 `1` 时，建立新的 5h 起点；
- 7d 百分比从任意正值下降到 `0` 或 `1` 时，建立新的周起点；
- 已有锚点而后续缺少恰好为 0 的采样时，按 5h / 7d 固定周期推进边界；
- 尚未找到对应边界时只允许 rolling L1，禁止生成该窗口的 L2/L3。

### 9.2 事件过滤

```text
windowEnd = min(now, resetsAt ?? now)

eventsInWindow = events.filter(
  e.timestampMs >= windowStart &&
  e.timestampMs <= windowEnd
)
```

采用左闭右闭规则，并通过稳定事件 ID 去重。

### 9.3 Window ID

```text
windowId = agent + ":" + kind + ":" + product + ":" + startsAt + ":" + resetsAt
```

任一 reset、窗口起止变化或产品池变化都产生新 `windowId`。不同 `windowId` 的采样禁止参与同一次校准。

### 9.4 窗口不确定时

如果只能使用 `now - span`：

- 可以展示 L1，并标记“滚动窗口金额”；
- 不进入 L2/L3 高置信度校准；
- 不保存为新窗口的基准样本。

## 10. L1：已用 API 等价金额

对窗口内事件计算：

```text
observedUsd = Σ event.cost.totalUsd
observedTokens = Σ event.rawTokens
```

同时计算可计价事件覆盖率（token/event 双 coverage）：

```text
pricedTokenCoverage = pricedTokens / allObservedTokens
pricedEventCoverage = pricedEvents / allObservedEvents
```

图片 token、未知模型事件和异常 token（NaN/负值/无限）事件计入未覆盖部分，执行 fail-closed 规则：宁可降低覆盖率也不产生伪金额。

推荐展示规则：

| 条件 | 展示 |
| --- | --- |
| token coverage ≥ 95% | `$12.34` |
| 80% ≤ coverage < 95% | `≥ $12.34`，标记部分模型未计价 |
| coverage < 80% | 金额置灰，显示“价格覆盖不足” |
| 无事件 | `$0.00`，但不代表官方额度未使用 |

本机没有事件而官方百分比上升时，应记录 `externalUsageDetected = true`。

## 11. L2/L3：整窗与剩余价值估算

### 11.1 为什么使用差分（锚点链式差分）

校准采用锚点链式差分：每次官方百分比刷新建立锚点，相邻锚点的 `Δpct / Δusd` 构成一条片段链。5h 窗口过期后锚点降为 rolling，不平铺；周窗口 cadence 保留。fetchedAt 对齐确保只比较时序一致的锚点对；stale 候选直接拒绝。

不直接使用：

```text
totalUsd = observedUsd / (usedPercent / 100)
```

原因包括：

- 余量可能在窗口中途启动；
- 官方百分比可能包含其他设备用量；
- 百分比通常经过取整；
- 模型组合可能变化；
- quota credit 可能不是线性 token 单位。

使用同一窗口内两个连续采样点的变化量：

```text
Δpct = sampleB.usedPercent - sampleA.usedPercent
Δusd = sampleB.cumulativeObservedUsd - sampleA.cumulativeObservedUsd
```

有效片段的单位斜率为：

```text
usdPerPct = Δusd / Δpct
```

### 11.2 有效片段条件

采样对必须同时满足：

- `windowId` 相同；
- `Δpct >= 1`；
- `Δusd > 0`；
- 两端 `pricedTokenCoverage >= 0.8`；
- 百分比没有下降；
- 累计金额没有下降；
- 价格版本一致；
- 两点间至少存在一个本地事件；
- 未检测到 reset；
- 未检测到“百分比上涨但本地金额为 0”的外部用量。

只有 1% 变化的片段受百分比取整影响很大，只能用于低置信度估算。

### 11.3 稳健聚合（加权 MAD）

设有效斜率为 `r1...rn`，使用加权 MAD（weighted Median Absolute Deviation）进行离群过滤。cheap 片段（Δpct < 2）不参与 MAD 计算，避免取整噪声污染离散度；动态量化带根据样本数量自动收窄：

```text
m   = weightedMedian(r, weight = Δpct)
mad = weightedMedian(abs(ri - m), weight = Δpct)
```

过滤异常值：

```text
keep ri when abs(ri - m) <= max(3 × mad, 0.25 × m)
```

过滤后计算：

```text
pointUsdPerPct = weightedMedian(ri, weight = Δpct)
lowUsdPerPct   = weightedPercentile(ri, 25%)
highUsdPerPct  = weightedPercentile(ri, 75%)
```

### 11.4 金额推导

当前官方已用百分比为 `u`：

```text
totalPointUsd = pointUsdPerPct × 100
totalLowUsd   = lowUsdPerPct   × 100
totalHighUsd  = highUsdPerPct  × 100

remainingPointUsd = pointUsdPerPct × (100 - u)
remainingLowUsd   = lowUsdPerPct   × (100 - u)
remainingHighUsd  = highUsdPerPct  × (100 - u)
```

区间过窄时仍至少保留以下误差带，以覆盖百分比取整：

```text
minimumRelativeBand = 15%
```

即最终上下界不得窄于点估计的 `±15%`，高置信度且供应商提供小数百分比时可以缩小到 `±10%`。

### 11.5 模型组合漂移

模型组合以 API 金额占比表示。每个相邻样本对先用累计金额与累计模型占比反推出该差分片段的模型组合，再将历史片段与当前片段比较：

```text
modelMixDrift = 0.5 × Σ abs(currentShare(model) - baselineShare(model))
```

取值范围 `[0, 1]`：

- `< 0.15`：稳定；
- `0.15 ~ 0.35`：有变化，扩大金额区间；
- `> 0.35`：该历史片段与当前片段不相容，不参与本次校准；若没有相容片段，只保留 L1。

首个样本可能出现 `cumulativeObservedUsd = 0`、`modelMix = {}`。空组合只是本地日志尚未累计到成本，不能作为漂移基线。这样可避免 Claude/Grok 在窗口首个平台被固定误判为 `0.5` 漂移，同时仍能阻止“当前模型刚切换、尚无同类历史”的错误外推。

### 11.6 置信度

| 等级 | 最低要求 |
| --- | --- |
| none | 无有效片段，或发现 reset/严重外部用量/覆盖率不足 |
| low | 至少 1 个有效片段，累计 `Δpct ≥ 2`，coverage ≥ 80% |
| medium | 至少 3 个有效片段，累计 `Δpct ≥ 5`，coverage ≥ 90%，漂移 ≤ 0.35 |
| high | 至少 6 个有效片段，累计 `Δpct ≥ 15`，coverage ≥ 95%，漂移 < 0.15，斜率离散度 ≤ 20% |

`none` 时 UI 保留窗口位置并显示”样本不足”，不显示伪金额。`low` 可以在主卡展示，但必须同时展示区间和低置信度标签。

### 11.7 历史窗口先验

当同一 agent/kind 的前一个或多个已关闭窗口已完成校准（至少 medium 置信度），其稳健 `usdPerPct` 可作为历史窗口先验（historical window-level low prior）。先验只允许在当前窗口样本不足时提供 `low` 置信度的宽区间参考，不能替代当前窗口的实际差分校准。具体规则：

- 先验仅取最近 8 天内且窗口级别一致的历史窗口；
- 先验 `usdPerPct` 按历史置信度加权平均；
- 当前窗口有 ≥3 有效片段后先验自动失效；
- 先验不得提升当前窗口置信度超过 `low`。

## 12. 跨设备与漏采检测

### 12.1 明确外部用量

若连续官方采样满足：

```text
Δpct > 0 && ΔobservedUsd == 0
```

则该片段标记为外部用量，不进入校准。

### 12.2 部分外部用量

如果同一窗口的 `usdPerPct` 突然显著低于历史中位数，且模型组合没有同步变便宜，应怀疑存在其他设备用量：

```text
usdPerPct < medianUsdPerPct × 0.4
```

该片段作为异常值排除，并降低整个窗口的置信度一级。

### 12.3 无法证明完整覆盖

“本机日志已全部扫描”不等于“订阅所有使用都在本机发生”。UI 必须把覆盖率描述为“本地价格覆盖率”，不能写“账户完整覆盖率”。

## 13. 产品池处理

### 13.1 Grok

Grok 官方订阅额度是共享周池，Grok Build、App Builder、Chat 等字段是该共享池的产品占用构成，不是彼此独立且可相加的额度。

只有本地事件能稳定映射到相同产品名时，才允许分别估算：

```text
GrokBuild events ↔ GrokBuild official percent
```

无法映射时：

- 展示共享周池的官方总百分比，并把各产品百分比标为“产品占用构成”；
- L1 展示本机所有 Grok 事件的合计 API 等价金额；
- 禁止把合计金额除以某一个产品百分比；
- L2/L3 只使用共享周池总百分比与同一周窗口的历史样本。

### 13.2 Codex 附加额度与 extra_usage

Codex `additional_rate_limits` 必须独立成产品窗口。普通 Codex token 不得自动归入 Spark、特殊模型或 credits 池，除非事件模型和官方产品可明确匹配。

Claude 的 `extra_usage`（付费加量包）同理：当官方返回 `extra_usage.used_credits` 和 `extra_usage.monthly_limit` 时，必须作为独立的月度产品窗口处理，不得与标准 5h/7d 窗口混合校准。extra_usage 的利用率为 `used_credits / monthly_limit × 100`，其 L2/L3 估算独立于主窗口。

### 13.3 Claude Sonnet 周池

如果官方同时提供总周额度和 Sonnet 专属周额度：

- 总周额度聚合全部 Claude 事件；
- Sonnet 周额度只聚合 Sonnet 事件；
- 两者分别维护 `windowId` 和校准样本。

## 14. 降级与失败策略

| 场景 | 行为 |
| --- | --- |
| 官方百分比不可用 | 继续展示 L1，不展示 L2/L3 |
| 模型价格不可用 | 该事件金额为 unknown，降低 coverage |
| 官方窗口起点不可用 | 展示 rolling L1，不做高置信度校准 |
| cached token 大于 input token | `uncachedInput=0`，记录数据异常 |
| 百分比下降 | 视为 reset 或数据回滚，开启新窗口 |
| 价格版本变化 | 新建校准序列，不混合斜率 |
| 金额累计下降 | 丢弃采样对并记录异常 |
| 本地无日志但百分比上涨 | 标记外部用量，阻止该片段校准 |
| 历史片段与当前模型组合漂移过大 | 排除不相容片段；没有相容历史时只保留 L1 |
| 上报 cost ticks 比例未验证 | 保存原始值，不换算美元，不影响 API 等价金额 |
| 上报成本与重算成本不一致 | 两者并列保留并告警，不自动选择较大或较小值 |

所有异常均应 fail closed：宁可不显示估算，也不显示伪精确金额。

## 15. UI 展示协议

### 15.1 主卡片

推荐字段：

```text
官方已用                  58%
本窗 API 等价             $12.34
估算整窗 API 等价         $70–$92
估算剩余 API 等价         $29–$39
置信度                    中
本地价格覆盖率            97%
```

### 15.2 必须使用的文案

- “API 等价金额”
- “按当前片段模型组合校准”
- “本地日志覆盖”
- “价格版本”
- “不是账户现金余额”

### 15.3 禁止使用的文案

- “账户余额 $X”
- “可用余额 $X”
- “官方剩余金额 $X”
- “精确价值 $X”

### 15.4 Tooltip

```text
金额按本机日志中的模型与 token，以公开 API 标准价格折算。
官方只提供额度百分比；整窗与剩余金额是基于同一窗口连续样本的区间估算，
不代表供应商现金余额。
```

## 16. 计算示例

某条 Codex 事件：

```text
input_tokens        = 27,339
cached_input_tokens = 27,008
output_tokens       =    807
```

归一化：

```text
uncachedInput = 27,339 - 27,008 = 331
cacheRead     = 27,008
output        = 807
```

假设标准价格：

```text
input      = $2.50 / MTok
cache read = $0.25 / MTok
output     = $15.00 / MTok
```

则：

```text
inputUsd     = 331    × 2.50  / 1,000,000 = $0.0008275
cacheReadUsd = 27,008 × 0.25  / 1,000,000 = $0.0067520
outputUsd    = 807    × 15.00 / 1,000,000 = $0.0121050

totalUsd = $0.0196845
```

若同一窗口多个有效片段的稳健结果为：

```text
lowUsdPerPct   = $0.40
pointUsdPerPct = $0.46
highUsdPerPct  = $0.55
当前已用 u     = 58%
```

则：

```text
整窗 API 等价     = $40.00 – $55.00，点估计 $46.00
剩余 API 等价     = $16.80 – $23.10，点估计 $19.32
```

UI 应显示区间和置信度，不能只显示 `$19.32`。

## 17. 与余量现有模块的对应关系

| 现有模块 | 调整方向 |
| --- | --- |
| `src/lib/quota/types.ts` | 保留 `modelRaw`，拆分互斥 token 字段，增加价格质量 |
| `src/lib/quota/claude-jsonl.ts` | 保留 5m/1h cache-write 明细 |
| `src/lib/quota/codex-jsonl.ts` | 将 cached input 从总 input 中扣除 |
| `src/lib/quota/grok-jsonl.ts` | 明确 OpenAI 风格缓存包含关系，保留产品来源和原始 `costUsdTicks` |
| `src/lib/quota/plans.ts` | 套餐定义与模型价格彻底分离 |
| `src/lib/quota/engine.ts` | 用 CostBreakdown 替换当前简化 `apiUsd()` |
| `src/lib/quota/official.ts` | 解析 Claude/Grok/Codex 官方利用率历史与 reset 边界 |
| `src/lib/quota/quota-value.ts` | 生成稳定 `windowId`，实现同窗口差分、稳健区间和置信度算法 |
| `src/lib/quota/store.ts` | 持久化有限数量的 QuotaSample，按窗口淘汰 |
| `src/components/balance/agent-card.tsx` | 展示 L1、L2/L3 区间、覆盖率和价格来源 |

建议新增：

```text
src/lib/quota/pricing.ts
src/lib/quota/pricing-data.ts
src/lib/quota/cost.ts
src/lib/quota/quota-value.ts
```

## 18. 采样与存储

- 官方 quota 每次成功刷新时生成一个候选 `QuotaSample`。
- 同一窗口、同一百分比且累计金额未变化时不重复保存。
- 每个 `windowId` 最多保存 128 个归一化样本。
- 按 `agent + window kind + product` 分组，分别保留最近 8 个窗口；Claude 的 5h 历史不会挤掉 7d 历史。
- 采样内容不保存 access token、账户 ID、prompt 或 cwd。
- 客户端持久化失败不影响 L1；L2/L3 自动降级为 none。

## 19. 测试矩阵

### 19.1 Token 归一化

- Codex 总输入包含 cached input，不重复计费。
- cached input 大于总输入时 clamp 到 0 并报告异常。
- Claude 5m/1h cache-write 分别计价。
- Grok 新旧字段名都能归一化成互斥字段。
- Grok `costUsdTicks` 总值和逐模型值能原样保留。
- ticks 比例未验证时 `usdValue` 保持 `null`，不能猜测美元换算。
- 相同事件重复扫描后只保留一次。

### 19.2 价格解析

- 精确模型优先于别名和 family fallback。
- 未知模型返回 unknown，不产生伪金额。
- priority/flex 只在日志明确给出时计算。
- 长上下文倍率只应用于声明该规则的精确模型。
- 价格版本变化不会改变已经冻结的窗口金额。
- 已验证的上报成本与 API 等价金额分别存储，任何一方都不覆盖另一方。

### 19.3 窗口聚合

- 使用 `startsAt` 时不混入窗口前事件。
- 只有 `resetsAt` 时正确反推 5h/7d 起点。
- reset 后建立新 `windowId`。
- Grok 周窗口优先使用 `weekStartedAt`。
- rolling fallback 不产生高置信度估算。

### 19.4 校准

- 同窗口差分能得到正确 `usdPerPct`。
- 1% 取整噪声只能得到 low。
- MAD 能排除极端斜率。
- 百分比上涨但本地金额为 0 时识别外部用量。
- 模型组合漂移超过阈值时停止沿用校准。
- 空的首平台模型组合不会触发伪漂移；历史中与当前片段相容的模型组合仍可复用。
- reset、价格版本变化、产品变化不会串样本。

### 19.5 UI

- L1 始终标注“API 等价”。
- L2/L3 始终显示区间和置信度。
- Claude 同时显示 5h / 本周两套区间；Grok 只显示共享周池区间及产品占用构成。
- Claude/Grok 不显示 OpenAI credit；Codex credit 只按公开 Codex rate card 折算。
- unknown/coverage 过低时不显示伪精确金额。
- 页面任何位置都不把估算称为官方余额。

## 20. 验收标准

算法实现满足以下条件才可上线：

1. Codex 缓存输入不再重复计费。
2. Claude、Grok、Codex 都使用原始模型 ID 查价。
3. 当前窗口金额与官方窗口起止时间一致。
4. 未知模型会降低 coverage，而不是静默使用默认价。
5. 主卡片能展示 L1 金额和价格覆盖率。
6. L2/L3 只在有效连续采样达到阈值后出现。
7. 跨设备疑似用量、reset、产品池变化都会阻止错误校准。
8. 所有估算都有区间、置信度和“非现金余额”说明。
9. 单元测试覆盖本文件第 19 节全部分支。
10. 使用真实本机日志和真实官方百分比完成一次端到端验证。
11. Grok `costUsdTicks` 在换算比例和字段语义完成版本化验证前不显示为美元。

## 21. 推荐落地顺序

```text
阶段 1：修复 token 语义、精确模型保留，并原样采集上报成本字段
阶段 2：引入版本化价格快照和 CostBreakdown
阶段 3：按官方窗口展示可靠 L1 金额
阶段 4：持久化 QuotaSample
阶段 5：实现差分、MAD、模型漂移和置信度
阶段 6：灰度展示 L2/L3 区间
阶段 7：真实窗口端到端校准与文案验收
```

在阶段 3 完成前，不应继续扩展当前的一次性百分比反推算法。

## 22. 候选估计器：Theil–Sen 离线 shadow

Theil–Sen 回归是一种对离群值鲁棒的斜率估计方法，取所有采样对斜率的中位数。当前生产估计器使用加权 MAD 过滤后的 weighted median；Theil–Sen 离线 shadow 作为后续候选，仅在开发环境中 shadow-run，用于收集与当前估计器的偏差统计，不进入当前生产估计器或 telemetry。

启用条件：

- 仅在 `NODE_ENV=development` 或 `SYNQ_SHADOW_ESTIMATORS=1` 时计算；
- 结果写入诊断日志，不影响 L2/L3 展示值；
- 当偏差统计积累足够且证明 Theil–Sen 在边界条件（少样本、高漂移）下表现更好时，可考虑提升为生产候选。
