import { AGENT_LABEL } from "./agent.ts";
import {
  eventsForAgents,
  visibleAgentIds,
  type AgentAvailability,
} from "./agent-availability.ts";
import {
  applyOfficial,
  formatDuration,
  meterDataSources,
  meterFor,
  modelWeekLimitFor,
  type MeterDataSource,
} from "./engine.ts";
import type { OfficialQuota } from "./official.ts";
import { planById } from "./plans.ts";
import type { AgentId, MeterSnapshot, UsageEvent } from "./types.ts";

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
    const plan = planById(
      agent === "claude" ? opts.claudePlanId : agent === "grok" ? opts.grokPlanId : opts.codexPlanId,
    );
    const official = opts.official[agent];
    const meter = applyOfficial(meterFor(events, agent, plan, opts.now, opts.weekBoostPct), official);
    const usedPct = meter.weekPct;
    const fableLimit = agent === "claude" ? modelWeekLimitFor(plan, official, "fable") : null;
    return {
      agent,
      label: AGENT_LABEL[agent],
      planName: official?.planLabel?.trim() || plan.name,
      usedPct,
      remainPct: Math.max(0, 100 - usedPct),
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
