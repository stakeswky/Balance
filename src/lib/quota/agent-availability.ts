import type { AgentId, UsageEvent } from "./types";

export const AGENT_IDS = ["claude", "grok", "codex"] as const satisfies readonly AgentId[];

export type AgentAvailability = Record<AgentId, boolean>;

export const EMPTY_AGENT_AVAILABILITY: AgentAvailability = {
  claude: false,
  grok: false,
  codex: false,
};

export const ALL_AGENT_AVAILABILITY: AgentAvailability = {
  claude: true,
  grok: true,
  codex: true,
};

export function detectedAgentIds(availability: AgentAvailability): AgentId[] {
  return AGENT_IDS.filter((agent) => availability[agent]);
}

export function visibleAgentIds(
  availability: AgentAvailability,
  demoMode: boolean,
  events: readonly UsageEvent[],
): AgentId[] {
  if (demoMode) return [...AGENT_IDS];
  return AGENT_IDS.filter(
    (agent) => availability[agent] || events.some((event) => event.agent === agent),
  );
}

export function eventsForAgents(
  events: readonly UsageEvent[],
  agents: readonly AgentId[],
): UsageEvent[] {
  const allowed = new Set(agents);
  return events.filter((event) => allowed.has(event.agent));
}
