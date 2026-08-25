import {
  formatDuration,
  type MeterDataSource,
  type MeterDataSources,
} from "./engine.ts";
import type { AntigravityQuotaGroup, OfficialQuotaPool } from "./official.ts";
import type { ProductQuotaValue, QuotaValue } from "./quota-value.ts";
import type { AgentId, MeterSnapshot } from "./types.ts";

export interface QuotaPoolView {
  pool: OfficialQuotaPool;
  valuation: ProductQuotaValue;
}

export function quotaPoolLabel(pool: Pick<OfficialQuotaPool, "id" | "kind" | "label">): string {
  if (pool.label) return pool.label;
  if (pool.id === "seven_day_fable") return "Fable 5 周池";
  if (pool.id === "seven_day_sonnet") return "Sonnet 周池";
  if (pool.id === "seven_day_opus") return "Opus 周池";
  if (pool.id === "extra_usage") return "额外用量";
  if (pool.kind === "model-week") return `${pool.id} 周池`;
  if (pool.kind === "extra-usage") return `${pool.id} 额度`;
  return pool.id;
}

export type PrimaryWindowKind = "five_hour" | "weekly";

export interface ApiEquivalentSection {
  key: PrimaryWindowKind;
  label: "5h" | "本周";
  value: QuotaValue;
}

export function apiEquivalentSections(
  agent: AgentId,
  primary: PrimaryWindowKind,
  weekly: QuotaValue,
  fiveHour: QuotaValue,
): ApiEquivalentSection[] {
  if (agent === "claude") {
    return [
      { key: "five_hour", label: "5h", value: fiveHour },
      { key: "weekly", label: "本周", value: weekly },
    ];
  }
  if (primary === "five_hour") return [{ key: "five_hour", label: "5h", value: fiveHour }];
  return [{ key: "weekly", label: "本周", value: weekly }];
}

function datePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function formatResetClock(ts: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const hour = datePart(parts, "hour").padStart(2, "0");
  const minute = datePart(parts, "minute").padStart(2, "0");
  return `${Number(datePart(parts, "month"))}月${Number(datePart(parts, "day"))}日 ${hour}:${minute}`;
}

export function formatWeekResetLabel(
  resetsAt: number | null | undefined,
  now: number,
  opts?: { timeZone?: string; prefix?: string },
): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const clock = formatResetClock(resetsAt, opts?.timeZone);
  const prefix = opts?.prefix ?? "周限额刷新";
  const remain = resetsAt - now;
  if (remain <= 0) return `${prefix} ${clock} · 已过`;
  return `${prefix} ${clock} · ${formatDuration(remain)}`;
}

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

export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function nonNeg(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Display-only week token pair in raw units (cache counted 1:1).
 * Quota percent / weighted share math stays in the meter engine.
 */
export function displayWeekTokens(input: {
  weekTokens: number;
  weekBudget: number;
  weekWeightedTokens: number;
  weekValue?: Pick<QuotaValue, "usedPct" | "l1Tokens"> | null;
}): { used: number; total: number } {
  const weekTokens = nonNeg(input.weekTokens);
  const weekBudget = nonNeg(input.weekBudget);
  const weighted = nonNeg(input.weekWeightedTokens);
  const l1 = input.weekValue ? nonNeg(input.weekValue.l1Tokens) : 0;
  const used = l1 > 0 ? l1 : weekTokens;
  const usedPct = input.weekValue?.usedPct;
  const hasOfficialPct =
    usedPct != null && Number.isFinite(usedPct) && usedPct >= 1 && used > 0;

  let total = weekBudget;
  if (hasOfficialPct) {
    total = used / (Math.min(usedPct, 100) / 100);
  } else if (used > 0 && weighted > 0 && weekBudget > 0) {
    total = weekBudget * (used / weighted);
  }
  return { used, total };
}

export function formatCreditRange(low: number | null, high: number | null): string {
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) return "样本不足";
  return `${formatCredits(low)}–${formatCredits(high)}`;
}

export function primaryUsagePercent(meter: MeterSnapshot, kind: PrimaryWindowKind): number {
  return kind === "weekly" ? meter.weekPct : meter.windowPct;
}

export function primaryWindowLabel(kind: PrimaryWindowKind): "5 小时窗" | "本周额度" {
  return kind === "weekly" ? "本周额度" : "5 小时窗";
}

export function primaryWindowResetsAt(meter: MeterSnapshot, kind: PrimaryWindowKind): number {
  return kind === "weekly" ? meter.weekResetsAt : meter.windowResetsAt;
}

export interface PrimaryMeterWindow {
  kind: PrimaryWindowKind;
  pct: number;
  resetsAt: number;
}

export function tightestMeterWindow(
  meter: MeterSnapshot,
  kinds: readonly PrimaryWindowKind[] = ["five_hour", "weekly"],
): PrimaryMeterWindow | null {
  const first = kinds[0];
  if (!first) return null;
  const kind = kinds.slice(1).reduce(
    (selected, candidate) =>
      primaryUsagePercent(meter, candidate) >= primaryUsagePercent(meter, selected)
        ? candidate
        : selected,
    first,
  );
  return {
    kind,
    pct: primaryUsagePercent(meter, kind),
    resetsAt: primaryWindowResetsAt(meter, kind),
  };
}

export function officialPrimaryMeterWindow(
  meter: MeterSnapshot,
  sources: MeterDataSources,
): PrimaryMeterWindow | null {
  const kindsFor = (source: MeterDataSource): PrimaryWindowKind[] => [
    ...(sources.window === source ? ["five_hour" as const] : []),
    ...(sources.week === source ? ["weekly" as const] : []),
  ];
  const freshKinds = kindsFor("official");
  return tightestMeterWindow(
    meter,
    freshKinds.length ? freshKinds : kindsFor("official-stale"),
  );
}

export interface AntigravityQuotaGroupSummary {
  group: AntigravityQuotaGroup;
  label: "Gemini 模型" | "Claude / GPT 模型";
  kind: PrimaryWindowKind;
  usedPct: number;
  resetsAt: number | null;
  stale: boolean;
}

const ANTIGRAVITY_GROUPS = [
  { group: "gemini", label: "Gemini 模型" },
  { group: "claude-gpt", label: "Claude / GPT 模型" },
] as const;

export function antigravityQuotaGroupSummaries(
  pools: readonly OfficialQuotaPool[],
): AntigravityQuotaGroupSummary[] {
  return ANTIGRAVITY_GROUPS.flatMap(({ group, label }) => {
    const candidates = pools.filter((pool) =>
      pool.quotaGroup === group
      && pool.quotaWindow != null
      && pool.usagePercent != null
      && Number.isFinite(pool.usagePercent),
    );
    const fresh = candidates.filter((pool) => !pool.stale);
    const selected = [...(fresh.length ? fresh : candidates)]
      .sort((left, right) => (right.usagePercent ?? -1) - (left.usagePercent ?? -1))[0];
    if (!selected || !selected.quotaWindow || selected.usagePercent == null) return [];
    return [{
      group,
      label,
      kind: selected.quotaWindow,
      usedPct: selected.usagePercent,
      resetsAt: selected.resetsAt,
      stale: Boolean(selected.stale),
    }];
  });
}

export function effectiveQuotaStatus(
  meterStatus: MeterSnapshot["status"],
  extraUsedPct: number | null | undefined,
): MeterSnapshot["status"] {
  const extraStatus =
    extraUsedPct == null || extraUsedPct < 72 ? "ok" : extraUsedPct >= 88 ? "critical" : "watch";
  if (meterStatus === "critical" || extraStatus === "critical") return "critical";
  if (meterStatus === "watch" || extraStatus === "watch") return "watch";
  return "ok";
}

export function tightestQuota<T extends { pct: number }>(limits: readonly T[]): T | null {
  return [...limits].sort((a, b) => b.pct - a.pct)[0] ?? null;
}

export function quotaAlertLatch(
  usedPct: number | null,
  threshold: number,
  warned: boolean,
): { triggered: boolean; nextWarned: boolean } {
  if (usedPct == null || usedPct < threshold - 12) {
    return { triggered: false, nextWarned: false };
  }
  if (usedPct >= threshold) {
    return { triggered: !warned, nextWarned: true };
  }
  return { triggered: false, nextWarned: warned };
}

export function quotaAlertDecision(opts: {
  meter: MeterSnapshot;
  kind: PrimaryWindowKind;
  windowThreshold: number;
  weekThreshold: number;
}): {
  primaryTriggered: boolean;
  primaryPercent: number;
  primaryThreshold: number;
  primaryLabel: "5 小时窗" | "本周额度";
  weekTriggered: boolean;
} {
  const primaryPercent = primaryUsagePercent(opts.meter, opts.kind);
  const primaryThreshold = opts.kind === "weekly" ? opts.weekThreshold : opts.windowThreshold;
  return {
    primaryTriggered: primaryPercent >= primaryThreshold,
    primaryPercent,
    primaryThreshold,
    primaryLabel: primaryWindowLabel(opts.kind),
    weekTriggered: opts.kind !== "weekly" && opts.meter.weekPct >= opts.weekThreshold,
  };
}
