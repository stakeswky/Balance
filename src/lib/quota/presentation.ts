import type { QuotaValue } from "./quota-value.ts";
import type { AgentId, MeterSnapshot } from "./types.ts";

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
