import { rawTokens } from "./engine.ts";
import { WINDOW_MS, activityIdOf, type UsageAgentId, type UsageEvent } from "./types.ts";

export interface TimelineSession {
  id: string;
  start: number;
  end: number;
  tokens: number;
  task: string;
}

export function timelineSessions(
  events: UsageEvent[],
  agent: UsageAgentId,
  now: number,
): TimelineSession[] {
  const from = now - WINDOW_MS;
  const slice = events.filter((event) => event.agent === agent && event.ts >= from && event.ts <= now);
  const map = new Map<string, TimelineSession>();
  for (const event of slice) {
    const id = activityIdOf(event);
    const current = map.get(id);
    if (!current) {
      map.set(id, {
        id,
        start: event.ts,
        end: event.ts,
        tokens: rawTokens(event),
        task: event.task,
      });
      continue;
    }
    current.start = Math.min(current.start, event.ts);
    current.end = Math.max(current.end, event.ts);
    current.tokens += rawTokens(event);
  }
  return [...map.values()].map((session) => ({
    ...session,
    end: Math.max(session.end, session.start + 4 * 60_000),
  }));
}
