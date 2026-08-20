import { Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardHint, CardTitle } from "@/components/ui/card";
import { formatDuration, formatTokens, formatUsd, formatUsdRange, modelLabel } from "@/components/synq/format";
import { MeterBar } from "@/components/synq/meter-bar";
import { inWindow, modelShares, weightedTokens } from "@/lib/quota/engine";
import { grokProductLabel, type OfficialProductShare } from "@/lib/quota/official";
import {
  apiEquivalentSections,
  effectiveQuotaStatus,
  formatCreditRange,
  formatCredits,
} from "@/lib/quota/presentation";
import type { QuotaValue } from "@/lib/quota/quota-value";
import type {
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
  liveNote,
  windowLabel = "5 小时窗",
  quotaNote,
  products,
  modelWeekLimit,
  weekValue,
  windowValue,
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
  liveNote?: string;
  windowLabel?: string;
  quotaNote?: string;
  products?: OfficialProductShare[];
  modelWeekLimit?: ModelWeekLimitSnapshot | null;
  weekValue?: QuotaValue;
  windowValue?: QuotaValue;
  events: UsageEvent[];
  now: number;
  onToggle: () => void;
}) {
  const tone = meter.agent;
  const shares = modelShares(events, meter.agent, now, WEEK_MS);
  const primaryPct = windowLabel === "本周额度" ? meter.weekPct : meter.windowPct;
  const remain = Math.max(0, 100 - primaryPct);
  const weighted = inWindow(events, now, WINDOW_MS, meter.agent).reduce((s, e) => s + weightedTokens(e), 0);
  const effectiveStatus = effectiveQuotaStatus(meter.status, modelWeekLimit?.usedPct);
  const barTone = meter.status === "critical" ? "crit" : meter.status === "watch" ? "warn" : tone;
  const primaryKind = windowLabel === "本周额度" ? "weekly" : "five_hour";
  const primary = primaryKind === "weekly" ? weekValue : windowValue;
  const valueSections =
    weekValue && windowValue
      ? apiEquivalentSections(meter.agent, primaryKind, weekValue, windowValue)
      : [];
  const l1 = formatL1(weekValue);
  const winL1 = formatL1(windowValue);
  const creditL1 = formatCreditL1(weekValue);

  return (
    <Card>
      <CardHeader className="min-w-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint")} />
            <CardTitle>{name}</CardTitle>
            <Badge tone={effectiveStatus}>{statusCopy[effectiveStatus]}</Badge>
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
          <p className="text-xs text-mute">{windowLabel === "本周额度" ? "周额度剩余" : "窗口剩余"}</p>
          <p className="mt-1 font-mono text-4xl leading-none font-medium tracking-tight tabular">
            {remain.toFixed(0)}
            <span className="ml-1 text-lg text-mute">%</span>
          </p>
        </div>
        <div className="text-right text-xs text-mute">
          {windowLabel === "本周额度" ? (
            <>
              <p>
                已用 {meter.weekPct.toFixed(meter.weekPct >= 10 ? 0 : 1)}
                <span className="text-faint"> %</span>
              </p>
              <p className="mt-1">
                {meter.agent === "codex" ? "credit 按公开价等价折算" : "API 等价按公开价折算"}
              </p>
            </>
          ) : (
            <>
              <p>
                燃烧 {meter.burnPctPerHour.toFixed(1)}
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

      <div className="mt-5 space-y-3">
        {windowLabel === "本周额度" ? (
          <MeterBar
            value={meter.weekPct}
            tone={meter.weekPct >= 88 ? "crit" : meter.weekPct >= 72 ? "warn" : tone}
            label="本周额度（官方）"
          />
        ) : (
          <>
            <MeterBar
              value={meter.windowPct}
              tone={barTone === "crit" || barTone === "warn" ? barTone : tone}
              label={quotaNote && windowLabel === "5 小时窗" ? "5 小时窗（官方）" : windowLabel}
            />
            <MeterBar
              value={meter.weekPct}
              tone={meter.weekPct >= 88 ? "crit" : meter.weekPct >= 72 ? "warn" : tone}
              label={quotaNote ? "本周额度（官方）" : "本周额度"}
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
                  label="Fable 5 周额度（本机估算）"
                />
                <p className="text-xs leading-relaxed text-faint">
                  {`Claude Max 的 Fable 5 上限为总周额度的 ${modelWeekLimit.limitPctOfWeek}%；未包含其他设备用量。`}
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
            meter.agent === "codex" ? `${meter.windowReasoningMin.toFixed(1)} 分` : formatTokens(weighted)
          }
        />
        <Stat label="本周 token" value={formatTokens(meter.weekTokens)} />
        <Stat
          label="本周 API 等价"
          value={l1.text}
          dim={l1.dim}
          hint={VALUE_HINT}
        />
        {meter.agent === "codex" ? (
          <Stat
            label="本周 credit 等价"
            value={creditL1.text}
            dim={creditL1.dim}
            hint={CREDIT_HINT}
          />
        ) : null}
        {windowLabel !== "本周额度" ? (
          <Stat label="5h API 等价" value={winL1.text} dim={winL1.dim} hint={VALUE_HINT} />
        ) : null}
        <Stat
          label="本地价格覆盖率"
          value={`${Math.round((weekValue?.pricedTokenCoverage ?? 0) * 100)}%`}
        />
        {valueSections.flatMap((section) => {
          const hasRange = section.value.confidence !== "none";
          return [
            <Stat
              key={`${section.key}-total`}
              label={`估算${section.label}总 API 等价`}
              value={hasRange ? formatUsdRange(section.value.totalLowUsd, section.value.totalHighUsd) : "样本不足"}
              hint={VALUE_HINT}
            />,
            <Stat
              key={`${section.key}-remaining`}
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
              label={`${section.label}置信度`}
              value={CONFIDENCE_LABEL[section.value.confidence]}
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
              value={formatCreditRange(weekValue.remainingLowCredits, weekValue.remainingHighCredits)}
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
      <p className="mt-3 text-[11px] leading-5 text-faint">
        按当前片段模型组合校准 · 本地日志覆盖 · 不是账户现金余额
        {valueSections.some((section) => section.value.rolling) ? " · 滚动窗口金额" : ""}
        {valueSections.some((section) => section.value.externalUsageDetected) ? " · 检测到本机以外用量" : ""}
      </p>

      {session && live ? (
        <div className="mt-5 rounded-md bg-raised px-3 py-3">
          <p className="text-xs tracking-wide text-faint uppercase">实时会话</p>
          <p className="mt-1 text-sm text-ink">{session.task}</p>
          <p className="mt-1 font-mono text-xs text-mute">
            {modelLabel(session.model, session.modelRaw)} · {session.events} 轮 · {formatTokens(session.tokens)}
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
              <span className="w-10 text-right font-mono tabular text-ink">{s.pct.toFixed(0)}%</span>
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
}: {
  label: string;
  value: string;
  dim?: boolean;
  hint?: string;
}) {
  return (
    <div className="rounded-md bg-raised px-3 py-2.5" title={hint}>
      <dt className="text-faint">{label}</dt>
      <dd className={cn("mt-1 font-mono text-sm tabular", dim ? "text-faint" : "text-ink")}>{value}</dd>
    </div>
  );
}
