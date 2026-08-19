import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatDuration, formatTokens, formatUsd, modelLabel } from "@/components/synq/format";
import { apiUsd, rawTokens } from "@/lib/quota/engine";
import type { UsageEvent } from "@/lib/quota/types";

export function SessionDialog({
  sessionId,
  events,
  now,
  onClose,
}: {
  sessionId: string | null;
  events: UsageEvent[];
  now: number;
  onClose: () => void;
}) {
  const rows = events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.ts - b.ts);
  const first = rows[0];
  const tokens = rows.reduce((s, e) => s + rawTokens(e), 0);
  const usd = rows.reduce((s, e) => s + apiUsd(e), 0);
  const reason = rows.reduce((s, e) => s + e.reasoningMin, 0);

  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{first?.task ?? "会话"}</DialogTitle>
        <DialogDescription>
          {first
            ? `${first.agent === "claude" ? "Claude Code" : "Codex"} · ${modelLabel(first.model)}`
            : "没有找到这条会话"}
        </DialogDescription>
        {first ? (
          <div className="mt-4 space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-md bg-raised px-3 py-2.5">
                <dt className="text-faint">回合</dt>
                <dd className="mt-1 font-mono text-sm tabular">{rows.length}</dd>
              </div>
              <div className="rounded-md bg-raised px-3 py-2.5">
                <dt className="text-faint">Token</dt>
                <dd className="mt-1 font-mono text-sm tabular">{formatTokens(tokens)}</dd>
              </div>
              <div className="rounded-md bg-raised px-3 py-2.5">
                <dt className="text-faint">等价 API</dt>
                <dd className="mt-1 font-mono text-sm tabular">{formatUsd(usd)}</dd>
              </div>
              <div className="rounded-md bg-raised px-3 py-2.5">
                <dt className="text-faint">{reason > 0 ? "推理" : "时长"}</dt>
                <dd className="mt-1 font-mono text-sm tabular">
                  {reason > 0 ? `${reason.toFixed(1)} 分` : formatDuration(rows[rows.length - 1].ts - first.ts)}
                </dd>
              </div>
            </dl>
            <ul className="max-h-56 space-y-2 overflow-auto">
              {rows.map((e) => (
                <li key={e.id} className="flex justify-between gap-3 font-mono text-xs text-mute">
                  <span>{formatTokens(rawTokens(e))}</span>
                  <span className="tabular">{formatDuration(now - e.ts)}前</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
