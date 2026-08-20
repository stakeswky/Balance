import claudeImport from "../../data/claude-import.json" with { type: "json" };
import { rawTokens } from "./engine.ts";
import { parseUsagePayload } from "./parse.ts";
import { activityIdOf, type SessionState, type UsageEvent } from "./types.ts";

export function importedClaudeEvents(): UsageEvent[] {
  return parseUsagePayload(JSON.stringify(claudeImport), "claude");
}

export function sessionFromEvents(events: UsageEvent[]): SessionState | null {
  const live = events.filter((event) => !event.sessionId.startsWith("daily-summary-"));
  const last = live[live.length - 1] ?? events[events.length - 1];
  if (!last) return null;
  const activityId = activityIdOf(last);
  const mine = live.filter((event) => activityIdOf(event) === activityId);
  const startedAt = mine[0]?.ts ?? last.ts;
  return {
    id: activityId,
    task: last.task,
    model: last.model,
    modelRaw: last.modelRaw,
    startedAt,
    events: mine.length,
    tokens: mine.reduce((sum, event) => sum + rawTokens(event), 0),
  };
}
