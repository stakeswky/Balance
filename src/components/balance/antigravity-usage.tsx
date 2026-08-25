import { useMemo } from "react";
import { formatTokens, formatUsd } from "@/components/balance/format";
import {
  aggregateAntigravityUsage,
  antigravityModelLabel,
  type AntigravityGroupUsage,
  type AntigravityPricingSemantics,
  type AntigravityQuotaGroup,
  type AntigravityUsageEvent,
  type AntigravityUsageTotals,
} from "@/lib/quota/antigravity-usage";
import { WEEK_MS, WINDOW_MS } from "@/lib/quota/types";

function costText(usage: AntigravityUsageTotals): string {
  if (usage.totalTokens > 0 && usage.pricedTokens === 0) return "无官方单价";
  const formatted = formatUsd(usage.apiEquivalentUsd);
  return usage.pricingCoverage < 0.999 ? `≥ ${formatted}` : formatted;
}

function semanticsText(semantics: AntigravityPricingSemantics): string {
  if (semantics === "google-api-equivalent") return "Google API 等价";
  if (semantics === "anthropic-api-estimate") return "Anthropic 公价估算";
  return "无官方单价";
}

export function AntigravityGroupUsageInline({
  group,
  summary,
}: {
  group: AntigravityQuotaGroup;
  summary: AntigravityGroupUsage | null;
}) {
  if (!summary || summary.totalTokens === 0) {
    return <p className="mt-2 text-xs text-faint">本周本机无记录</p>;
  }
  return (
    <div className="mt-2 flex items-end justify-between gap-3 border-t border-line/50 pt-2 text-xs">
      <div>
        <p className="text-faint">本周本机 · {summary.calls} 次 · {summary.models.length} 个模型</p>
        <p
          className="mt-0.5 font-mono text-sm tabular text-ink"
          data-testid={`quota-antigravity-${group}-week-tokens`}
        >
          {formatTokens(summary.totalTokens)} token
        </p>
      </div>
      <span
        className="font-mono tabular text-mute"
        data-testid={`quota-antigravity-${group}-week-cost`}
      >
        {costText(summary)}
      </span>
    </div>
  );
}

function UsageStat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-xl bg-raised px-3 py-2.5" data-testid={testId}>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular text-ink">{value}</dd>
    </div>
  );
}

export function AntigravityUsageDetails({
  events,
  now,
  truncated,
}: {
  events: AntigravityUsageEvent[];
  now: number;
  truncated: boolean;
}) {
  const windowUsage = useMemo(
    () => aggregateAntigravityUsage(events, now - WINDOW_MS),
    [events, now],
  );
  const weekUsage = useMemo(
    () => aggregateAntigravityUsage(events, now - WEEK_MS),
    [events, now],
  );
  return (
    <section className="mt-4" aria-label="Antigravity 本机逐模型用量">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs tracking-wide text-faint uppercase">本机逐模型用量</h3>
        <span className="text-xs text-faint">不等于账户完整账单</span>
      </div>
      {truncated ? (
        <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-xs text-mute">
          本机记录受扫描上限限制，当前数字可能不完整
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-2 gap-3 text-xs">
        <UsageStat label="本机 5h token" value={formatTokens(windowUsage.totalTokens)} testId="quota-antigravity-usage-window-tokens" />
        <UsageStat label="本周 token" value={formatTokens(weekUsage.totalTokens)} testId="quota-antigravity-usage-week-tokens" />
        <UsageStat label="本周调用" value={`${weekUsage.calls} 次`} testId="quota-antigravity-usage-week-calls" />
        <UsageStat label="本周 API 等价" value={costText(weekUsage)} testId="quota-antigravity-usage-week-cost" />
      </dl>
      <div className="mt-3 space-y-2">
        {weekUsage.models.length === 0 ? (
          <p className="rounded-xl bg-raised px-3 py-3 text-sm text-mute">本机本周尚无可解析用量</p>
        ) : weekUsage.models.map((model) => (
          <article key={model.model} className="rounded-xl bg-raised px-3 py-3 text-xs">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{antigravityModelLabel(model.model)}</p>
                <p className="mt-1 text-faint">
                  输入 {formatTokens(model.inputTokens)} · 缓存 {formatTokens(model.cacheReadTokens)} · 输出 {formatTokens(model.outputTokens)}
                </p>
                <p className="mt-1 text-faint">
                  思考 {formatTokens(model.thinkingTokens)} · 正文 {formatTokens(model.responseTokens)} · {model.calls} 次
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono tabular text-ink">{costText(model)}</p>
                <p className="mt-1 text-faint">{semanticsText(model.pricingSemantics)}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
