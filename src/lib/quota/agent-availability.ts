import type { AgentId, UsageAgentId, UsageEvent } from "./types";

export const USAGE_AGENT_IDS = ["claude", "grok", "codex"] as const satisfies readonly UsageAgentId[];
export const AGENT_IDS = [...USAGE_AGENT_IDS, "antigravity"] as const satisfies readonly AgentId[];

export type AgentAvailability = Record<AgentId, boolean>;

export const EMPTY_AGENT_AVAILABILITY: AgentAvailability = {
  claude: false,
  grok: false,
  codex: false,
  antigravity: false,
};

export const ALL_AGENT_AVAILABILITY: AgentAvailability = {
  claude: true,
  grok: true,
  codex: true,
  antigravity: true,
};

export function detectedAgentIds(availability: AgentAvailability): AgentId[] {
  return AGENT_IDS.filter((agent) => availability[agent]);
}

export function visibleAgentIds(
  availability: AgentAvailability,
  demoMode: boolean,
  events: readonly UsageEvent[],
): AgentId[] {
  if (demoMode) return [...USAGE_AGENT_IDS];
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
