# 监控页信息层级优化实施计划

日期：2026-08-23
状态：待执行

## 目标与前端意见项

依据用户截图，本次只调整简约模式的信息层级，不改变额度算法、状态阈值、Agent 可见性、极客模式数据或协同逻辑。

1. 简约模式移除“充足 / 留意 / 将尽”状态 tag；它与进度色表达重复，且夹在 Agent 名称和操作按钮之间会让含义不清。
2. 主“剩余百分比”和已用进度条统一使用绿 / 黄 / 红风险色，继续保留文字标签，避免只靠颜色传意。
3. 删除简约模式卡片右侧第二个“已用百分比”，只保留“大号剩余百分比 + 进度条已用百分比”这一对互补信息。
4. 将“本周额度剩余 / 本周额度 / 周限额刷新”收敛为“本周剩余 / 已用 / N 后刷新”，去掉重复的“本周额度”。
5. 刷新时间默认只显示相对时间；绝对日期时间放到原生悬停提示和可访问名称中。
6. “协同时间线”“近 24 小时 token”的解释，以及简约 Agent 卡中的套餐 / 配置路径，收进可悬停、可聚焦、带可访问名称的问号提示。

## Explore 核对结果

- `AgentCard` 的真实 props 位于 `src/components/balance/agent-card.tsx:69-113`；可直接使用 `PlanDef.name`、`adapter`、`MeterSnapshot.weekPct` 和 `weekResetsAt`。
- 状态阈值已有 `effectiveQuotaStatus()`：周使用量 `>= 72` 为 `watch`、`>= 88` 为 `critical`，位于 `src/lib/quota/presentation.ts:123-133`。
- 绝对时间已有 `formatResetClock()`，相对时间已有 `formatDuration()`；现有 `formatWeekResetLabel()` 同时平铺二者，位于 `src/lib/quota/presentation.ts:49-74`。
- 仓库没有自建 Tooltip；现有轻提示使用原生 `title`，`lucide-react` 的 `CircleHelp` 真实签名为 `ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>`。
- 主页面标题和描述位于 `src/components/balance/dashboard.tsx:617-635,742-760`；现有浏览器验收入口是 `npm run test:e2e:minimal`。

## Step 1：拆分刷新时间的常显与悬停文案

TDD 顺序：先在 `src/lib/quota/presentation.test.ts` 增加失败测试，确认缺少 `formatWeekResetHint()`；再实现 helper；最后跑目标单测、类型检查、构建。

在 `src/lib/quota/presentation.test.ts` 的 import 中加入 `formatWeekResetHint`，并加入完整测试：

```ts
test("week reset hint keeps relative time visible and absolute time in its title", () => {
  assert.deepEqual(
    formatWeekResetHint(WEEK_RESET, FOUR_DAYS_BEFORE, { timeZone: "Asia/Shanghai" }),
    {
      label: "4 天 0 小时后刷新",
      title: "8月27日 04:59 刷新",
      dateTime: "2026-08-26T20:59:00.000Z",
    },
  );
});

test("week reset hint handles missing and elapsed timestamps", () => {
  assert.equal(formatWeekResetHint(null, FOUR_DAYS_BEFORE), null);
  assert.deepEqual(
    formatWeekResetHint(WEEK_RESET, WEEK_RESET + 60_000, { timeZone: "Asia/Shanghai" }),
    {
      label: "等待刷新",
      title: "8月27日 04:59 刷新",
      dateTime: "2026-08-26T20:59:00.000Z",
    },
  );
});
```

在 `src/lib/quota/presentation.ts` 的 `formatWeekResetLabel()` 后加入完整实现：

```ts
export interface WeekResetHint {
  label: string;
  title: string;
  dateTime: string;
}

export function formatWeekResetHint(
  resetsAt: number | null | undefined,
  now: number,
  opts?: { timeZone?: string },
): WeekResetHint | null {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const remain = resetsAt - now;
  return {
    label: remain <= 0 ? "等待刷新" : `${formatDuration(remain)}后刷新`,
    title: `${formatResetClock(resetsAt, opts?.timeZone)} 刷新`,
    dateTime: new Date(resetsAt).toISOString(),
  };
}
```

验收命令：

```text
node --test --experimental-strip-types src/lib/quota/presentation.test.ts
npm run typecheck
npm run build:dev
```

验收标准：helper 对无效时间返回 `null`；未来时间拆成相对 `label` 与绝对 `title`；过期时间显示“等待刷新”；既有 `formatWeekResetLabel()` 行为不变。

Commit：`feat(ui): split weekly reset display and hover time`

## Step 2：新增统一的问号说明并收纳次要信息

TDD 顺序：先在 `scripts/monitor-ui-mode.test.mjs` 增加失败的静态结构测试；再新增 `InlineHelp` 并接入两个看板标题和简约 Agent 卡头；最后跑静态测试、类型检查、构建。

新增完整文件 `src/components/ui/inline-help.tsx`：

```tsx
import { CircleHelp } from "lucide-react";

export function InlineHelp({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      tabIndex={0}
      className="inline-flex shrink-0 cursor-help items-center text-faint outline-none transition-colors hover:text-mute focus-visible:text-ink"
    >
      <CircleHelp className="size-3.5" aria-hidden="true" />
    </span>
  );
}
```

在 `scripts/monitor-ui-mode.test.mjs` 加入完整测试：

```js
test("secondary monitor descriptions move into accessible hover help", () => {
  const help = read("src/components/ui/inline-help.tsx");
  const dashboard = read("src/components/balance/dashboard.tsx");
  const agentCard = read("src/components/balance/agent-card.tsx");
  assert.match(help, /role="img"/);
  assert.match(help, /aria-label=\{label\}/);
  assert.match(help, /title=\{label\}/);
  assert.match(help, /tabIndex=\{0\}/);
  assert.match(dashboard, /<InlineHelp/);
  assert.match(dashboard, /协同时间线：/);
  assert.match(dashboard, /近 24 小时 token：/);
  assert.match(agentCard, /套餐：\$\{plan\.name\} · 配置路径：\$\{adapter\}/);
});
```

`dashboard.tsx` 顶部加入：

```tsx
import { InlineHelp } from "@/components/ui/inline-help";
```

`agent-card.tsx` 顶部加入：

```tsx
import { InlineHelp } from "@/components/ui/inline-help";
```

然后把 `dashboard.tsx` 的两个标题块完整替换为：

```tsx
<div className="flex min-w-0 items-center gap-1.5">
  <CardTitle>协同时间线</CardTitle>
  <InlineHelp
    label={`协同时间线：${visibleAgents.length} 路 Agent 共享同一口 5 小时时钟`}
  />
</div>
```

```tsx
<div className="flex items-center gap-1.5">
  <CardTitle>近 24 小时 token</CardTitle>
  <InlineHelp
    label={`近 24 小时 token：按小时叠加，便于看 ${visibleAgents.length} 路 Agent 燃烧节奏`}
  />
</div>
```

`AgentCard` 卡头中的完整简约 / 极客分支为：

```tsx
<div className="flex flex-wrap items-center gap-2">
  <span className={cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint")} />
  <CardTitle>{name}</CardTitle>
  {minimalMode ? (
    <InlineHelp label={`套餐：${plan.name} · 配置路径：${adapter}`} />
  ) : (
    <Badge tone={hasFreshOfficial ? effectiveStatus : "mute"}>{statusLabel}</Badge>
  )}
</div>
{!minimalMode ? (
  <CardHint className="mt-1 break-words">
    {plan.name} · {adapter}
    {quotaNote ? ` · ${quotaNote}` : ""}
  </CardHint>
) : null}
```

验收命令：

```text
node --test scripts/monitor-ui-mode.test.mjs
npm run typecheck
npm run build:dev
```

验收标准：两个说明不再平铺；问号提示使用有可访问名称的图片角色，可悬停并可键盘聚焦；简约卡不平铺套餐、路径或状态 tag；极客模式保留现有 tag 和详细副标题。Step 3 的真实浏览器测试再通过可访问树查找这些提示。

Commit：`feat(ui): tuck secondary monitor details into help`

## Step 3：统一额度卡百分比、颜色和刷新层级

TDD 顺序：先更新 `scripts/minimal-mode-e2e.mjs`，使它要求简约卡只显示一处“已用”、无状态 tag、主百分比带风险色、刷新只常显相对时间且绝对时间位于 title；先运行并看到失败，再修改 `AgentCard`；最后跑完整前端测试、lint、类型检查、构建和真实浏览器 E2E。

将 `agent-card.tsx` 现有的刷新格式 import 完整扩展为：

```ts
formatWeekResetHint,
formatWeekResetLabel,
```

在 `AgentCard` 中加入完整状态与 tone 计算：

```ts
const weeklyStatus = effectiveQuotaStatus(
  meter.weekPct >= 88 ? "critical" : meter.weekPct >= 72 ? "watch" : "ok",
  hasFreshPool ? freshPoolPct : null,
);
const weeklyTone = minimalMode
  ? weeklyStatus === "critical"
    ? "crit"
    : weeklyStatus === "watch"
      ? "warn"
      : "ok"
  : quotaSources.week === "official"
    ? meter.weekPct >= 88
      ? "crit"
      : meter.weekPct >= 72
        ? "warn"
        : tone
    : tone;
const weekReset = formatWeekResetLabel(weekResetsAt, now);
const weekResetHint = formatWeekResetHint(weekResetsAt, now);
```

上面的两行完整替换当前已有的单行 `const weekReset = formatWeekResetLabel(weekResetsAt, now);`，不得在原声明后重复插入。

主百分比完整 JSX 调整为：

```tsx
<div className="flex items-end justify-between gap-4">
  <div>
    <p className="text-xs text-mute">{minimalMode ? "本周剩余" : primaryRemainingLabel}</p>
    <p
      data-testid={minimalMode ? `quota-${meter.agent}-week-remaining` : undefined}
      aria-label={minimalMode ? `本周剩余 ${remain.toFixed(0)}%，${statusCopy[weeklyStatus]}` : undefined}
      className={cn(
        "mt-1 font-mono leading-none font-medium tracking-tight tabular",
        minimalMode ? "text-3xl" : "text-4xl",
        minimalMode && weeklyStatus === "ok" && "text-ok",
        minimalMode && weeklyStatus === "watch" && "text-warn",
        minimalMode && weeklyStatus === "critical" && "text-crit",
      )}
    >
      {remain.toFixed(0)}
      <span className="ml-1 text-lg text-mute">%</span>
    </p>
  </div>
  {!minimalMode ? (
    <div className="text-right text-xs text-mute">
      {weeklyView ? (
        <>
          <p>
            {primaryUsedLabel} {meter.weekPct.toFixed(meter.weekPct >= 10 ? 0 : 1)}
            <span className="text-faint"> %</span>
          </p>
          <p className="mt-1">
            {meter.agent !== "codex" ? "API 等价按公开价折算" : "credit 按公开价等价折算"}
          </p>
        </>
      ) : (
        <>
          <p>
            {primarySource === "official"
              ? "燃烧"
              : primarySource === "official-stale"
                ? "快照燃烧"
                : "估算燃烧"}{" "}
            {meter.burnPctPerHour.toFixed(1)}
            <span className="text-faint"> %/时</span>
          </p>
          <p className="mt-1">
            {meter.etaMs != null && meter.etaMs < 6 * 60 * 60 * 1000
              ? `预计 ${formatDuration(meter.etaMs)} 耗尽`
              : "当前速率可撑过本窗"}
          </p>
        </>
      )}
    </div>
  ) : null}
</div>
```

周进度条完整 JSX 调整为：

```tsx
<div>
  <MeterBar
    value={meter.weekPct}
    tone={weeklyTone}
    label={minimalMode ? "已用" : weekMeterLabel}
    detail={minimalMode ? null : weekReset}
  />
  {minimalMode && weekResetHint ? (
    <p className="mt-1.5 text-xs text-faint">
      <time
        data-testid={`quota-${meter.agent}-week-reset`}
        dateTime={weekResetHint.dateTime}
        title={weekResetHint.title}
        aria-label={`${weekResetHint.label}，${weekResetHint.title}`}
      >
        {weekResetHint.label}
      </time>
    </p>
  ) : null}
</div>
```

`assertMinimalAgentCardDetails()` 对每张卡新增以下完整断言，并将旧的“本周额度恰好 1 次”断言改为 0 次：

```js
assert.equal(await card.getByText("本周额度", { exact: true }).count(), 0);
assert.equal(await card.getByText("本周剩余", { exact: true }).count(), 1);
assert.equal(await card.getByText("已用", { exact: true }).count(), 1);
for (const status of ["充足", "留意", "将尽"])
  assert.equal(await card.getByText(status, { exact: true }).count(), 0);
assert.equal(await card.getByLabel(/^套餐：.+ · 配置路径：~\//).count(), 1);
const remaining = card.locator(`[data-testid="quota-${heading === "Claude Code" ? "claude" : heading.toLowerCase()}-week-remaining"]`);
await remaining.waitFor();
assert.match(await remaining.getAttribute("class"), /text-(ok|warn|crit)/);
assert.equal(await card.getByText(/后刷新|等待刷新/).count(), 0);
```

在 `assertMinimalMode()` 中加入真实可访问树断言：

```js
await page
  .getByRole("img", {
    name: `协同时间线：${AGENT_CARD_HEADINGS.length} 路 Agent 共享同一口 5 小时时钟`,
    exact: true,
  })
  .waitFor();
await page
  .getByRole("img", {
    name: `近 24 小时 token：按小时叠加，便于看 ${AGENT_CARD_HEADINGS.length} 路 Agent 燃烧节奏`,
    exact: true,
  })
  .waitFor();
```

同时在 `scripts/monitor-ui-mode.test.mjs` 加入刷新节点绑定的完整静态断言：

```js
test("minimal weekly reset keeps absolute time in hover help", () => {
  const agentCard = read("src/components/balance/agent-card.tsx");
  assert.match(agentCard, /<time/);
  assert.match(agentCard, /title=\{weekResetHint\.title\}/);
  assert.match(agentCard, /aria-label=\{`\$\{weekResetHint\.label\}，\$\{weekResetHint\.title\}`\}/);
});
```

演示 fixture 没有官方 `weekResetsAt`，浏览器测试明确断言页面不伪造“后刷新”文案；相对 / 绝对时间的精确输出由 Step 1 单测覆盖，`time`、`title` 与可访问名称的绑定由本 Step 的静态结构测试覆盖。

验收命令：

```text
npm test
npm run lint
npm run typecheck
npm run build:dev
npm run dev
npm run test:e2e:minimal -- http://127.0.0.1:8080/
```

验收标准：桌面和手机三张简约卡无横向 / 纵向溢出；每张卡只有一个“已用”百分比；剩余数字与进度条风险色一致；说明及绝对刷新时间可悬停；极客模式原信息仍在；E2E 的 console、pageerror、request、HTTP 诊断均为空并生成桌面 / 手机截图。

Commit：`feat(ui): clarify weekly quota hierarchy`

## Plan 自检

- Spec coverage：6 个意见项分别由 Step 2（次要说明/套餐路径）和 Step 3（tag、颜色、百分比、重复文案），刷新拆分由 Step 1 + Step 3 覆盖；极客模式回归与响应式由 Step 2/3 验收覆盖。
- Placeholder scan：全文没有待办标记、三点省略、伪代码或省略实现；所有新增函数、组件、JSX 和断言均给出完整代码。
- Type consistency：使用 Explore 核实过的 `PlanDef.name`、`MeterSnapshot.weekPct`、`weekResetsAt`、`effectiveQuotaStatus()`、`formatDuration()` 和 `CircleHelp` 签名；不引入未经核验的数据字段。
- Step size：每步只有一个独立 TDD 结果，可单独测试和提交；Step 1 是纯格式 helper，Step 2 是统一说明入口，Step 3 是卡片信息层级与真实浏览器验收。
