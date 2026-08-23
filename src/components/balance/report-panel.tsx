import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { formatDuration, formatTokens, formatUsd, modelLabel } from "@/components/balance/format";
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

const REPORT_AGENT_CONFIG = [
  {
    agent: "claude",
    planTitle: "若换 Claude 套餐",
    shareTitle: "Claude 模型占比",
    plans: CLAUDE_PLANS,
  },
  {
    agent: "grok",
    planTitle: "若换 Grok 套餐",
    shareTitle: "Grok 模型占比",
    plans: GROK_PLANS,
  },
  {
    agent: "codex",
    planTitle: "若换 Codex 套餐",
    shareTitle: "Codex 模型占比",
    plans: CODEX_PLANS,
  },
] satisfies Array<{
  agent: AgentId;
  planTitle: string;
  shareTitle: string;
  plans: PlanDef[];
}>;

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
                "h-10 rounded-xl sm:h-12",
                t < 0.08
                  ? "bg-raised"
                  : t < 0.35
                    ? "bg-codex/30"
                    : t < 0.7
                      ? "bg-claude/50"
                      : "bg-claude",
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
  currentMeter,
  plans,
  now,
  boost,
}: {
  title: string;
  events: UsageEvent[];
  agent: AgentId;
  currentId: string;
  currentMeter: MeterSnapshot;
  plans: PlanDef[];
  now: number;
  boost: number;
}) {
  const rows = comparePlans(events, agent, plans, now, boost, {
    currentPlanId: currentId,
    currentMeter,
  });
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto rounded-xl">
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
                <td className="py-2.5 font-mono tabular">
                  {Math.min(100, row.windowPct).toFixed(0)}%
                </td>
                <td className="py-2.5 font-mono tabular">
                  {Math.min(100, row.weekPct).toFixed(0)}%
                </td>
                <td className="py-2.5">
                  <Badge
                    tone={
                      row.status === "critical"
                        ? "critical"
                        : row.status === "watch"
                          ? "watch"
                          : "ok"
                    }
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
  agents,
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
  agents: readonly AgentId[];
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
  const visibleEvents = events.filter((event) => agents.includes(event.agent));
  const visibleAlerts = alerts.filter((alert) => agents.includes(alert.agent));
  const week = inWindow(visibleEvents, now, WEEK_MS);
  const allSessions = groupSessions(visibleEvents, now, WEEK_MS);
  const sessions = allSessions.slice(0, 8);
  const weekTokens = week.reduce((s, e) => s + rawTokens(e), 0);
  const meterByAgent: Record<AgentId, MeterSnapshot> = {
    claude: claudeMeter,
    grok: grokMeter,
    codex: codexMeter,
  };
  const currentPlanByAgent: Record<AgentId, string> = {
    claude: claudePlanId,
    grok: grokPlanId,
    codex: codexPlanId,
  };
  const visibleReports = REPORT_AGENT_CONFIG.filter(({ agent }) => agents.includes(agent)).map(
    (config) => ({
      ...config,
      currentPlanId: currentPlanByAgent[config.agent],
      shares: modelShares(visibleEvents, config.agent, now, WEEK_MS),
    }),
  );
  const fallbackWeekApiUsd = agents.reduce((sum, agent) => sum + meterByAgent[agent].apiUsdWeek, 0);

  if (!agents.length) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardTitle>暂无可报告的 Agent</CardTitle>
        <CardHint className="mt-2 leading-relaxed">
          请先到设置重新检测本机数据目录，或开启演示数据后再查看报告。
        </CardHint>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-5 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-mute">本周 token</p>
          <p className="mt-2 font-mono text-3xl tracking-tight tabular">
            {formatTokens(weekTokens)}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-mute">本周 API 等价</p>
          <p className="mt-2 font-mono text-3xl tracking-tight tabular">
            {formatUsd(weekApiUsd ?? fallbackWeekApiUsd)}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-mute">会话数</p>
          <p className="mt-2 font-mono text-3xl tracking-tight tabular">{allSessions.length}</p>
        </Card>
      </section>

      <Card>
        <CardTitle>十四日热力</CardTitle>
        <CardHint className="mt-1">颜色越深，当天用量越猛</CardHint>
        <div className="mt-4">
          <Heatmap events={visibleEvents} now={now} />
        </div>
      </Card>

      <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {visibleReports.map((report) => (
          <Card key={report.agent}>
            <PlanCompare
              title={report.planTitle}
              events={visibleEvents}
              agent={report.agent}
              currentId={report.currentPlanId}
              currentMeter={meterByAgent[report.agent]}
              plans={report.plans}
              now={now}
              boost={weekBoostPct}
            />
          </Card>
        ))}
      </section>

      {visibleAlerts.length ? (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <CardTitle>告警记录</CardTitle>
            <Button size="sm" variant="ghost" onClick={onClearAlerts}>
              清空
            </Button>
          </div>
          <ul className="space-y-1">
            {visibleAlerts.slice(0, 8).map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 rounded-xl px-2 py-2.5 text-sm hover:bg-raised">
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
                download("balance-week.csv", eventsToCsv(week), "text/csv");
                toast.success("已导出 CSV");
              }}
            >
              导出 CSV
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                download("balance-week.json", JSON.stringify(week, null, 2), "application/json");
                toast.success("已导出 JSON");
              }}
            >
              导出 JSON
            </Button>
          </div>
        </div>
        {sessions.length ? (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(s.id)}
                  className="flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-raised"
                >
                  <span
                    className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", agentDotClass(s.agent))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{s.task}</span>
                    <span className="mt-0.5 block font-mono text-xs text-mute">
                      {modelLabel(s.model, s.modelRaw)} · {s.events} 轮 · {formatTokens(s.tokens)} ·{" "}
                      {formatUsd(s.usd)}
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

      <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {visibleReports.map((report) => (
          <Card key={report.agent}>
            <CardTitle>{report.shareTitle}</CardTitle>
            {report.shares.length ? (
              <ul className="mt-3 space-y-2 text-sm">
                {report.shares.map((share) => (
                  <li key={share.label} className="flex justify-between">
                    <span className="text-mute">{share.label}</span>
                    <span className="font-mono tabular">{share.pct.toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-mute">本周暂无模型用量。</p>
            )}
          </Card>
        ))}
      </section>
    </div>
  );
}
