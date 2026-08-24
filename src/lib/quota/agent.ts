import type { AgentId } from "./types";

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  grok: "Grok",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function agentDotClass(agent: AgentId): string {
  if (agent === "claude") return "bg-claude";
  if (agent === "grok") return "bg-grok";
  if (agent === "antigravity") return "bg-antigravity";
  return "bg-codex";
}

export function agentTextClass(agent: AgentId): string {
  if (agent === "claude") return "text-claude";
  if (agent === "grok") return "text-grok";
  if (agent === "antigravity") return "text-antigravity";
  return "text-codex";
}

export function agentFillClass(agent: AgentId): string {
  if (agent === "claude") return "bg-claude";
  if (agent === "grok") return "bg-grok";
  if (agent === "antigravity") return "bg-antigravity";
  return "bg-codex";
}
