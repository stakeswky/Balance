import { useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { RotateCcw } from "lucide-react";
import { AdviceCard } from "@/components/synq/advice-card";
import { AgentCard } from "@/components/synq/agent-card";
import { EventFeed } from "@/components/synq/event-feed";
import { Header, type ViewId } from "@/components/synq/header";
import { formatDuration, formatUsd } from "@/components/synq/format";
import { PlansPanel } from "@/components/synq/plans-panel";
import { PluginPanel } from "@/components/synq/plugin-panel";
import { ReportPanel } from "@/components/synq/report-panel";
import { SessionDialog } from "@/components/synq/session-dialog";
import { DualTimeline } from "@/components/synq/timeline";
import { UsageChart } from "@/components/synq/usage-chart";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { loadSettings, saveSettings } from "@/lib/quota/actions";
import { meterFor } from "@/lib/quota/engine";
import { planById } from "@/lib/quota/plans";
import { useQuota } from "@/lib/quota/store";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

function seedIfEmpty() {
  if (useQuota.getState().events.length === 0) {
    useQuota.getState().resetDemo();
  }
}

export function Dashboard() {
  const [view, setView] = useState<ViewId>("monitor");
  const [now, setNow] = useState(() => Date.now());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { user, isPending } = useCurrentUserState();
  const warned = useRef({ claudeWin: false, claudeWeek: false, codexWin: false, codexWeek: false });

  const events = useQuota((s) => s.events);
  const liveClaude = useQuota((s) => s.liveClaude);
  const liveCodex = useQuota((s) => s.liveCodex);
  const claudePlanId = useQuota((s) => s.claudePlanId);
  const codexPlanId = useQuota((s) => s.codexPlanId);
  const weekBoostPct = useQuota((s) => s.weekBoostPct);
  const claudeSession = useQuota((s) => s.claudeSession);
  const codexSession = useQuota((s) => s.codexSession);
  const adapterHint = useQuota((s) => s.adapterHint);
  const alertWindowPct = useQuota((s) => s.alertWindowPct);
  const alertWeekPct = useQuota((s) => s.alertWeekPct);
  const alerts = useQuota((s) => s.alerts);

  useEffect(() => {
    const persist = useQuota.persist;
    const unsub = persist.onFinishHydration(seedIfEmpty);
    if (persist.hasHydrated()) seedIfEmpty();
    return unsub;
  }, []);

  useEffect(() => {
    if (isPending || !user) return;
    let cancelled = false;
    void loadSettings()
      .then((saved) => {
        if (cancelled || !saved) return;
        useQuota.setState({
          claudePlanId: saved.claudePlanId,
          codexPlanId: saved.codexPlanId,
          weekBoostPct: saved.weekBoostPct,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user, isPending]);

  useEffect(() => {
    if (isPending || !user) return;
    const handle = window.setTimeout(() => {
      void saveSettings({
        data: { claudePlanId, codexPlanId, weekBoostPct },
      }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(handle);
  }, [user, isPending, claudePlanId, codexPlanId, weekBoostPct]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const emitted = useQuota.getState().tick();
      const t = Date.now();
      setNow(t);
      if (!emitted.length) return;
      const state = useQuota.getState();
      const claude = planById(state.claudePlanId);
      const codex = planById(state.codexPlanId);
      const check = (
        agent: "claude" | "codex",
        meter: ReturnType<typeof meterFor>,
        winKey: "claudeWin" | "codexWin",
        weekKey: "claudeWeek" | "codexWeek",
        name: string,
      ) => {
        if (meter.windowPct >= state.alertWindowPct && !warned.current[winKey]) {
          warned.current[winKey] = true;
          const message = `${name} 五小时窗已用 ${meter.windowPct.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({ ts: t, agent, kind: "window", message });
        }
        if (meter.windowPct < state.alertWindowPct - 12) warned.current[winKey] = false;
        if (meter.weekPct >= state.alertWeekPct && !warned.current[weekKey]) {
          warned.current[weekKey] = true;
          const message = `${name} 本周额度已用 ${meter.weekPct.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({ ts: t, agent, kind: "week", message });
        }
        if (meter.weekPct < state.alertWeekPct - 12) warned.current[weekKey] = false;
      };
      if (emitted.some((e) => e.agent === "claude")) {
        check(
          "claude",
          meterFor(state.events, "claude", claude, t, state.weekBoostPct),
          "claudeWin",
          "claudeWeek",
          "Claude Code",
        );
      }
      if (emitted.some((e) => e.agent === "codex")) {
        check(
          "codex",
          meterFor(state.events, "codex", codex, t, state.weekBoostPct),
          "codexWin",
          "codexWeek",
          "Codex",
        );
      }
    }, 2600);
    return () => window.clearInterval(id);
  }, []);

  const claudePlan = planById(claudePlanId);
  const codexPlan = planById(codexPlanId);
  const claudeMeter = useMemo(
    () => meterFor(events, "claude", claudePlan, now, weekBoostPct),
    [events, claudePlan, now, weekBoostPct],
  );
  const codexMeter = useMemo(
    () => meterFor(events, "codex", codexPlan, now, weekBoostPct),
    [events, codexPlan, now, weekBoostPct],
  );

  const live = liveClaude || liveCodex;
  const combinedUsd = claudeMeter.apiUsdWeek + codexMeter.apiUsdWeek;
  const subUsd =
    (claudePlan.kind === "subscription" ? claudePlan.priceUsd : 0) +
    (codexPlan.kind === "subscription" ? codexPlan.priceUsd : 0);
  const tighter = claudeMeter.windowPct >= codexMeter.windowPct ? claudeMeter : codexMeter;

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          className: "!bg-surface !text-ink !border-line",
        }}
      />
      <Header view={view} onView={setView} live={live} />
      <SessionDialog sessionId={sessionId} events={events} now={now} onClose={() => setSessionId(null)} />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {adapterHint && view === "monitor" ? (
          <div className="mb-5 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 shadow-[var(--shadow-border)] sm:flex-row sm:items-center">
            <p className="flex-1 text-sm text-mute">
              预览正在模拟 sidecar：Claude Code 与 Codex 同时跑任务，用量会打进同一个 5 小时窗。
            </p>
            <Button size="sm" variant="ghost" onClick={() => useQuota.getState().setHint(false)}>
              知道了
            </Button>
          </div>
        ) : null}

        {view === "monitor" ? (
          <div className="space-y-5">
            <section className="grid gap-5 lg:grid-cols-[minmax(0,17rem)_1fr]">
              <Card>
                <p className="text-xs text-mute">更紧的窗口</p>
                <p className="mt-2 font-mono text-5xl leading-none font-medium tracking-tight tabular">
                  {Math.max(0, 100 - tighter.windowPct).toFixed(0)}
                  <span className="ml-1 text-xl text-mute">%</span>
                </p>
                <p className="mt-3 text-sm text-mute">
                  {tighter.agent === "claude" ? "Claude Code" : "Codex"} 先碰到上限
                </p>
                <dl className="mt-5 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-faint">本周等价 API</dt>
                    <dd className="font-mono tabular">{formatUsd(combinedUsd)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-faint">订阅合计</dt>
                    <dd className="font-mono tabular">{subUsd ? `$${subUsd}/月` : "按量"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-faint">窗口回补</dt>
                    <dd className="font-mono tabular">
                      {formatDuration(Math.max(0, tighter.windowResetsAt - now))}
                    </dd>
                  </div>
                </dl>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-5 w-full"
                  onClick={() => {
                    useQuota.getState().resetDemo();
                    setNow(Date.now());
                    toast.message("已重置为今日演示数据");
                  }}
                >
                  <RotateCcw />
                  重置演示
                </Button>
              </Card>

              <Card>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle>协同时间线</CardTitle>
                    <CardHint className="mt-1">两台 Agent 共享同一口 5 小时时钟</CardHint>
                  </div>
                  <Button
                    size="sm"
                    variant={live ? "secondary" : "default"}
                    onClick={() => useQuota.getState().setBothLive(!live)}
                  >
                    {live ? "全部暂停" : "开始协同"}
                  </Button>
                </div>
                <DualTimeline events={events} now={now} />
              </Card>
            </section>

            <section className="grid gap-5 lg:grid-cols-2">
              <AgentCard
                name="Claude Code"
                adapter="~/.claude"
                plan={claudePlan}
                meter={claudeMeter}
                session={claudeSession}
                live={liveClaude}
                events={events}
                now={now}
                onToggle={() => useQuota.getState().toggleLive("claude")}
              />
              <AgentCard
                name="Codex"
                adapter="~/.codex"
                plan={codexPlan}
                meter={codexMeter}
                session={codexSession}
                live={liveCodex}
                events={events}
                now={now}
                onToggle={() => useQuota.getState().toggleLive("codex")}
              />
            </section>

            <AdviceCard claude={claudeMeter} codex={codexMeter} />

            <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
              <Card>
                <CardTitle>近 24 小时 token</CardTitle>
                <CardHint className="mt-1">按小时叠加，便于看双开时的燃烧节奏</CardHint>
                <div className="mt-3">
                  <UsageChart events={events} now={now} />
                </div>
              </Card>
              <Card>
                <CardTitle>实时流水</CardTitle>
                <CardHint className="mt-1">点一条看完整会话</CardHint>
                <div className="mt-3">
                  <EventFeed events={events} now={now} onOpen={setSessionId} />
                </div>
              </Card>
            </section>
          </div>
        ) : null}

        {view === "plans" ? (
          <PlansPanel
            claudePlanId={claudePlanId}
            codexPlanId={codexPlanId}
            weekBoostPct={weekBoostPct}
            alertWindowPct={alertWindowPct}
            alertWeekPct={alertWeekPct}
            onClaude={(id) => useQuota.getState().setPlan("claude", id)}
            onCodex={(id) => useQuota.getState().setPlan("codex", id)}
            onBoost={(n) => useQuota.getState().setBoost(n)}
            onAlertWindow={(n) => useQuota.getState().setAlertWindow(n)}
            onAlertWeek={(n) => useQuota.getState().setAlertWeek(n)}
          />
        ) : null}

        {view === "report" ? (
          <ReportPanel
            events={events}
            now={now}
            claudeMeter={claudeMeter}
            codexMeter={codexMeter}
            claudePlanId={claudePlanId}
            codexPlanId={codexPlanId}
            weekBoostPct={weekBoostPct}
            alerts={alerts}
            onClearAlerts={() => useQuota.getState().clearAlerts()}
            onOpenSession={setSessionId}
          />
        ) : null}

        {view === "plugin" ? <PluginPanel /> : null}
      </main>
    </div>
  );
}
