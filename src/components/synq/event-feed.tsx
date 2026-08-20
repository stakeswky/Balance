import { formatTokens, modelLabel } from "@/components/synq/format";
import { AGENT_LABEL, agentDotClass } from "@/lib/quota/agent";
import { rawTokens } from "@/lib/quota/engine";
import { activityIdOf, type UsageEvent } from "@/lib/quota/types";
import { cn } from "@/lib/utils";

function timeLabel(ts: number, now: number) {
  const delta = now - ts;
  if (delta < 60_000) return "刚刚";
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function EventFeed({
  events,
  now,
  onOpen,
}: {
  events: UsageEvent[];
  now: number;
  onOpen?: (sessionId: string) => void;
}) {
  const latest = [...events].sort((a, b) => b.ts - a.ts).slice(0, 14);
  if (!latest.length) {
    return <p className="text-sm text-mute">还没有用量事件。打开协同采集，或导入会话日志。</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {latest.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            onClick={() => onOpen?.(activityIdOf(e))}
            className="flex w-full items-start gap-3 py-3 text-left first:pt-0 last:pb-0"
          >
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                agentDotClass(e.agent),
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{e.task}</p>
              <p className="mt-0.5 font-mono text-xs text-mute">
                {AGENT_LABEL[e.agent]} · {modelLabel(e.model, e.modelRaw)} ·{" "}
                {formatTokens(rawTokens(e))}
                {e.reasoningMin > 0 ? ` · ${e.reasoningMin.toFixed(1)} 分推理` : ""}
              </p>
            </div>
            <time className="shrink-0 font-mono text-xs text-faint tabular">{timeLabel(e.ts, now)}</time>
          </button>
        </li>
      ))}
    </ul>
  );
}
