import { cn } from "@/lib/utils";

export function MeterBar({
  value,
  tone,
  label,
}: {
  value: number;
  tone: "claude" | "grok" | "codex" | "ok" | "warn" | "crit";
  label?: string;
}) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1.5">
      {label ? (
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-mute">{label}</span>
          <span className="tabular font-mono text-ink">{width.toFixed(width >= 10 ? 0 : 1)}%</span>
        </div>
      ) : null}
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className={cn(
            "meter-fill h-full rounded-full",
            tone === "claude" && "bg-claude",
            tone === "grok" && "bg-grok",
            tone === "codex" && "bg-codex",
            tone === "ok" && "bg-ok",
            tone === "warn" && "bg-warn",
            tone === "crit" && "bg-crit",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
