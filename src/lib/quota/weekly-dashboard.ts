import { AGENT_LABEL } from "./agent.ts";
import {
  eventsForAgents,
  visibleAgentIds,
  type AgentAvailability,
} from "./agent-availability.ts";
import {
  applyOfficial,
  emptyMeter,
  formatDuration,
  meterDataSources,
  meterFor,
  modelWeekLimitFor,
  type MeterDataSource,
} from "./engine.ts";
import type { OfficialQuota } from "./official.ts";
import { planById } from "./plans.ts";
import { isUsageAgentId, type AgentId, type MeterSnapshot, type UsageEvent } from "./types.ts";

export interface WeeklyFableLimit {
  usedPct: number;
  remainPct: number;
  limitPctOfWeek: number;
  stale: boolean;
}

export interface WeeklyQuotaRow {
  agent: AgentId;
  label: string;
  planName: string;
  usedPct: number;
  remainPct: number;
  windowUsedPct: number;
  windowRemainPct: number;
  resetsAt: number;
  source: MeterDataSource;
  status: MeterSnapshot["status"];
  fable?: WeeklyFableLimit;
}

export function weeklyQuotaRows(opts: {
  events: UsageEvent[];
  availability: AgentAvailability;
  demoMode: boolean;
  official: OfficialQuota;
  claudePlanId: string;
  grokPlanId: string;
  codexPlanId: string;
  weekBoostPct: number;
  now: number;
}): WeeklyQuotaRow[] {
  const agents = visibleAgentIds(opts.availability, opts.demoMode, opts.events);
  const events = eventsForAgents(opts.events, agents);
  return agents.map((agent) => {
    const official = opts.official[agent];
    if (!isUsageAgentId(agent)) {
      const meter = applyOfficial(emptyMeter(agent, opts.now), official);
      const usedPct = meter.weekPct;
      return {
        agent,
        label: AGENT_LABEL[agent],
        planName: official?.planLabel?.trim() || "官方余量",
        usedPct,
        remainPct: Math.max(0, 100 - usedPct),
        windowUsedPct: meter.windowPct,
        windowRemainPct: Math.max(0, 100 - meter.windowPct),
        resetsAt: meter.weekResetsAt,
        source: meterDataSources(official).week,
        status: usedPct >= 88 ? "critical" : usedPct >= 72 ? "watch" : "ok",
      };
    }
    const plan = planById(
      agent === "claude" ? opts.claudePlanId : agent === "grok" ? opts.grokPlanId : opts.codexPlanId,
    );
    const meter = applyOfficial(meterFor(events, agent, plan, opts.now, opts.weekBoostPct), official);
    const usedPct = meter.weekPct;
    const fableLimit = agent === "claude" ? modelWeekLimitFor(plan, official, "fable") : null;
    return {
      agent,
      label: AGENT_LABEL[agent],
      planName: official?.planLabel?.trim() || plan.name,
      usedPct,
      remainPct: Math.max(0, 100 - usedPct),
      windowUsedPct: meter.windowPct,
      windowRemainPct: Math.max(0, 100 - meter.windowPct),
      resetsAt: meter.weekResetsAt,
      source: meterDataSources(official).week,
      status: usedPct >= 88 ? "critical" : usedPct >= 72 ? "watch" : "ok",
      fable: fableLimit
        ? {
            usedPct: fableLimit.usedPct,
            remainPct: Math.max(0, 100 - fableLimit.usedPct),
            limitPctOfWeek: fableLimit.limitPctOfWeek,
            stale: Boolean(official?.modelWeekLimitsStale),
          }
        : undefined,
    };
  });
}

export function formatResetIn(resetsAt: number, now: number): string {
  const remaining = resetsAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "即将重置";
  return `${formatDuration(remaining)}后重置`;
}

export function weekSourceLabel(source: MeterDataSource): string {
  if (source === "official") return "官方";
  if (source === "official-stale") return "官方快照";
  return "本地估算";
}

export function subscriptionLoad(row: WeeklyQuotaRow): number {
  return Math.max(row.usedPct, row.windowUsedPct);
}

export function pickPreferredSubscription(
  rows: readonly WeeklyQuotaRow[],
): WeeklyQuotaRow | null {
  if (!rows.length) return null;
  return rows.reduce((best, row) =>
    subscriptionLoad(row) < subscriptionLoad(best) ? row : best,
  );
}

export function preferredSubscriptionHint(
  preferred: WeeklyQuotaRow,
  rows: readonly WeeklyQuotaRow[],
): { title: string; body: string } {
  const name = AGENT_LABEL[preferred.agent];
  const load = subscriptionLoad(preferred);
  const othersTight = rows.some(
    (row) => row.agent !== preferred.agent && subscriptionLoad(row) >= 70,
  );
  if (othersTight && load < 40) {
    return { title: `现在用 ${name}`, body: `${name} 更宽裕，下一趟长任务走这一路。` };
  }
  if (load >= 68) {
    return { title: `现在用 ${name}`, body: "各路都偏紧，短任务优先，重活等回补。" };
  }
  if (rows.length === 1) {
    return { title: `现在用 ${name}`, body: "当前只有这一路可监控。" };
  }
  return { title: `现在用 ${name}`, body: `${name} 剩余最多，优先走这一路。` };
}
