import { detectedAgentIds, type AgentAvailability } from "./agent-availability.ts";

export interface ClaudeStatuslineSetup {
  configured: boolean;
  conflict: boolean;
  fragment: {
    statusLine: { type: "command"; command: string };
  };
}

export const CLAUDE_STATUSLINE_COMMAND =
  '/usr/bin/env node "$HOME/.local/share/balance/bin/claude-statusline.mjs"';

export function claudeStatuslineSetup(
  settings: unknown,
): ClaudeStatuslineSetup {
  const root = settings && typeof settings === "object"
    ? settings as Record<string, unknown>
    : {};
  const current = root.statusLine && typeof root.statusLine === "object"
    ? root.statusLine as Record<string, unknown>
    : null;
  const command = CLAUDE_STATUSLINE_COMMAND;
  const currentCommand = typeof current?.command === "string" ? current.command : null;
  const configured = current?.type === "command" && currentCommand === command;
  return {
    configured,
    conflict: current != null && !configured,
    fragment: { statusLine: { type: "command", command } },
  };
}

export type OnboardingState = "checking" | "ready" | "empty" | "error";

export function onboardingState(
  availability: AgentAvailability,
  checking: boolean,
  error: string | null,
): OnboardingState {
  if (checking) return "checking";
  if (error) return "error";
  return detectedAgentIds(availability).length ? "ready" : "empty";
}
