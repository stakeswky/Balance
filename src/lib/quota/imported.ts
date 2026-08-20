import claudeImport from "../../data/claude-import.json" with { type: "json" };
import { rawTokens } from "./engine.ts";
import { parseUsagePayload } from "./parse.ts";
import type { SessionState, UsageEvent } from "./types.ts";

export function importedClaudeEvents(): UsageEvent[] {
  return parseUsagePayload(JSON.stringify(claudeImport), "claude");
}

export function sessionFromEvents(events: UsageEvent[]): SessionState | null {
  const live = events.filter((e) => !e.sessionId.startsWith("daily-summary-"));
  const last = live[live.length - 1] ?? events[events.length - 1];
  if (!last) return null;
  const mine = live.filter((e) => e.sessionId === last.sessionId);
  const startedAt = mine[0]?.ts ?? last.ts;
  return {
    id: last.sessionId,
    task: last.task,
    model: last.model,
    modelRaw: last.modelRaw,
    startedAt,
    events: mine.length,
    tokens: mine.reduce((s, e) => s + rawTokens(e), 0),
  };
}
