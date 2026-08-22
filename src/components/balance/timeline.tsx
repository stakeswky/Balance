import { agentTextClass } from "@/lib/quota/agent";
import type { AgentId, UsageEvent } from "@/lib/quota/types";
import { WINDOW_MS } from "@/lib/quota/types";
import { timelineSessions } from "@/lib/quota/timeline-sessions";
import { cn } from "@/lib/utils";

function Lane({ agent, events, now }: { agent: AgentId; events: UsageEvent[]; now: number }) {
  const blocks = timelineSessions(events, agent, now);
  const from = now - WINDOW_MS;
  return (
    <div className="relative h-7 overflow-hidden rounded-md bg-raised">
      {blocks.map((block) => {
        const left = ((block.start - from) / WINDOW_MS) * 100;
        const width = Math.max(1.6, ((block.end - block.start) / WINDOW_MS) * 100);
        return (
          <div
            key={block.id}
            title={block.task}
            className={cn(
              "absolute top-1 bottom-1 rounded-sm",
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

export function DualTimeline({
  agents,
  events,
  now,
}: {
  agents: readonly AgentId[];
  events: UsageEvent[];
  now: number;
}) {
  const ticks = [5, 4, 3, 2, 1, 0];
  return (
    <div className="space-y-1.5">
      <div className="space-y-1.5">
        {agents.map((agent) => (
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
