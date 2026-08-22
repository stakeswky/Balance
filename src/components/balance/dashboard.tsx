import { useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { RotateCcw } from "lucide-react";
import { AdvicePlan } from "@/components/balance/advice-card";
import { AgentCard } from "@/components/balance/agent-card";
import { EventFeed } from "@/components/balance/event-feed";
import { Header, type ViewId } from "@/components/balance/header";
import { formatDuration, formatUsd } from "@/components/balance/format";
import { PluginPanel } from "@/components/balance/plugin-panel";
import { ReportPanel } from "@/components/balance/report-panel";
import { SessionDialog } from "@/components/balance/session-dialog";
import { SettingsPanel } from "@/components/balance/settings-panel";
import { DualTimeline } from "@/components/balance/timeline";
import { UsageChart } from "@/components/balance/usage-chart";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { eventsForAgents, visibleAgentIds } from "@/lib/quota/agent-availability";
import {
  applyOfficial,
  meterDataSources,
  meterFor,
  modelWeekLimitFor,
  officialOnlyMeter,
  type MeterDataSources,
} from "@/lib/quota/engine";
import { inferCodexProPlanId } from "@/lib/quota/estimate";
import type { OfficialSlice } from "@/lib/quota/official";
import { planById } from "@/lib/quota/plans";
import {
  primaryUsagePercent,
  primaryWindowResetsAt,
  quotaAlertDecision,
  quotaAlertLatch,
  tightestQuota,
  type PrimaryWindowKind,
} from "@/lib/quota/presentation";
import { quotaValueFor } from "@/lib/quota/quota-value";
import type { OfficialLoadState } from "@/lib/quota/quota-label";
import { useQuota } from "@/lib/quota/store";
import { useTheme } from "@/lib/theme";
import { AGENT_LABEL } from "@/lib/quota/agent";
import {
  pullClaudeUsage,
  pullCodexUsage,
  pullGrokUsage,
  pullOfficialHistory,
  pullOfficialQuota,
} from "@/lib/quota/watch";

function claudeQuotaNote(slice: OfficialSlice | null): string | undefined {
  if (!slice) return undefined;
  const base =
    slice.source === "plan-usage-history"
      ? "Claude Desktop 历史利用率"
      : slice.windowStale || slice.weekStale
        ? "上次官方快照"
        : "官方 OAuth 利用率";
  return slice.modelWeekLimitsStale ? `${base} · Fable 上次官方快照` : base;
}

export function Dashboard() {
  const [view, setView] = useState<ViewId>("monitor");
  const [now, setNow] = useState(() => Date.now());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [officialLoadState, setOfficialLoadState] = useState<OfficialLoadState>("loading");
  const historyLoaded = useRef(false);
  const warned = useRef({
    claudeWin: false,
    claudeWeek: false,
    claudeFable: false,
    grokWin: false,
    grokWeek: false,
    codexWin: false,
    codexWeek: false,
  });

  const events = useQuota((s) => s.events);
  const realEvents = useQuota((s) => s.realEvents);
  const agentAvailability = useQuota((s) => s.agentAvailability);
  const liveClaude = useQuota((s) => s.liveClaude);
  const liveGrok = useQuota((s) => s.liveGrok);
  const liveCodex = useQuota((s) => s.liveCodex);
  const demoMode = useQuota((s) => s.demoMode);
  const claudeWriting = useQuota((s) => s.claudeWriting);
  const grokWriting = useQuota((s) => s.grokWriting);
  const codexWriting = useQuota((s) => s.codexWriting);
  const activeClaude = useQuota((s) => s.activeClaude);
  const activeGrok = useQuota((s) => s.activeGrok);
  const activeCodex = useQuota((s) => s.activeCodex);
  const grokPlanId = useQuota((s) => s.grokPlanId);
  const grokSession = useQuota((s) => s.grokSession);
  const claudePlanId = useQuota((s) => s.claudePlanId);
  const codexPlanId = useQuota((s) => s.codexPlanId);
  const weekBoostPct = useQuota((s) => s.weekBoostPct);
  const claudeSession = useQuota((s) => s.claudeSession);
  const codexSession = useQuota((s) => s.codexSession);
  const adapterHint = useQuota((s) => s.adapterHint);
  const alertWindowPct = useQuota((s) => s.alertWindowPct);
  const alertWeekPct = useQuota((s) => s.alertWeekPct);
  const alerts = useQuota((s) => s.alerts);
  const theme = useTheme((s) => s.theme);
  const visibleAgents = useMemo(
    () => visibleAgentIds(agentAvailability, demoMode, realEvents),
    [agentAvailability, demoMode, realEvents],
  );
  const visibleEvents = useMemo(
    () => eventsForAgents(events, visibleAgents),
    [events, visibleAgents],
  );

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const checkAlerts = (t = Date.now()) => {
      const state = useQuota.getState();
      const activeAgents = visibleAgentIds(
        state.agentAvailability,
        state.demoMode,
        state.realEvents,
      );
      const activeEvents = eventsForAgents(state.events, activeAgents);
      const check = (
        agent: "claude" | "grok" | "codex",
        meter: ReturnType<typeof meterFor>,
        kind: PrimaryWindowKind,
        winKey: "claudeWin" | "grokWin" | "codexWin",
        weekKey: "claudeWeek" | "grokWeek" | "codexWeek",
        name: string,
      ) => {
        const decision = quotaAlertDecision({
          meter,
          kind,
          windowThreshold: state.alertWindowPct,
          weekThreshold: state.alertWeekPct,
        });
        if (decision.primaryTriggered && !warned.current[winKey]) {
          warned.current[winKey] = true;
          const message = `${name} ${decision.primaryLabel}已用 ${decision.primaryPercent.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({
            ts: t,
            agent,
            kind: kind === "weekly" ? "week" : "window",
            message,
          });
        }
        if (decision.primaryPercent < decision.primaryThreshold - 12)
          warned.current[winKey] = false;
        if (decision.weekTriggered && !warned.current[weekKey]) {
          warned.current[weekKey] = true;
          const message = `${name} 本周额度已用 ${meter.weekPct.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({ ts: t, agent, kind: "week", message });
        }
        if (meter.weekPct < state.alertWeekPct - 12) warned.current[weekKey] = false;
      };

      const claudeMeter = applyOfficial(
        meterFor(activeEvents, "claude", planById(state.claudePlanId), t, state.weekBoostPct),
        state.official.claude,
      );
      const claudeFableLimit = modelWeekLimitFor(
        planById(state.claudePlanId),
        state.official.claude,
        "fable",
      );
      const grokMeter = applyOfficial(
        meterFor(activeEvents, "grok", planById(state.grokPlanId), t, state.weekBoostPct),
        state.official.grok,
      );
      const codexMeter = applyOfficial(
        meterFor(activeEvents, "codex", planById(state.codexPlanId), t, state.weekBoostPct),
        state.official.codex,
      );
      const claudeDecisionMeter = state.demoMode
        ? claudeMeter
        : officialOnlyMeter(claudeMeter, meterDataSources(state.official.claude));
      const grokDecisionMeter = state.demoMode
        ? grokMeter
        : officialOnlyMeter(grokMeter, meterDataSources(state.official.grok));
      const codexDecisionMeter = state.demoMode
        ? codexMeter
        : officialOnlyMeter(codexMeter, meterDataSources(state.official.codex));
      if (activeAgents.includes("claude")) {
        if (claudeDecisionMeter) {
          check(
            "claude",
            claudeDecisionMeter,
            state.official.claude?.windowKind ?? "five_hour",
            "claudeWin",
            "claudeWeek",
            "Claude Code",
          );
        }
        const fableAlert = quotaAlertLatch(
          state.demoMode || !state.official.claude?.modelWeekLimitsStale
            ? (claudeFableLimit?.usedPct ?? null)
            : null,
          state.alertWeekPct,
          warned.current.claudeFable,
        );
        warned.current.claudeFable = fableAlert.nextWarned;
        if (
          claudeFableLimit &&
          (state.demoMode || !state.official.claude?.modelWeekLimitsStale) &&
          fableAlert.triggered
        ) {
          const message = `Claude Code Fable 5 周额度已用 ${claudeFableLimit.usedPct.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({ ts: t, agent: "claude", kind: "week", message });
        }
      }
      if (activeAgents.includes("grok") && grokDecisionMeter) {
        check(
          "grok",
          grokDecisionMeter,
          state.official.grok?.windowKind ?? "five_hour",
          "grokWin",
          "grokWeek",
          "Grok",
        );
      }
      if (activeAgents.includes("codex") && codexDecisionMeter) {
        check(
          "codex",
          codexDecisionMeter,
          state.official.codex?.windowKind ?? "five_hour",
          "codexWin",
          "codexWeek",
          "Codex",
        );
      }
    };
    const pullOfficial = async () => {
      try {
        const official = await pullOfficialQuota();
        if (!cancelled) {
          useQuota.getState().setOfficial(official);
          setOfficialLoadState("ready");
          const t = Date.now();
          setNow(t);
          checkAlerts(t);
        }
      } catch {
        if (!cancelled) setOfficialLoadState("error");
        /* keep last official snapshot */
      }
    };
    const pullLogs = async () => {
      const state = useQuota.getState();
      if (state.demoMode || inFlight) return;
      inFlight = true;
      try {
        await pullOfficial();
        let added = 0;
        if (state.liveClaude) {
          const res = await pullClaudeUsage({ data: { since: state.claudeCursor } });
          if (cancelled) return;
          added += useQuota.getState().ingestClaudeLogs(res.events, {
            replace: !state.claudeHydrated && res.events.length > 0,
            live: res.live,
            active: res.active,
          });
        }
        if (state.liveGrok) {
          const res = await pullGrokUsage({ data: { since: state.grokCursor } });
          if (cancelled) return;
          added += useQuota.getState().ingestGrokLogs(res.events, {
            replace: !state.grokHydrated && res.events.length > 0,
            live: res.live,
            active: res.active,
          });
        }
        if (state.liveCodex) {
          const res = await pullCodexUsage({ data: { since: state.codexCursor } });
          if (cancelled) return;
          added += useQuota.getState().ingestCodexLogs(res.events, {
            replace: !state.codexHydrated && res.events.length > 0,
            live: res.live,
            active: res.active,
          });
          useQuota.getState().recordCodexHistory(res.officialHistory);
        }
        if (!historyLoaded.current) {
          const history = await pullOfficialHistory();
          if (cancelled) return;
          useQuota.getState().recordOfficialHistory(history);
          historyLoaded.current = true;
        }
        useQuota.getState().recordOfficialSamples();
        if (added > 0) {
          const t = Date.now();
          setNow(t);
          checkAlerts(t);
        }
      } catch {
        /* keep last snapshot; next tick retries */
      } finally {
        inFlight = false;
      }
    };
    void pullLogs();
    const logsId = window.setInterval(() => void pullLogs(), 2500);

    const id = window.setInterval(() => {
      const emitted = useQuota.getState().tick();
      const t = Date.now();
      setNow(t);
      if (emitted.length) checkAlerts(t);
    }, 2600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.clearInterval(logsId);
    };
  }, [liveClaude, liveGrok, liveCodex, demoMode]);

  const claudePlan = planById(claudePlanId);
  const grokPlan = planById(grokPlanId);
  const codexPlan = planById(codexPlanId);
  const official = useQuota((s) => s.official);
  const quotaSamples = useQuota((s) => s.quotaSamples);
  const claudeMeter = useMemo(
    () =>
      applyOfficial(
        meterFor(visibleEvents, "claude", claudePlan, now, weekBoostPct),
        official.claude,
      ),
    [visibleEvents, claudePlan, now, weekBoostPct, official.claude],
  );
  const claudeFableLimit = useMemo(
    () => modelWeekLimitFor(claudePlan, official.claude, "fable"),
    [claudePlan, official.claude],
  );
  const grokMeter = useMemo(
    () =>
      applyOfficial(meterFor(visibleEvents, "grok", grokPlan, now, weekBoostPct), official.grok),
    [visibleEvents, grokPlan, now, weekBoostPct, official.grok],
  );
  const codexMeter = useMemo(
    () =>
      applyOfficial(meterFor(visibleEvents, "codex", codexPlan, now, weekBoostPct), official.codex),
    [visibleEvents, codexPlan, now, weekBoostPct, official.codex],
  );
  const claudeSources = meterDataSources(official.claude);
  const grokSources = meterDataSources(official.grok);
  const codexSources = meterDataSources(official.codex);

  const live = visibleAgents.some((agent) =>
    agent === "claude" ? liveClaude : agent === "grok" ? liveGrok : liveCodex,
  );
  const claudeWeekVal = useMemo(
    () =>
      quotaValueFor(visibleEvents, "claude", official.claude, "weekly", now, quotaSamples ?? []),
    [visibleEvents, official.claude, now, quotaSamples],
  );
  const claudeWinVal = useMemo(
    () =>
      quotaValueFor(visibleEvents, "claude", official.claude, "five_hour", now, quotaSamples ?? []),
    [visibleEvents, official.claude, now, quotaSamples],
  );
  const grokWeekVal = useMemo(
    () => quotaValueFor(visibleEvents, "grok", official.grok, "weekly", now, quotaSamples ?? []),
    [visibleEvents, official.grok, now, quotaSamples],
  );
  const grokWinVal = useMemo(
    () => quotaValueFor(visibleEvents, "grok", official.grok, "five_hour", now, quotaSamples ?? []),
    [visibleEvents, official.grok, now, quotaSamples],
  );
  const codexWeekVal = useMemo(
    () => quotaValueFor(visibleEvents, "codex", official.codex, "weekly", now, quotaSamples ?? []),
    [visibleEvents, official.codex, now, quotaSamples],
  );
  const codexWinVal = useMemo(
    () =>
      quotaValueFor(visibleEvents, "codex", official.codex, "five_hour", now, quotaSamples ?? []),
    [visibleEvents, official.codex, now, quotaSamples],
  );
  const combinedUsd = visibleAgents.reduce((sum, agent) => {
    if (agent === "claude") return sum + claudeWeekVal.l1Usd;
    if (agent === "grok") return sum + grokWeekVal.l1Usd;
    return sum + codexWeekVal.l1Usd;
  }, 0);
  const subUsd = visibleAgents.reduce((sum, agent) => {
    const plan = agent === "claude" ? claudePlan : agent === "grok" ? grokPlan : codexPlan;
    return sum + (plan.kind === "subscription" ? plan.priceUsd : 0);
  }, 0);
  const allPrimaryMeters = [
    {
      meter: claudeMeter,
      kind: official.claude?.windowKind ?? "five_hour",
      sources: claudeSources,
    },
    {
      meter: grokMeter,
      kind: official.grok?.windowKind ?? "five_hour",
      sources: grokSources,
    },
    {
      meter: codexMeter,
      kind: official.codex?.windowKind ?? "five_hour",
      sources: codexSources,
    },
  ] satisfies {
    meter: typeof claudeMeter;
    kind: PrimaryWindowKind;
    sources: MeterDataSources;
  }[];
  const primaryMeters = allPrimaryMeters.filter(({ meter }) => visibleAgents.includes(meter.agent));
  const primaryLimits = primaryMeters.flatMap(({ meter, kind, sources }) => {
    const primarySource = kind === "weekly" ? sources.week : sources.window;
    if (!demoMode && primarySource !== "official") return [];
    return [
      {
        label: AGENT_LABEL[meter.agent],
        pct: primaryUsagePercent(meter, kind),
        resetsAt: primaryWindowResetsAt(meter, kind),
      },
    ];
  });
  if (
    claudeFableLimit &&
    visibleAgents.includes("claude") &&
    (demoMode || !official.claude?.modelWeekLimitsStale)
  ) {
    primaryLimits.push({
      label: "Claude Fable 5",
      pct: claudeFableLimit.usedPct,
      resetsAt: claudeFableLimit.resetsAt ?? claudeMeter.weekResetsAt,
    });
  }
  const adviceMeters = primaryMeters.flatMap(({ meter, sources }) => {
    const decisionMeter = demoMode ? meter : officialOnlyMeter(meter, sources);
    return decisionMeter ? [decisionMeter] : [];
  });
  const tighter = tightestQuota(primaryLimits);
  const tighterPct = tighter?.pct ?? 0;
  const watching = visibleAgents
    .map((agent) => {
      if (agent === "claude") return liveClaude ? "Claude" : null;
      if (agent === "grok") return liveGrok ? "Grok" : null;
      return liveCodex ? "Codex" : null;
    })
    .filter((name): name is "Claude" | "Grok" | "Codex" => name !== null);
  const watchText = !demoMode && watching.length ? `监听 ${watching.join(" / ")} 日志` : undefined;
  const visibleAlerts = alerts.filter((alert) => visibleAgents.includes(alert.agent));
  const codexVisible = visibleAgents.includes("codex");

  useEffect(() => {
    if (demoMode || !codexVisible) return;
    const label = official.codex?.planLabel ?? "";
    if (!label.toLowerCase().includes("pro")) return;
    if (codexWeekVal.confidence !== "medium" && codexWeekVal.confidence !== "high") return;
    const used = codexWeekVal.usedPct;
    if (used < 1) return;
    const inferred = inferCodexProPlanId(codexWeekVal.l1Tokens / (used / 100));
    if (inferred === "chatgpt-pro-20x" && codexPlanId === "chatgpt-pro-5x") {
      useQuota.getState().setPlan("codex", inferred);
    }
  }, [
    demoMode,
    codexVisible,
    official.codex?.planLabel,
    codexWeekVal.confidence,
    codexWeekVal.l1Tokens,
    codexWeekVal.usedPct,
    codexPlanId,
  ]);

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Toaster
        theme={theme}
        position="bottom-center"
        toastOptions={{
          className: "!bg-surface !text-ink !border-line",
        }}
      />
      <Header
        view={view}
        onView={setView}
        live={live}
        watchText={watchText}
        agents={visibleAgents}
      />
      <SessionDialog
        sessionId={sessionId}
        events={visibleEvents}
        now={now}
        onClose={() => setSessionId(null)}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {adapterHint && view === "monitor" && visibleAgents.length ? (
          <div className="mb-5 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 shadow-[var(--shadow-border)] sm:flex-row sm:items-center">
            <p className="flex-1 text-sm text-mute">
              {demoMode
                ? "当前是演示数据。可在设置中关闭演示，恢复只读监听本机日志。"
                : "官方额度可用时优先显示；未读到的窗口会明确标为本地估算。金额仍是本机日志按公开 API 价折算的 API 等价。"}
            </p>
            <Button size="sm" variant="ghost" onClick={() => useQuota.getState().setHint(false)}>
              知道了
            </Button>
          </div>
        ) : null}

        {view === "monitor" && visibleAgents.length === 0 ? (
          <Card className="mx-auto max-w-xl">
            <CardTitle>未发现可监控 Agent</CardTitle>
            <CardHint className="mt-2 leading-relaxed">
              在这台机器上先运行一次 Claude Code、Grok 或
              Codex，然后到设置重新检测；也可以在设置开启演示数据。
            </CardHint>
            <Button className="mt-5" onClick={() => setView("settings")}>
              打开设置
            </Button>
          </Card>
        ) : null}

        {view === "monitor" && visibleAgents.length ? (
          <div className="space-y-5">
            <section className="grid gap-5 lg:grid-cols-[minmax(0,17rem)_1fr]">
              {tighter ? (
                <Card>
                  <p className="text-xs text-mute">更紧的窗口</p>
                  <p className="mt-2 font-mono text-5xl leading-none font-medium tracking-tight tabular">
                    {Math.max(0, 100 - tighterPct).toFixed(0)}
                    <span className="ml-1 text-xl text-mute">%</span>
                  </p>
                  <p className="mt-3 text-sm text-mute">{tighter.label} 先碰到上限</p>
                  <dl className="mt-5 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <dt className="text-faint">本周 API 等价</dt>
                      <dd className="font-mono tabular">{formatUsd(combinedUsd)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-faint">订阅合计</dt>
                      <dd className="font-mono tabular">{subUsd ? `$${subUsd}/月` : "按量"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-faint">窗口回补</dt>
                      <dd className="font-mono tabular">
                        {formatDuration(Math.max(0, tighter.resetsAt - now))}
                      </dd>
                    </div>
                  </dl>
                  {demoMode ? (
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
                  ) : null}
                </Card>
              ) : null}

              <Card>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle>协同时间线</CardTitle>
                    <CardHint className="mt-1">
                      {visibleAgents.length} 路 Agent 共享同一口 5 小时时钟
                    </CardHint>
                  </div>
                  <Button
                    size="sm"
                    variant={live ? "secondary" : "default"}
                    onClick={() => useQuota.getState().setBothLive(!live)}
                  >
                    {live ? "全部暂停" : "开始协同"}
                  </Button>
                </div>
                <DualTimeline agents={visibleAgents} events={visibleEvents} now={now} />
                {adviceMeters.length ? <AdvicePlan meters={adviceMeters} /> : null}
              </Card>
            </section>

            <section className="grid min-w-0 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {visibleAgents.includes("claude") ? (
                <AgentCard
                  name="Claude Code"
                  adapter="~/.claude"
                  plan={claudePlan}
                  meter={claudeMeter}
                  session={claudeSession}
                  live={liveClaude}
                  activeTasks={activeClaude}
                  quotaNote={claudeQuotaNote(official.claude)}
                  quotaSources={claudeSources}
                  officialLoadState={demoMode ? undefined : officialLoadState}
                  liveNote={
                    demoMode
                      ? undefined
                      : claudeWriting
                        ? "jsonl 正在写入"
                        : "已接上日志，等待新回合"
                  }
                  modelWeekLimit={claudeFableLimit}
                  modelWeekLimitStale={official.claude?.modelWeekLimitsStale}
                  weekValue={claudeWeekVal}
                  windowValue={claudeWinVal}
                  weekResetsAt={official.claude?.weekResetsAt ?? null}
                  events={visibleEvents}
                  now={now}
                  onToggle={() => useQuota.getState().toggleLive("claude")}
                />
              ) : null}
              {visibleAgents.includes("grok") ? (
                <AgentCard
                  name="Grok"
                  adapter="~/.grok"
                  plan={grokPlan}
                  meter={grokMeter}
                  session={grokSession}
                  live={liveGrok}
                  activeTasks={activeGrok}
                  windowLabel="本周额度"
                  quotaSources={grokSources}
                  officialLoadState={demoMode ? undefined : officialLoadState}
                  quotaNote={
                    official.grok
                      ? `${official.grok.source === "billing-api" ? "官方实时账单" : "官方账单日志"}${
                          official.grok.planLabel ? ` · ${official.grok.planLabel}` : ""
                        }`
                      : undefined
                  }
                  products={official.grok?.products}
                  liveNote={
                    demoMode
                      ? undefined
                      : grokWriting
                        ? "updates.jsonl 正在写入"
                        : "已接上日志，等待新回合"
                  }
                  weekValue={grokWeekVal}
                  windowValue={grokWinVal}
                  weekResetsAt={official.grok?.weekResetsAt ?? null}
                  events={visibleEvents}
                  now={now}
                  onToggle={() => useQuota.getState().toggleLive("grok")}
                />
              ) : null}
              {visibleAgents.includes("codex") ? (
                <AgentCard
                  name="Codex"
                  adapter="~/.codex"
                  plan={codexPlan}
                  meter={codexMeter}
                  session={codexSession}
                  live={liveCodex}
                  activeTasks={activeCodex}
                  windowLabel={official.codex?.windowKind === "weekly" ? "本周额度" : "5 小时窗"}
                  quotaSources={codexSources}
                  officialLoadState={demoMode ? undefined : officialLoadState}
                  quotaNote={
                    official.codex
                      ? `${official.codex.source === "wham-usage" ? "官方实时额度" : "官方会话额度"}${
                          official.codex.planLabel ? ` · ${official.codex.planLabel}` : ""
                        }`
                      : undefined
                  }
                  products={official.codex?.products}
                  liveNote={
                    demoMode
                      ? undefined
                      : codexWriting
                        ? "rollout jsonl 正在写入"
                        : "已接上日志，等待新回合"
                  }
                  weekValue={codexWeekVal}
                  windowValue={codexWinVal}
                  weekResetsAt={official.codex?.weekResetsAt ?? null}
                  events={visibleEvents}
                  now={now}
                  onToggle={() => useQuota.getState().toggleLive("codex")}
                />
              ) : null}
            </section>

            <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
              <Card>
                <CardTitle>近 24 小时 token</CardTitle>
                <CardHint className="mt-1">
                  按小时叠加，便于看 {visibleAgents.length} 路 Agent 燃烧节奏
                </CardHint>
                <div className="mt-3">
                  <UsageChart agents={visibleAgents} events={visibleEvents} now={now} />
                </div>
              </Card>
              <Card>
                <CardTitle>实时流水</CardTitle>
                <CardHint className="mt-1">点一条看完整会话</CardHint>
                <div className="mt-3">
                  <EventFeed events={visibleEvents} now={now} onOpen={setSessionId} />
                </div>
              </Card>
            </section>
          </div>
        ) : null}

        {view === "settings" ? <SettingsPanel /> : null}

        {view === "report" ? (
          <ReportPanel
            agents={visibleAgents}
            events={visibleEvents}
            now={now}
            claudeMeter={claudeMeter}
            grokMeter={grokMeter}
            codexMeter={codexMeter}
            claudePlanId={claudePlanId}
            grokPlanId={grokPlanId}
            codexPlanId={codexPlanId}
            weekBoostPct={weekBoostPct}
            alerts={visibleAlerts}
            weekApiUsd={combinedUsd}
            onClearAlerts={() => useQuota.getState().clearAlerts()}
            onOpenSession={setSessionId}
          />
        ) : null}

        {view === "plugin" ? <PluginPanel agents={visibleAgents} /> : null}
      </main>
    </div>
  );
}
