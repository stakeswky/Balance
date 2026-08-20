import { detectedAgentIds, type AgentAvailability } from "./agent-availability.ts";

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
