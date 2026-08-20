import { rawTokens } from "@/lib/quota/engine";
import { agentTextClass } from "@/lib/quota/agent";
import type { AgentId, UsageEvent } from "@/lib/quota/types";
import { WINDOW_MS } from "@/lib/quota/types";
import { cn } from "@/lib/utils";

function sessionsInWindow(events: UsageEvent[], agent: AgentId, now: number) {
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
  agent: AgentId;
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
              agent === "claude" ? "bg-claude/80" : agent === "grok" ? "bg-grok/80" : "bg-codex/80",
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
  const lanes: AgentId[] = ["claude", "grok", "codex"];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-mute">
        <span>5 小时滚动窗</span>
        <span className="font-mono tabular">现在</span>
      </div>
      <div className="space-y-2">
        {lanes.map((agent) => (
          <div key={agent} className="grid grid-cols-[4.5rem_1fr] items-center gap-3">
            <span className={cn("text-xs font-medium", agentTextClass(agent))}>
              {agent === "claude" ? "Claude" : agent === "grok" ? "Grok" : "Codex"}
            </span>
            <Lane agent={agent} events={events} now={now} />
          </div>
        ))}
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
