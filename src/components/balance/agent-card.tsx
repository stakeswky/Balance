import { Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardHint, CardTitle } from "@/components/ui/card";
import { InlineHelp } from "@/components/ui/inline-help";
import {
  AntigravityGroupUsageInline,
  AntigravityUsageDetails,
} from "@/components/balance/antigravity-usage";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  formatUsdRange,
  modelLabel,
} from "@/components/balance/format";
import { MeterBar } from "@/components/balance/meter-bar";
import { agentFillClass } from "@/lib/quota/agent";
import {
  aggregateAntigravityUsage,
  type AntigravityUsageEvent,
} from "@/lib/quota/antigravity-usage";
import {
  inWindow,
  modelShares,
  officialOnlyMeter,
  weightedTokens,
  type MeterDataSources,
} from "@/lib/quota/engine";
import { grokProductLabel, type OfficialProductShare } from "@/lib/quota/official";
import { parallelTaskSummary } from "@/lib/quota/parallel-tasks";
import {
  antigravityQuotaGroupSummaries,
  apiEquivalentSections,
  displayWeekTokens,
  effectiveQuotaStatus,
  formatCreditRange,
  formatCredits,
  formatWeekResetHint,
  formatWeekResetLabel,
  officialPrimaryMeterWindow,
  primaryUsagePercent,
  quotaPoolLabel,
  type QuotaPoolView,
} from "@/lib/quota/presentation";
import type { QuotaValue } from "@/lib/quota/quota-value";
import {
  calibrationSourceLabel,
  quotaSourceLabel,
  quotaSourceMessage,
  quotaValueDiagnostics,
  type OfficialLoadState,
} from "@/lib/quota/quota-label";
import type {
  AgentId,
  AgentLiveInfo,
  MeterSnapshot,
  PlanDef,
  SessionState,
  UsageEvent,
} from "@/lib/quota/types";
import { isUsageAgentId, WEEK_MS, WINDOW_MS } from "@/lib/quota/types";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

const CONFIDENCE_LABEL: Record<QuotaValue["confidence"], string> = {
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
};

const VALUE_HINT =
  "金额按本机日志中的模型与 token，以公开 API 标准价格折算。官方只提供额度百分比；整窗与剩余金额是基于同一窗口连续样本的区间估算，不代表供应商现金余额。";
const CREDIT_HINT =
  "按 OpenAI 当前公开 Codex rate card 换算。它是用量等价，不是后台现金余额，也不是官方承诺的订阅总 credit。";

const statusCopy = {
  ok: "充足",
  watch: "留意",
  critical: "将尽",
} as const;

export function AgentCard({
  name,
  adapter,
  plan,
  meter,
  session,
  live,
  minimalMode = true,
  officialOnly = false,
  activeTasks,
  liveNote,
  windowLabel = "5 小时窗",
  quotaNote,
  products,
  quotaPools,
  quotaSources = { window: "local-estimate", week: "local-estimate" },
  officialLoadState,
  weekValue,
  windowValue,
  weekResetsAt,
  antigravityUsageEvents,
  antigravityUsageTruncated,
  events,
  now,
  onToggle,
}: {
  name: string;
  adapter: string;
  plan: PlanDef | null;
  meter: MeterSnapshot;
  session: SessionState | null;
  live: boolean;
  minimalMode?: boolean;
  officialOnly?: boolean;
  activeTasks?: AgentLiveInfo[];
  liveNote?: string;
  windowLabel?: string;
  quotaNote?: string;
  products?: OfficialProductShare[];
  quotaPools?: QuotaPoolView[];
  quotaSources?: MeterDataSources;
  officialLoadState?: OfficialLoadState;
  weekValue?: QuotaValue;
  windowValue?: QuotaValue;
  weekResetsAt?: number | null;
  antigravityUsageEvents?: AntigravityUsageEvent[];
  antigravityUsageTruncated?: boolean;
  events: UsageEvent[];
  now: number;
  onToggle?: () => void;
}) {
  const tone = meter.agent;
  const usageAgent = isUsageAgentId(meter.agent) ? meter.agent : null;
  const shares = usageAgent ? modelShares(events, usageAgent, now, WEEK_MS) : [];
  const officialPrimary = officialPrimaryMeterWindow(meter, quotaSources);
  const antigravityGroups = officialOnly
    ? antigravityQuotaGroupSummaries((quotaPools ?? []).map(({ pool }) => pool))
    : [];
  const splitAntigravityMinimal = minimalMode && officialOnly && antigravityGroups.length > 0;
  const antigravityWeekUsage = useMemo(
    () =>
      officialOnly
        ? aggregateAntigravityUsage(antigravityUsageEvents ?? [], now - WEEK_MS)
        : null,
    [officialOnly, antigravityUsageEvents, now],
  );
  const primaryKind = officialOnly
    ? officialPrimary?.kind ?? "weekly"
    : minimalMode || windowLabel === "本周额度"
      ? "weekly"
      : "five_hour";
  const weeklyView = primaryKind === "weekly";
  const weekMeterLabel = minimalMode ? "本周额度" : quotaSourceLabel("本周额度", quotaSources.week);
  const primaryPct = officialOnly
    ? officialPrimary?.pct ?? 0
    : primaryUsagePercent(meter, primaryKind);
  const remain = Math.max(0, 100 - primaryPct);
  const weighted = (usageAgent ? inWindow(events, now, WINDOW_MS, usageAgent) : []).reduce(
    (s, e) => s + weightedTokens(e),
    0,
  );
  const weekWeighted = (usageAgent ? inWindow(events, now, WEEK_MS, usageAgent) : []).reduce(
    (s, e) => s + weightedTokens(e),
    0,
  );
  const weekTokenDisplay = displayWeekTokens({
    weekTokens: meter.weekTokens,
    weekBudget: meter.weekBudget,
    weekWeightedTokens: weekWeighted,
    weekValue,
  });
  const primarySource = primaryKind === "weekly" ? quotaSources.week : quotaSources.window;
  const freshMeter = officialOnlyMeter(meter, quotaSources);
  const freshPoolPcts = (quotaPools ?? []).flatMap(({ valuation }) => {
    if (valuation.kind === "stale") return [];
    if (valuation.kind === "exact") return [valuation.value.usedPercent];
    if (valuation.kind === "official") return [valuation.value.usedPercent];
    return [valuation.value.usedPct];
  });
  const hasFreshPool = freshPoolPcts.length > 0;
  const freshPoolPct = Math.max(0, ...freshPoolPcts);
  const hasFreshOfficial = Boolean(freshMeter || hasFreshPool);
  const hasLocalEstimate = Object.values(quotaSources).includes("local-estimate");
  const hasStaleSnapshot =
    Object.values(quotaSources).includes("official-stale") ||
    (quotaPools ?? []).some(({ valuation }) => valuation.kind === "stale");
  const officialUnavailable = officialOnly && !hasFreshOfficial && !hasStaleSnapshot;
  const sourceMessage = officialLoadState
    ? quotaSourceMessage(officialLoadState, hasFreshOfficial, hasLocalEstimate, hasStaleSnapshot)
    : null;
  const displayedSourceMessage = officialOnly && officialUnavailable
    ? officialLoadState === "loading"
      ? "正在读取 Antigravity 官方余量。"
      : officialLoadState === "error"
        ? "Antigravity 官方余量读取失败，请稍后重试。"
        : "暂未读取到 Antigravity 官方余量。"
    : sourceMessage;
  const effectiveStatus = effectiveQuotaStatus(
    freshMeter?.status ?? "ok",
    hasFreshPool ? freshPoolPct : null,
  );
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
  const statusLabel = hasFreshOfficial
    ? statusCopy[effectiveStatus]
    : hasStaleSnapshot
      ? "官方快照"
      : officialOnly
        ? "暂无官方数据"
        : "本地估算";
  const primaryRemainingLabel = minimalMode
    ? "本周额度剩余"
    : primarySource === "official"
      ? primaryKind === "weekly"
        ? "官方周额度剩余"
        : "官方窗口剩余"
      : primarySource === "official-stale"
        ? primaryKind === "weekly"
          ? "官方快照周额度剩余"
          : "官方快照窗口剩余"
        : primaryKind === "weekly"
          ? "本地估算周用量剩余"
          : "本地估算窗口剩余";
  const primaryUsedLabel = minimalMode
    ? "已用"
    : primarySource === "official"
      ? "已用"
      : primarySource === "official-stale"
        ? "快照已用"
        : "估算已用";
  const primary = primaryKind === "weekly" ? weekValue : windowValue;
  const valueSections =
    usageAgent && weekValue && windowValue
      ? apiEquivalentSections(meter.agent, primaryKind, weekValue, windowValue)
      : [];
  const diagnosticMessages = [...new Set(
    valueSections.flatMap((section) => quotaValueDiagnostics(section.value)),
  )];
  const l1 = formatL1(weekValue);
  const winL1 = formatL1(windowValue);
  const creditL1 = formatCreditL1(weekValue);
  const parallel = parallelTaskSummary(activeTasks ?? [], live);
  const weekReset = formatWeekResetLabel(weekResetsAt, now);
  const primaryResetHint = formatWeekResetHint(
    officialPrimary?.resetsAt ?? (weeklyView ? weekResetsAt : meter.windowResetsAt),
    now,
  );
  const estimatedWeekUsage =
    weekValue && weekValue.confidence !== "none"
      ? formatUsdRange(weekValue.totalLowUsd, weekValue.totalHighUsd)
      : "样本不足";
  const planName = plan?.name ?? "官方余量";
  const minimalStatus = officialOnly
    ? effectiveQuotaStatus(
      primaryPct >= 88 ? "critical" : primaryPct >= 72 ? "watch" : "ok",
      hasFreshPool ? freshPoolPct : null,
    )
    : weeklyStatus;

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader className="min-w-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint")} />
            <CardTitle>{name}</CardTitle>
            {minimalMode ? (
              <InlineHelp label={`${officialOnly ? "官方余量" : `套餐：${planName}`} · 配置路径：${adapter}`} />
            ) : (
              <Badge tone={hasFreshOfficial ? effectiveStatus : "mute"}>{statusLabel}</Badge>
            )}
          </div>
          {!minimalMode ? (
            <CardHint className="mt-1 break-words">
              {planName} · {adapter}
              {quotaNote ? ` · ${quotaNote}` : ""}
            </CardHint>
          ) : null}
        </div>
        {!officialOnly && onToggle ? (
          <Button variant="secondary" size="sm" onClick={onToggle} aria-pressed={live}>
            {live ? <Pause /> : <Play />}
            {live ? "暂停" : "采集"}
          </Button>
        ) : null}
      </CardHeader>

      {splitAntigravityMinimal ? (
        <div className="mt-1 w-full space-y-3" aria-label="Antigravity 分类额度">
          {antigravityGroups.map((group) => {
            const groupRemain = Math.max(0, 100 - group.usedPct);
            const groupStatus = group.usedPct >= 88
              ? "critical"
              : group.usedPct >= 72
                ? "watch"
                : "ok";
            const groupResetHint = formatWeekResetHint(group.resetsAt, now);
            return (
              <section key={group.group} className="rounded-xl bg-raised px-3 py-3">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs text-mute">{group.label}剩余</p>
                    <p
                      data-testid={`quota-antigravity-${group.group}-remaining`}
                      aria-label={`${group.label}剩余 ${groupRemain.toFixed(0)}%，${statusCopy[groupStatus]}`}
                      className={cn(
                        "mt-1 font-mono text-2xl leading-none font-medium tracking-tight tabular",
                        groupStatus === "ok" && "text-ok",
                        groupStatus === "watch" && "text-warn",
                        groupStatus === "critical" && "text-crit",
                      )}
                    >
                      {groupRemain.toFixed(0)}<span className="ml-1 text-base text-mute">%</span>
                    </p>
                  </div>
                  <span className="text-xs text-faint">
                    {group.kind === "weekly" ? "本周额度" : "5 小时窗"}
                    {group.stale ? " · 快照" : ""}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      groupStatus === "critical"
                        ? "bg-crit"
                        : groupStatus === "watch"
                          ? "bg-warn"
                          : "bg-ok",
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, group.usedPct))}%` }}
                  />
                </div>
                {groupResetHint ? (
                  <p className="mt-1.5 text-xs text-faint">
                    <time
                      dateTime={groupResetHint.dateTime}
                      title={groupResetHint.title}
                      aria-label={`${groupResetHint.label}，${groupResetHint.title}`}
                    >
                      {groupResetHint.label}
                    </time>
                  </p>
                ) : null}
                <AntigravityGroupUsageInline
                  group={group.group}
                  summary={antigravityWeekUsage?.groups.find((usage) => usage.group === group.group) ?? null}
                />
              </section>
            );
          })}
        </div>
      ) : (
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs text-mute">
              {minimalMode ? (weeklyView ? "本周剩余" : `${windowLabel}剩余`) : primaryRemainingLabel}
            </p>
            <p
              data-testid={
                officialOnly
                  ? `quota-${meter.agent}-primary-remaining`
                  : minimalMode
                    ? `quota-${meter.agent}-${weeklyView ? "week" : "window"}-remaining`
                    : undefined
              }
              aria-label={
                minimalMode
                  ? officialUnavailable
                    ? "暂无官方余量"
                    : `${weeklyView ? "本周" : windowLabel}剩余 ${remain.toFixed(0)}%，${statusCopy[minimalStatus]}`
                  : undefined
              }
              className={cn(
                "mt-1 font-mono leading-none font-medium tracking-tight tabular",
                minimalMode ? "text-3xl" : "text-4xl",
                minimalMode && minimalStatus === "ok" && "text-ok",
                minimalMode && minimalStatus === "watch" && "text-warn",
                minimalMode && minimalStatus === "critical" && "text-crit",
              )}
            >
              {officialUnavailable ? "—" : remain.toFixed(0)}
              {!officialUnavailable ? <span className="ml-1 text-lg text-mute">%</span> : null}
            </p>
          </div>
          {!minimalMode && !officialUnavailable ? (
            <div className="text-right text-xs text-mute">
              {weeklyView ? (
                <>
                  <p>
                    {primaryUsedLabel} {meter.weekPct.toFixed(meter.weekPct >= 10 ? 0 : 1)}
                    <span className="text-faint"> %</span>
                  </p>
                  {!officialOnly ? (
                    <p className="mt-1">
                      {meter.agent !== "codex" ? "API 等价按公开价折算" : "credit 按公开价等价折算"}
                    </p>
                  ) : null}
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
      )}

      {!minimalMode && displayedSourceMessage ? (
        <p className="mt-4 rounded-xl bg-raised px-3 py-2 text-xs leading-relaxed text-mute">
          {displayedSourceMessage}
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {officialUnavailable ? (
          <p className="rounded-xl bg-raised px-3 py-3 text-sm text-mute">
            暂未读取到官方额度
          </p>
        ) : minimalMode ? (
          splitAntigravityMinimal ? null : (
            <div>
              <MeterBar
                value={primaryPct}
                tone={
                  minimalStatus === "critical"
                    ? "crit"
                    : minimalStatus === "watch"
                      ? "warn"
                      : "ok"
                }
                label={weeklyView ? "本周额度" : windowLabel}
              />
              {primaryResetHint ? (
                <p className="mt-1.5 text-xs text-faint">
                  <time
                    data-testid={`quota-${meter.agent}-${weeklyView ? "week" : "window"}-reset`}
                    dateTime={primaryResetHint.dateTime}
                    title={primaryResetHint.title}
                    aria-label={`${primaryResetHint.label}，${primaryResetHint.title}`}
                  >
                    {primaryResetHint.label}
                  </time>
                </p>
              ) : null}
            </div>
          )
        ) : officialOnly ? (
          <>
            <MeterBar
              value={meter.windowPct}
              tone={
                quotaSources.window === "official"
                  ? meter.windowPct >= 88
                    ? "crit"
                    : meter.windowPct >= 68
                      ? "warn"
                      : tone
                  : tone
              }
              label={quotaSourceLabel(windowLabel, quotaSources.window)}
            />
            <MeterBar
              value={meter.weekPct}
              tone={
                quotaSources.week === "official"
                  ? meter.weekPct >= 88
                    ? "crit"
                    : meter.weekPct >= 72
                      ? "warn"
                      : tone
                  : tone
              }
              label={weekMeterLabel}
              detail={weekReset}
            />
            <QuotaPoolRows rows={quotaPools ?? []} tone={tone} now={now} />
          </>
        ) : weeklyView ? (
          <div>
            <MeterBar
              value={meter.weekPct}
              tone={weeklyTone}
              label={weekMeterLabel}
              detail={weekReset}
            />
          </div>
        ) : (
          <>
            <MeterBar
              value={meter.windowPct}
              tone={
                quotaSources.window === "official"
                  ? meter.windowPct >= 88
                    ? "crit"
                    : meter.windowPct >= 68
                      ? "warn"
                      : tone
                  : tone
              }
              label={quotaSourceLabel(windowLabel, quotaSources.window)}
            />
            <MeterBar
              value={meter.weekPct}
              tone={
                quotaSources.week === "official"
                  ? meter.weekPct >= 88
                    ? "crit"
                    : meter.weekPct >= 72
                      ? "warn"
                      : tone
                  : tone
              }
              label={weekMeterLabel}
              detail={weekReset}
            />
            <QuotaPoolRows rows={quotaPools ?? []} tone={tone} now={now} />
          </>
        )}
      </div>

      {!minimalMode && officialOnly ? (
        <AntigravityUsageDetails
          events={antigravityUsageEvents ?? []}
          now={now}
          truncated={antigravityUsageTruncated ?? false}
        />
      ) : null}

      {!minimalMode && products?.some((p) => p.usagePercent != null) ? (
        <div className="mt-4 space-y-2">
          {meter.agent === "grok" ? (
            <p className="mb-2 text-xs text-faint">官方共享周池 · 下列为产品占用构成</p>
          ) : null}
          {products
            .filter((p) => p.usagePercent != null)
            .map((p) => (
              <div key={p.product} className="flex items-center gap-3 text-xs">
                <span className="w-28 truncate text-mute">{grokProductLabel(p.product)}</span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-raised">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      agentFillClass(tone),
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, p.usagePercent ?? 0))}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono tabular text-ink">
                  {(p.usagePercent ?? 0).toFixed(0)}%
                </span>
              </div>
            ))}
        </div>
      ) : null}

      {!officialOnly ? <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        {minimalMode ? (
          <>
            <Stat
              compact
              label="本周已用 token"
              value={formatTokens(weekTokenDisplay.used)}
              testId={`quota-${meter.agent}-week-tokens`}
            />
            <Stat compact label="本周用量" value={l1.text} dim={l1.dim} hint={VALUE_HINT} />
            <Stat
              compact
              label="本周预估总 token"
              value={formatTokens(weekTokenDisplay.total)}
              testId={`quota-${meter.agent}-week-token-total`}
            />
            <Stat compact label="本周预估总用量" value={estimatedWeekUsage} hint={VALUE_HINT} />
          </>
        ) : (
          <>
            <Stat label="本窗 token" value={formatTokens(meter.windowTokens)} />
            <Stat
              label={meter.agent === "codex" ? "本窗推理" : "加权用量"}
              value={
                meter.agent === "codex"
                  ? `${meter.windowReasoningMin.toFixed(1)} 分`
                  : formatTokens(weighted)
              }
            />
            <Stat label="本周 token" value={formatTokens(weekTokenDisplay.used)} />
            <Stat testId={`quota-${meter.agent}-weekly-l1`} label="本周 API 等价" value={l1.text} dim={l1.dim} hint={VALUE_HINT} />
            {meter.agent === "codex" ? (
              <Stat
                label="本周 credit 等价"
                value={creditL1.text}
                dim={creditL1.dim}
                hint={CREDIT_HINT}
              />
            ) : null}
            {windowLabel !== "本周额度" ? (
              <Stat testId={`quota-${meter.agent}-five-hour-l1`} label="5h API 等价" value={winL1.text} dim={winL1.dim} hint={VALUE_HINT} />
            ) : null}
            {primary ? (
              <>
                <Stat
                  testId={`quota-${meter.agent}-token-coverage`}
                  label="可计价 token 覆盖率"
                  value={`${Math.round(primary.pricedTokenCoverage * 100)}%`}
                />
                <Stat
                  testId={`quota-${meter.agent}-event-coverage`}
                  label="可计价事件覆盖率"
                  value={`${Math.round(primary.pricedEventCoverage * 100)}%`}
                />
              </>
            ) : null}
            {valueSections.flatMap((section) => {
              const hasRange = section.value.confidence !== "none";
              return [
                <Stat
                  key={`${section.key}-total`}
                  testId={`quota-${meter.agent}-${section.key}-l2`}
                  label={`估算${section.label}总 API 等价`}
                  value={
                    hasRange
                      ? formatUsdRange(section.value.totalLowUsd, section.value.totalHighUsd)
                      : "样本不足"
                  }
                  hint={VALUE_HINT}
                />,
                <Stat
                  key={`${section.key}-remaining`}
                  testId={`quota-${meter.agent}-${section.key}-l3`}
                  label={`估算${section.label}剩余 API 等价`}
                  value={
                    hasRange
                      ? formatUsdRange(section.value.remainingLowUsd, section.value.remainingHighUsd)
                      : "样本不足"
                  }
                  hint={VALUE_HINT}
                />,
                <Stat
                  key={`${section.key}-confidence`}
                  testId={`quota-${meter.agent}-${section.key}-confidence`}
                  label={`${section.label}置信度`}
                  value={CONFIDENCE_LABEL[section.value.confidence]}
                />,
                <Stat
                  key={`${section.key}-calibration-source`}
                  testId={`quota-${meter.agent}-${section.key}-source`}
                  label={`${section.label}校准来源`}
                  value={calibrationSourceLabel(section.value.calibrationSource)}
                />,
              ];
            })}
            {meter.agent === "codex" && weekValue ? (
              <>
                <Stat
                  label="估算本周总 credit"
                  value={formatCreditRange(weekValue.totalLowCredits, weekValue.totalHighCredits)}
                  hint={CREDIT_HINT}
                />
                <Stat
                  label="估算本周剩余 credit"
                  value={formatCreditRange(
                    weekValue.remainingLowCredits,
                    weekValue.remainingHighCredits,
                  )}
                  hint={CREDIT_HINT}
                />
              </>
            ) : null}
            {primary ? <Stat label="价格版本" value={primary.pricingVersion} /> : null}
            {!valueSections.length ? (
              <>
                <Stat label="估算总 API 等价" value="样本不足" hint={VALUE_HINT} />
                {meter.agent === "codex" ? (
                  <Stat label="估算整窗 credit" value="样本不足" hint={CREDIT_HINT} />
                ) : null}
                <Stat label="置信度" value="无" />
              </>
            ) : null}
          </>
        )}
      </dl> : null}
      {!minimalMode && !officialOnly ? (
        <>
          <p className="mt-3 text-[11px] leading-5 text-faint">
            按当前片段模型组合校准 · 本地日志覆盖 · 不是账户现金余额
            {valueSections.some((section) => section.value.rolling) ? " · 滚动窗口金额" : ""}
            {diagnosticMessages.map((message) => (
              <span key={message} className="block">· {message}</span>
            ))}
          </p>

          {parallel ? (
            <div className="mt-3 rounded-xl bg-raised px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs tracking-wide text-faint uppercase">并行任务</p>
                <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-xs text-mute">
                  {parallel.total} 个活跃
                </span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {parallel.visible.map((task) => (
                  <li
                    key={task.actorId ?? task.sessionId}
                    className="flex min-w-0 items-center gap-2 text-xs"
                  >
                    <span className="size-1.5 shrink-0 rounded-full bg-ok" />
                    <span className="min-w-0 flex-1 truncate text-ink">{task.task}</span>
                    <span className="shrink-0 text-faint">
                      {task.actorKind === "workflow-subagent"
                        ? "工作流"
                        : task.actorKind === "subagent"
                          ? "子代理"
                          : "会话"}
                    </span>
                  </li>
                ))}
              </ul>
              {parallel.overflow > 0 ? (
                <p className="mt-2 text-xs text-faint">另有 {parallel.overflow} 个任务</p>
              ) : null}
            </div>
          ) : session && live ? (
            <div className="mt-3 rounded-xl bg-raised px-3 py-3">
              <p className="text-xs tracking-wide text-faint uppercase">实时会话</p>
              <p className="mt-1 text-sm text-ink">{session.task}</p>
              <p className="mt-1 font-mono text-xs text-mute">
                {modelLabel(session.model, session.modelRaw)} · {session.events} 轮 ·{" "}
                {formatTokens(session.tokens)}
              </p>
              {liveNote ? <p className="mt-1 text-xs text-mute">{liveNote}</p> : null}
            </div>
          ) : live ? (
            <div className="mt-3 rounded-xl bg-raised px-3 py-3 text-sm text-mute">
              {liveNote ?? "正在监听日志"}
            </div>
          ) : (
            <div className="mt-3 rounded-xl bg-raised px-3 py-3 text-sm text-mute">采集已暂停</div>
          )}

          <div className="mt-4 space-y-2">
            {shares.length ? (
              shares.map((s) => (
                <div key={s.label} className="flex items-center gap-3 text-xs">
                  <span className="w-28 truncate text-mute">{s.label}</span>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-raised">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        agentFillClass(tone),
                      )}
                      style={{ width: `${s.pct}%` }}
                    />
                  </div>
                  <span className="w-10 text-right font-mono tabular text-ink">
                    {s.pct.toFixed(0)}%
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-mute">本周尚无模型拆分</p>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function formatL1(value?: QuotaValue): { text: string; dim: boolean } {
  if (!value) return { text: "$0.00", dim: false };
  if (value.l1Tokens <= 0) return { text: formatUsd(0), dim: false };
  if (value.pricedTokenCoverage < 0.8) return { text: "价格覆盖不足", dim: true };
  const usd = formatUsd(value.l1Usd);
  if (value.pricedTokenCoverage < 0.95) return { text: `≥ ${usd}`, dim: false };
  return { text: usd, dim: false };
}

function formatCreditL1(value?: QuotaValue): { text: string; dim: boolean } {
  if (!value || value.l1Credits == null) return { text: "价格覆盖不足", dim: true };
  if (value.l1Tokens <= 0) return { text: "0", dim: false };
  if (value.pricedTokenCoverage < 0.8) return { text: "价格覆盖不足", dim: true };
  const credits = formatCredits(value.l1Credits);
  if (value.pricedTokenCoverage < 0.95) return { text: `≥ ${credits}`, dim: false };
  return { text: credits, dim: false };
}

function QuotaPoolRows({ rows, tone, now }: { rows: QuotaPoolView[]; tone: AgentId; now: number }) {
  if (!rows.length) return null;
  return (
    <div className="mt-4 space-y-3" aria-label="独立额度池">
      {rows.map(({ pool, valuation }) => {
        const label = quotaPoolLabel(pool);
        const suffix = pool.stale ? "（官方快照）" : "（官方）";
        if (valuation.kind === "stale") {
          return (
            <div key={pool.id} className="rounded-xl bg-raised px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-mute">{label}{suffix}</span>
                <span className="font-mono tabular text-ink">
                  {valuation.value.usedPercent == null
                    ? "—"
                    : `${valuation.value.usedPercent.toFixed(1)}%`}
                </span>
              </div>
              <p className="mt-1 text-faint">快照仅供参考，不参与校准或告警</p>
            </div>
          );
        }
        if (valuation.kind === "exact") {
          return (
            <div key={pool.id} className="rounded-xl bg-raised px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-mute">{label}{suffix}</span>
                <span className="font-mono tabular text-ink">
                  {valuation.value.usedPercent.toFixed(1)}%
                </span>
              </div>
              <p className="mt-1 text-faint">
                已用 {formatUsd(valuation.value.usedUsd)} / 上限 {formatUsd(valuation.value.limitUsd)}
                {` · 精确剩余 ${formatUsd(valuation.value.remainingUsd)}`}
              </p>
            </div>
          );
        }
        if (valuation.kind === "official") {
          return (
            <div key={pool.id} className="space-y-1.5">
              <MeterBar
                value={valuation.value.usedPercent}
                tone={tone}
                label={`${label}${suffix}`}
                detail={formatWeekResetLabel(pool.resetsAt, now, { prefix: "刷新" })}
              />
            </div>
          );
        }
        const value = valuation.value;
        return (
          <div key={pool.id} className="space-y-1.5">
            <MeterBar value={value.usedPct} tone={tone} label={`${label}${suffix}`} />
            <p className="text-[11px] text-faint">
              {value.confidence === "none"
                ? "API 等价样本不足"
                : `剩余 API 等价 ${formatUsdRange(value.remainingLowUsd, value.remainingHighUsd)}`}
              {` · ${calibrationSourceLabel(value.calibrationSource)}`}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function Stat({
  label,
  value,
  dim,
  hint,
  testId,
}: {
  label: string;
  value: string;
  dim?: boolean;
  hint?: string;
  testId?: string;
  compact?: boolean;
}) {
  return (
    <div className="rounded-xl bg-raised px-3 py-2.5" title={hint} data-testid={testId}>
      <dt className="text-faint">{label}</dt>
      <dd className={cn("mt-1 font-mono text-sm tabular", dim ? "text-faint" : "text-ink")}>
        {value}
      </dd>
    </div>
  );
}
