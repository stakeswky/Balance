import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { formatDuration, formatTokens, formatUsd, modelLabel } from "@/components/synq/format";
import {
  comparePlans,
  dailySeries,
  eventsToCsv,
  groupSessions,
  inWindow,
  modelShares,
  rawTokens,
} from "@/lib/quota/engine";
import { agentDotClass } from "@/lib/quota/agent";
import { CLAUDE_PLANS, CODEX_PLANS, GROK_PLANS } from "@/lib/quota/plans";
import type { QuotaAlert } from "@/lib/quota/store";
import type { AgentId, MeterSnapshot, PlanDef, UsageEvent } from "@/lib/quota/types";
import { WEEK_MS } from "@/lib/quota/types";
import { cn } from "@/lib/utils";

function download(name: string, body: string, type: string) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Heatmap({ events, now }: { events: UsageEvent[]; now: number }) {
  const days = dailySeries(events, now, 14);
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((d) => {
        const t = d.total / max;
        return (
          <div key={d.t} className="space-y-1" title={`${d.label} · ${formatTokens(d.total)}`}>
            <div
              className={cn(
                "h-10 rounded-sm sm:h-12",
                t < 0.08 ? "bg-raised" : t < 0.35 ? "bg-codex/30" : t < 0.7 ? "bg-claude/50" : "bg-claude",
              )}
            />
            <p className="text-center font-mono text-xs text-faint">{d.label}</p>
          </div>
        );
      })}
    </div>
  );
}

function PlanCompare({
  title,
  events,
  agent,
  currentId,
  plans,
  now,
  boost,
}: {
  title: string;
  events: UsageEvent[];
  agent: AgentId;
  currentId: string;
  plans: PlanDef[];
  now: number;
  boost: number;
}) {
  const rows = comparePlans(events, agent, plans, now, boost);
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-faint">
            <tr>
              <th className="pb-2 font-medium">套餐</th>
              <th className="pb-2 font-medium">窗</th>
              <th className="pb-2 font-medium">周</th>
              <th className="pb-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.plan.id} className="border-t border-line">
                <td className="py-2.5">
                  {row.plan.name}
                  {row.plan.id === currentId ? (
                    <span className="ml-2 text-xs text-mute">当前</span>
                  ) : null}
                </td>
                <td className="py-2.5 font-mono tabular">{Math.min(100, row.windowPct).toFixed(0)}%</td>
                <td className="py-2.5 font-mono tabular">{Math.min(100, row.weekPct).toFixed(0)}%</td>
                <td className="py-2.5">
                  <Badge
                    tone={row.status === "critical" ? "critical" : row.status === "watch" ? "watch" : "ok"}
                  >
                    {row.status === "critical" ? "不够" : row.status === "watch" ? "紧" : "够用"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ReportPanel({
  events,
  now,
  claudeMeter,
  grokMeter,
  codexMeter,
  claudePlanId,
  grokPlanId,
  codexPlanId,
  weekBoostPct,
  alerts,
  weekApiUsd,
  onClearAlerts,
  onOpenSession,
}: {
  events: UsageEvent[];
  now: number;
  claudeMeter: MeterSnapshot;
  grokMeter: MeterSnapshot;
  codexMeter: MeterSnapshot;
  claudePlanId: string;
  grokPlanId: string;
  codexPlanId: string;
  weekBoostPct: number;
  alerts: QuotaAlert[];
  weekApiUsd?: number;
  onClearAlerts: () => void;
  onOpenSession: (id: string) => void;
}) {
  const week = inWindow(events, now, WEEK_MS);
  const sessions = groupSessions(events, now, WEEK_MS).slice(0, 8);
  const claudeShare = modelShares(events, "claude", now, WEEK_MS);
  const grokShare = modelShares(events, "grok", now, WEEK_MS);
  const codexShare = modelShares(events, "codex", now, WEEK_MS);
  const weekTokens = week.reduce((s, e) => s + rawTokens(e), 0);

  return (
    <div className="space-y-5">
      <section className="grid gap-5 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-mute">本周 token</p>
          <p className="mt-2 font-mono text-3xl tracking-tight tabular">{formatTokens(weekTokens)}</p>
        </Card>
        <Card>
          <p className="text-xs text-mute">本周 API 等价</p>
          <p className="mt-2 font-mono text-3xl tracking-tight tabular">
            {formatUsd(weekApiUsd ?? claudeMeter.apiUsdWeek + grokMeter.apiUsdWeek + codexMeter.apiUsdWeek)}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-mute">会话数</p>
          <p className="mt-2 font-mono text-3xl tracking-tight tabular">
            {groupSessions(events, now, WEEK_MS).length}
          </p>
        </Card>
      </section>

      <Card>
        <CardTitle>十四日热力</CardTitle>
        <CardHint className="mt-1">颜色越深，当天用量越猛</CardHint>
        <div className="mt-4">
          <Heatmap events={events} now={now} />
        </div>
      </Card>

      <section className="grid gap-5 lg:grid-cols-3">
        <Card>
          <PlanCompare
            title="若换 Claude 套餐"
            events={events}
            agent="claude"
            currentId={claudePlanId}
            plans={CLAUDE_PLANS}
            now={now}
            boost={weekBoostPct}
          />
        </Card>
        <Card>
          <PlanCompare
            title="若换 Grok 套餐"
            events={events}
            agent="grok"
            currentId={grokPlanId}
            plans={GROK_PLANS}
            now={now}
            boost={weekBoostPct}
          />
        </Card>
        <Card>
          <PlanCompare
            title="若换 Codex 套餐"
            events={events}
            agent="codex"
            currentId={codexPlanId}
            plans={CODEX_PLANS}
            now={now}
            boost={weekBoostPct}
          />
        </Card>
      </section>

      {alerts.length ? (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <CardTitle>告警记录</CardTitle>
            <Button size="sm" variant="ghost" onClick={onClearAlerts}>
              清空
            </Button>
          </div>
          <ul className="divide-y divide-line">
            {alerts.slice(0, 8).map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                <span>{a.message}</span>
                <span className="shrink-0 font-mono text-xs text-faint tabular">
                  {formatDuration(now - a.ts)}前
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>本周会话</CardTitle>
            <CardHint className="mt-1">点开一条看 token 与 API 等价金额</CardHint>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                download("synq-week.csv", eventsToCsv(week), "text/csv");
                toast.success("已导出 CSV");
              }}
            >
              导出 CSV
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                download("synq-week.json", JSON.stringify(week, null, 2), "application/json");
                toast.success("已导出 JSON");
              }}
            >
              导出 JSON
            </Button>
          </div>
        </div>
        {sessions.length ? (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(s.id)}
                  className="flex w-full items-start gap-3 py-3 text-left"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      agentDotClass(s.agent),
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{s.task}</span>
                    <span className="mt-0.5 block font-mono text-xs text-mute">
                      {modelLabel(s.model, s.modelRaw)} · {s.events} 轮 · {formatTokens(s.tokens)} · {formatUsd(s.usd)}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-faint tabular">
                    {formatDuration(now - s.end)}前
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-mute">本周还没有会话。</p>
        )}
      </Card>

      <section className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardTitle>Claude 模型占比</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            {claudeShare.map((s) => (
              <li key={s.label} className="flex justify-between">
                <span className="text-mute">{s.label}</span>
                <span className="font-mono tabular">{s.pct.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>Grok 模型占比</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            {grokShare.map((s) => (
              <li key={s.label} className="flex justify-between">
                <span className="text-mute">{s.label}</span>
                <span className="font-mono tabular">{s.pct.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>Codex 模型占比</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            {codexShare.map((s) => (
              <li key={s.label} className="flex justify-between">
                <span className="text-mute">{s.label}</span>
                <span className="font-mono tabular">{s.pct.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
