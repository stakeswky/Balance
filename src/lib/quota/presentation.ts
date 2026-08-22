import { formatDuration } from "./engine.ts";
import type { OfficialQuotaPool } from "./official.ts";
import type { ProductQuotaValue, QuotaValue } from "./quota-value.ts";
import type { AgentId, MeterSnapshot } from "./types.ts";

export interface QuotaPoolView {
  pool: OfficialQuotaPool;
  valuation: ProductQuotaValue;
}

export function quotaPoolLabel(pool: Pick<OfficialQuotaPool, "id" | "kind">): string {
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

export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
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
