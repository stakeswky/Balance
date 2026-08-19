import { Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardHint, CardTitle } from "@/components/ui/card";
import { formatDuration, formatTokens, formatUsd, modelLabel } from "@/components/synq/format";
import { MeterBar } from "@/components/synq/meter-bar";
import { inWindow, modelShares, weightedTokens } from "@/lib/quota/engine";
import type { MeterSnapshot, PlanDef, SessionState, UsageEvent } from "@/lib/quota/types";
import { WEEK_MS, WINDOW_MS } from "@/lib/quota/types";
import { cn } from "@/lib/utils";

const statusCopy = {
  ok: "充足",
  watch: "留意",
  critical: "将尽",
} as const;

export function AgentCard({
  name,
  adapter,
  plan,
  meter,
  session,
  live,
  events,
  now,
  onToggle,
}: {
  name: string;
  adapter: string;
  plan: PlanDef;
  meter: MeterSnapshot;
  session: SessionState | null;
  live: boolean;
  events: UsageEvent[];
  now: number;
  onToggle: () => void;
}) {
  const tone = meter.agent;
  const shares = modelShares(events, meter.agent, now, WEEK_MS);
  const remain = Math.max(0, 100 - meter.windowPct);
  const weighted = inWindow(events, now, WINDOW_MS, meter.agent).reduce((s, e) => s + weightedTokens(e), 0);
  const barTone = meter.status === "critical" ? "crit" : meter.status === "watch" ? "warn" : tone;

  return (
    <Card>
      <CardHeader>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint")} />
            <CardTitle>{name}</CardTitle>
            <Badge tone={meter.status}>{statusCopy[meter.status]}</Badge>
          </div>
          <CardHint className="mt-1">
            {plan.name} · {adapter}
          </CardHint>
        </div>
        <Button variant="secondary" size="sm" onClick={onToggle} aria-pressed={live}>
          {live ? <Pause /> : <Play />}
          {live ? "暂停" : "采集"}
        </Button>
      </CardHeader>

      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs text-mute">窗口剩余</p>
          <p className="mt-1 font-mono text-4xl leading-none font-medium tracking-tight tabular">
            {remain.toFixed(0)}
            <span className="ml-1 text-lg text-mute">%</span>
          </p>
        </div>
        <div className="text-right text-xs text-mute">
          <p>
            燃烧 {meter.burnPctPerHour.toFixed(1)}
            <span className="text-faint"> %/时</span>
          </p>
          <p className="mt-1">
            {meter.etaMs != null && meter.etaMs < 6 * 60 * 60 * 1000
              ? `预计 ${formatDuration(meter.etaMs)} 耗尽`
              : "当前速率可撑过本窗"}
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <MeterBar value={meter.windowPct} tone={barTone === "crit" || barTone === "warn" ? barTone : tone} label="5 小时窗" />
        <MeterBar
          value={meter.weekPct}
          tone={meter.weekPct >= 88 ? "crit" : meter.weekPct >= 72 ? "warn" : tone}
          label="本周额度"
        />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
        <Stat label="本窗 token" value={formatTokens(meter.windowTokens)} />
        <Stat
          label={meter.agent === "codex" ? "本窗推理" : "加权用量"}
          value={
            meter.agent === "codex" ? `${meter.windowReasoningMin.toFixed(1)} 分` : formatTokens(weighted)
          }
        />
        <Stat label="本周 token" value={formatTokens(meter.weekTokens)} />
        <Stat label="等价 API" value={formatUsd(meter.apiUsdWeek)} />
      </dl>

      {session && live ? (
        <div className="mt-5 rounded-md bg-raised px-3 py-3">
          <p className="text-[11px] tracking-wide text-faint uppercase">实时会话</p>
          <p className="mt-1 text-sm text-ink">{session.task}</p>
          <p className="mt-1 font-mono text-xs text-mute">
            {modelLabel(session.model)} · {session.events} 轮 · {formatTokens(session.tokens)}
          </p>
        </div>
      ) : (
        <div className="mt-5 rounded-md bg-raised px-3 py-3 text-sm text-mute">采集已暂停</div>
      )}

      <div className="mt-4 space-y-2">
        {shares.length ? (
          shares.map((s) => (
            <div key={s.model} className="flex items-center gap-3 text-xs">
              <span className="w-28 truncate text-mute">{modelLabel(s.model)}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-raised">
                <div
                  className={cn("h-full rounded-full", tone === "claude" ? "bg-claude" : "bg-codex")}
                  style={{ width: `${s.pct}%` }}
                />
              </div>
              <span className="w-10 text-right font-mono tabular text-ink">{s.pct.toFixed(0)}%</span>
            </div>
          ))
        ) : (
          <p className="text-xs text-mute">本周尚无模型拆分</p>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-raised px-3 py-2.5">
      <dt className="text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-ink tabular">{value}</dd>
    </div>
  );
}
