import { Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardHint, CardTitle } from "@/components/ui/card";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  formatUsdRange,
  modelLabel,
} from "@/components/balance/format";
import { MeterBar } from "@/components/balance/meter-bar";
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
  apiEquivalentSections,
  effectiveQuotaStatus,
  formatCreditRange,
  formatCredits,
  formatWeekResetLabel,
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
  AgentLiveInfo,
  MeterSnapshot,
  ModelWeekLimitSnapshot,
  PlanDef,
  SessionState,
  UsageEvent,
} from "@/lib/quota/types";
import { WEEK_MS, WINDOW_MS } from "@/lib/quota/types";
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
  activeTasks,
  liveNote,
  windowLabel = "5 小时窗",
  quotaNote,
  products,
  modelWeekLimit,
  modelWeekLimitStale = false,
  quotaSources = { window: "local-estimate", week: "local-estimate" },
  officialLoadState,
  weekValue,
  windowValue,
  weekResetsAt,
  events,
  now,
  onToggle,
}: {
  name: string;
  adapter: string;
  plan: PlanDef;
  meter: MeterSnapshot;
  session: SessionState | null;
  live: boolean;
  activeTasks?: AgentLiveInfo[];
  liveNote?: string;
  windowLabel?: string;
  quotaNote?: string;
  products?: OfficialProductShare[];
  modelWeekLimit?: ModelWeekLimitSnapshot | null;
  modelWeekLimitStale?: boolean;
  quotaSources?: MeterDataSources;
  officialLoadState?: OfficialLoadState;
  weekValue?: QuotaValue;
  windowValue?: QuotaValue;
  weekResetsAt?: number | null;
  events: UsageEvent[];
  now: number;
  onToggle: () => void;
}) {
  const tone = meter.agent;
  const shares = modelShares(events, meter.agent, now, WEEK_MS);
  const primaryPct = windowLabel === "本周额度" ? meter.weekPct : meter.windowPct;
  const remain = Math.max(0, 100 - primaryPct);
  const weighted = inWindow(events, now, WINDOW_MS, meter.agent).reduce(
    (s, e) => s + weightedTokens(e),
    0,
  );
  const primaryKind = windowLabel === "本周额度" ? "weekly" : "five_hour";
  const primarySource = primaryKind === "weekly" ? quotaSources.week : quotaSources.window;
  const freshMeter = officialOnlyMeter(meter, quotaSources);
  const freshModelWeekLimit = modelWeekLimitStale ? null : modelWeekLimit;
  const hasFreshOfficial = Boolean(freshMeter || freshModelWeekLimit);
  const hasLocalEstimate = Object.values(quotaSources).includes("local-estimate");
  const hasStaleSnapshot =
    Object.values(quotaSources).includes("official-stale") ||
    Boolean(modelWeekLimit && modelWeekLimitStale);
  const sourceMessage = officialLoadState
    ? quotaSourceMessage(officialLoadState, hasFreshOfficial, hasLocalEstimate, hasStaleSnapshot)
    : null;
  const effectiveStatus = effectiveQuotaStatus(
    freshMeter?.status ?? "ok",
    freshModelWeekLimit?.usedPct,
  );
  const statusLabel = hasFreshOfficial
    ? statusCopy[effectiveStatus]
    : hasStaleSnapshot
      ? "官方快照"
      : "本地估算";
  const primaryRemainingLabel =
    primarySource === "official"
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
  const primaryUsedLabel =
    primarySource === "official"
      ? "已用"
      : primarySource === "official-stale"
        ? "快照已用"
        : "估算已用";
  const primary = primaryKind === "weekly" ? weekValue : windowValue;
  const valueSections =
    weekValue && windowValue
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

  return (
    <Card>
      <CardHeader className="min-w-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint")} />
            <CardTitle>{name}</CardTitle>
            <Badge tone={hasFreshOfficial ? effectiveStatus : "mute"}>{statusLabel}</Badge>
          </div>
          <CardHint className="mt-1 break-words">
            {plan.name} · {adapter}
            {quotaNote ? ` · ${quotaNote}` : ""}
          </CardHint>
        </div>
        <Button variant="secondary" size="sm" onClick={onToggle} aria-pressed={live}>
          {live ? <Pause /> : <Play />}
          {live ? "暂停" : "采集"}
        </Button>
      </CardHeader>

      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs text-mute">{primaryRemainingLabel}</p>
          <p className="mt-1 font-mono text-4xl leading-none font-medium tracking-tight tabular">
            {remain.toFixed(0)}
            <span className="ml-1 text-lg text-mute">%</span>
          </p>
        </div>
        <div className="text-right text-xs text-mute">
          {windowLabel === "本周额度" ? (
            <>
              <p>
                {primaryUsedLabel} {meter.weekPct.toFixed(meter.weekPct >= 10 ? 0 : 1)}
                <span className="text-faint"> %</span>
              </p>
              <p className="mt-1">
                {meter.agent === "codex" ? "credit 按公开价等价折算" : "API 等价按公开价折算"}
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
      </div>

      {sourceMessage ? (
        <p className="mt-4 rounded-lg bg-raised px-3 py-2 text-xs leading-relaxed text-mute">
          {sourceMessage}
        </p>
      ) : null}

      <div className="mt-5 space-y-3">
        {windowLabel === "本周额度" ? (
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
            label={quotaSourceLabel("本周额度", quotaSources.week)}
            detail={weekReset}
          />
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
              label={quotaSourceLabel("本周额度", quotaSources.week)}
              detail={weekReset}
            />
            {modelWeekLimit ? (
              <>
                <MeterBar
                  value={modelWeekLimit.usedPct}
                  tone={
                    modelWeekLimit.usedPct >= 88
                      ? "crit"
                      : modelWeekLimit.usedPct >= 72
                        ? "warn"
                        : tone
                  }
                  label={quotaSourceLabel(
                    "Fable 5 周额度",
                    modelWeekLimitStale ? "official-stale" : "official",
                  )}
                />
                <p className="text-xs leading-relaxed text-faint">
                  {`Claude Max 的 Fable 5 套餐上限为总周额度的 ${modelWeekLimit.limitPctOfWeek}%；${
                    modelWeekLimitStale
                      ? "当前显示上次成功读取的官方利用率。"
                      : "当前利用率来自 Claude Code。"
                  }`}
                </p>
              </>
            ) : null}
          </>
        )}
      </div>

      {products?.some((p) => p.usagePercent != null) ? (
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
                      tone === "claude" ? "bg-claude" : tone === "grok" ? "bg-grok" : "bg-codex",
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

      <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
        <Stat label="本窗 token" value={formatTokens(meter.windowTokens)} />
        <Stat
          label={meter.agent === "codex" ? "本窗推理" : "加权用量"}
          value={
            meter.agent === "codex"
              ? `${meter.windowReasoningMin.toFixed(1)} 分`
              : formatTokens(weighted)
          }
        />
        <Stat label="本周 token" value={formatTokens(meter.weekTokens)} />
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
      </dl>
      <div className="mt-3 space-y-1 text-[11px] leading-5 text-faint">
        <p>
          本地日志按公开 API 价折算 · 不是账户现金余额
          {valueSections.some((section) => section.value.rolling) ? " · 滚动窗口只显示已观测下界" : ""}
        </p>
        {diagnosticMessages.map((message) => (
          <p key={message}>· {message}</p>
        ))}
      </div>

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
        <div className="mt-5 rounded-md bg-raised px-3 py-3">
          <p className="text-xs tracking-wide text-faint uppercase">实时会话</p>
          <p className="mt-1 text-sm text-ink">{session.task}</p>
          <p className="mt-1 font-mono text-xs text-mute">
            {modelLabel(session.model, session.modelRaw)} · {session.events} 轮 ·{" "}
            {formatTokens(session.tokens)}
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

      <div className="mt-4 space-y-2">
        {shares.length ? (
          shares.map((s) => (
            <div key={s.label} className="flex items-center gap-3 text-xs">
              <span className="w-28 truncate text-mute">{s.label}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-raised">
                <div
                  className={cn(
                    "h-full rounded-full",
                    tone === "claude" ? "bg-claude" : tone === "grok" ? "bg-grok" : "bg-codex",
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
}) {
  return (
    <div className="rounded-md bg-raised px-3 py-2.5" title={hint} data-testid={testId}>
      <dt className="text-faint">{label}</dt>
      <dd className={cn("mt-1 font-mono text-sm tabular", dim ? "text-faint" : "text-ink")}>
        {value}
      </dd>
    </div>
  );
}
