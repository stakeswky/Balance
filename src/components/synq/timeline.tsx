import { rawTokens } from "@/lib/quota/engine";
import type { UsageEvent } from "@/lib/quota/types";
import { WINDOW_MS } from "@/lib/quota/types";
import { cn } from "@/lib/utils";

function sessionsInWindow(events: UsageEvent[], agent: "claude" | "codex", now: number) {
  const from = now - WINDOW_MS;
  const slice = events.filter((e) => e.agent === agent && e.ts >= from && e.ts <= now);
  const map = new Map<string, { start: number; end: number; tokens: number; task: string }>();
  for (const e of slice) {
    const cur = map.get(e.sessionId);
    if (!cur) {
      map.set(e.sessionId, { start: e.ts, end: e.ts, tokens: rawTokens(e), task: e.task });
    } else {
      cur.start = Math.min(cur.start, e.ts);
      cur.end = Math.max(cur.end, e.ts);
      cur.tokens += rawTokens(e);
    }
  }
  return [...map.values()].map((s) => ({
    ...s,
    end: Math.max(s.end, s.start + 4 * 60_000),
  }));
}

function Lane({
  agent,
  events,
  now,
}: {
  agent: "claude" | "codex";
  events: UsageEvent[];
  now: number;
}) {
  const blocks = sessionsInWindow(events, agent, now);
  const from = now - WINDOW_MS;
  return (
    <div className="relative h-9 overflow-hidden rounded-md bg-raised">
      {blocks.map((b, i) => {
        const left = ((b.start - from) / WINDOW_MS) * 100;
        const width = Math.max(1.6, ((b.end - b.start) / WINDOW_MS) * 100);
        return (
          <div
            key={`${agent}-${i}-${b.start}`}
            title={b.task}
            className={cn(
              "absolute top-1.5 bottom-1.5 rounded-sm",
              agent === "claude" ? "bg-claude/80" : "bg-codex/80",
            )}
            style={{ left: `${left}%`, width: `${width}%` }}
          />
        );
      })}
      <div className="absolute inset-y-0 right-0 w-px bg-ink/50" />
    </div>
  );
}

export function DualTimeline({ events, now }: { events: UsageEvent[]; now: number }) {
  const ticks = [5, 4, 3, 2, 1, 0];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-mute">
        <span>5 小时滚动窗</span>
        <span className="font-mono tabular">现在</span>
      </div>
      <div className="space-y-2">
        <div className="grid grid-cols-[4.5rem_1fr] items-center gap-3">
          <span className="text-xs font-medium text-claude">Claude</span>
          <Lane agent="claude" events={events} now={now} />
        </div>
        <div className="grid grid-cols-[4.5rem_1fr] items-center gap-3">
          <span className="text-xs font-medium text-codex">Codex</span>
          <Lane agent="codex" events={events} now={now} />
        </div>
      </div>
      <div className="grid grid-cols-[4.5rem_1fr] gap-3">
        <span />
        <div className="flex justify-between font-mono text-[10px] tracking-wide text-faint">
          {ticks.map((h) => (
            <span key={h}>{h === 0 ? "now" : `-${h}h`}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
