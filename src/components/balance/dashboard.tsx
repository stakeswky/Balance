import { useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { RotateCcw } from "lucide-react";
import { AdvicePlan } from "@/components/balance/advice-card";
import { AgentCard } from "@/components/balance/agent-card";
import { EventFeed } from "@/components/balance/event-feed";
import { Header, type ViewId } from "@/components/balance/header";
import { formatDuration, formatUsd } from "@/components/balance/format";
import { ReportPanel } from "@/components/balance/report-panel";
import { SessionDialog } from "@/components/balance/session-dialog";
import { SettingsPanel } from "@/components/balance/settings-panel";
import { DualTimeline } from "@/components/balance/timeline";
import { UsageChart } from "@/components/balance/usage-chart";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { InlineHelp } from "@/components/ui/inline-help";
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
  tightestQuota,
  type PrimaryWindowKind,
  type QuotaPoolView,
} from "@/lib/quota/presentation";
import { quotaValueFor, quotaValueForPool } from "@/lib/quota/quota-value";
import type { OfficialLoadState } from "@/lib/quota/quota-label";
import { useQuota } from "@/lib/quota/store";
import { useTheme } from "@/lib/theme";
import { AGENT_LABEL } from "@/lib/quota/agent";
import { getOrchestratorAuthorization } from "@/lib/orchestrator/capability";
import {
  pullClaudeUsage,
  pullCodexUsage,
  pullGrokUsage,
  pullOfficialHistory,
  pullOfficialQuota,
} from "@/lib/quota/watch";
import { cn } from "@/lib/utils";

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
  const [view, setView] = useState<ViewId>(
    import.meta.env.VITE_DESKTOP_UPDATER_E2E === "true" ? "settings" : "monitor",
  );
  const [now, setNow] = useState(() => Date.now());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [officialLoadState, setOfficialLoadState] = useState<OfficialLoadState>("loading");
  const historyLoaded = useRef(false);

  const events = useQuota((s) => s.events);
  const realEvents = useQuota((s) => s.realEvents);
  const calibrationEvents = useQuota((s) => s.calibrationEvents);
  const agentAvailability = useQuota((s) => s.agentAvailability);
  const liveClaude = useQuota((s) => s.liveClaude);
  const liveGrok = useQuota((s) => s.liveGrok);
  const liveCodex = useQuota((s) => s.liveCodex);
  const demoMode = useQuota((s) => s.demoMode);
  const minimalMode = useQuota((s) => s.minimalMode);
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
  const analyticsEvents = useMemo(
    () => eventsForAgents(demoMode ? events : calibrationEvents, visibleAgents),
    [demoMode, events, calibrationEvents, visibleAgents],
  );

  useEffect(() => {
    getOrchestratorAuthorization();
  }, []);

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
      const activeEvents = eventsForAgents(
        state.demoMode ? state.events : state.calibrationEvents,
        activeAgents,
      );
      const check = (
        agent: "claude" | "grok" | "codex",
        meter: ReturnType<typeof meterFor>,
        kind: PrimaryWindowKind,
        sources: MeterDataSources | null,
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
        const primaryLatchKey = kind === "weekly" ? weekKey : winKey;
        const primarySource = kind === "weekly" ? sources?.week : sources?.window;
        const primaryAvailable = sources == null || primarySource === "official";
        const primaryTriggered = primaryAvailable
          ? state.claimAlertLatch(
              primaryLatchKey,
              decision.primaryPercent,
              decision.primaryThreshold,
            )
          : false;
        if (decision.primaryTriggered && primaryTriggered) {
          const message = `${name} ${decision.primaryLabel}已用 ${decision.primaryPercent.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({
            ts: t,
            agent,
            kind: kind === "weekly" ? "week" : "window",
            message,
          });
        }
        const weekAvailable = sources == null || sources.week === "official";
        const weekTriggered =
          kind !== "weekly" && weekAvailable
            ? state.claimAlertLatch(weekKey, meter.weekPct, state.alertWeekPct)
            : false;
        if (decision.weekTriggered && weekTriggered) {
          const message = `${name} 本周额度已用 ${meter.weekPct.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({ ts: t, agent, kind: "week", message });
        }
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
      const claudeSources = meterDataSources(state.official.claude);
      const grokSources = meterDataSources(state.official.grok);
      const codexSources = meterDataSources(state.official.codex);
      const claudeDecisionMeter = state.demoMode
        ? claudeMeter
        : officialOnlyMeter(claudeMeter, claudeSources);
      const grokDecisionMeter = state.demoMode
        ? grokMeter
        : officialOnlyMeter(grokMeter, grokSources);
      const codexDecisionMeter = state.demoMode
        ? codexMeter
        : officialOnlyMeter(codexMeter, codexSources);
      if (activeAgents.includes("claude")) {
        if (claudeDecisionMeter) {
          check(
            "claude",
            claudeDecisionMeter,
            state.official.claude?.windowKind ?? "five_hour",
            state.demoMode ? null : claudeSources,
            "claudeWin",
            "claudeWeek",
            "Claude Code",
          );
        }
        const fableAvailable =
          claudeFableLimit != null &&
          (state.demoMode || !state.official.claude?.modelWeekLimitsStale);
        const fableTriggered = fableAvailable
          ? state.claimAlertLatch("claudeFable", claudeFableLimit.usedPct, state.alertWeekPct)
          : false;
        if (
          claudeFableLimit &&
          (state.demoMode || !state.official.claude?.modelWeekLimitsStale) &&
          fableTriggered
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
          state.demoMode ? null : grokSources,
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
          state.demoMode ? null : codexSources,
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
  const calibrationTruncatedBeforeMs = useQuota((s) => s.calibrationTruncatedBeforeMs);
  const claudeMeter = useMemo(
    () =>
      applyOfficial(
        meterFor(analyticsEvents, "claude", claudePlan, now, weekBoostPct),
        official.claude,
      ),
    [analyticsEvents, claudePlan, now, weekBoostPct, official.claude],
  );
  const claudeFableLimit = useMemo(
    () => modelWeekLimitFor(claudePlan, official.claude, "fable"),
    [claudePlan, official.claude],
  );
  const grokMeter = useMemo(
    () =>
      applyOfficial(meterFor(analyticsEvents, "grok", grokPlan, now, weekBoostPct), official.grok),
    [analyticsEvents, grokPlan, now, weekBoostPct, official.grok],
  );
  const codexMeter = useMemo(
    () =>
      applyOfficial(
        meterFor(analyticsEvents, "codex", codexPlan, now, weekBoostPct),
        official.codex,
      ),
    [analyticsEvents, codexPlan, now, weekBoostPct, official.codex],
  );
  const claudeSources = meterDataSources(official.claude);
  const grokSources = meterDataSources(official.grok);
  const codexSources = meterDataSources(official.codex);

  const live = visibleAgents.some((agent) =>
    agent === "claude" ? liveClaude : agent === "grok" ? liveGrok : liveCodex,
  );
  const claudeWeekVal = useMemo(
    () =>
      quotaValueFor(
        analyticsEvents,
        "claude",
        official.claude,
        "weekly",
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      ),
    [analyticsEvents, official.claude, now, quotaSamples, calibrationTruncatedBeforeMs],
  );
  const claudeWinVal = useMemo(
    () =>
      quotaValueFor(
        analyticsEvents,
        "claude",
        official.claude,
        "five_hour",
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      ),
    [analyticsEvents, official.claude, now, quotaSamples, calibrationTruncatedBeforeMs],
  );
  const grokWeekVal = useMemo(
    () =>
      quotaValueFor(
        analyticsEvents,
        "grok",
        official.grok,
        "weekly",
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      ),
    [analyticsEvents, official.grok, now, quotaSamples, calibrationTruncatedBeforeMs],
  );
  const grokWinVal = useMemo(
    () =>
      quotaValueFor(
        analyticsEvents,
        "grok",
        official.grok,
        "five_hour",
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      ),
    [analyticsEvents, official.grok, now, quotaSamples, calibrationTruncatedBeforeMs],
  );
  const codexWeekVal = useMemo(
    () =>
      quotaValueFor(
        analyticsEvents,
        "codex",
        official.codex,
        "weekly",
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      ),
    [analyticsEvents, official.codex, now, quotaSamples, calibrationTruncatedBeforeMs],
  );
  const codexWinVal = useMemo(
    () =>
      quotaValueFor(
        analyticsEvents,
        "codex",
        official.codex,
        "five_hour",
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      ),
    [analyticsEvents, official.codex, now, quotaSamples, calibrationTruncatedBeforeMs],
  );
  const claudePoolViews = useMemo<QuotaPoolView[]>(() => {
    const slice = official.claude;
    if (!slice) return [];
    return (slice.quotaPools ?? []).flatMap((pool) => {
      const valuation = quotaValueForPool(
        analyticsEvents,
        slice,
        pool,
        now,
        quotaSamples ?? [],
        calibrationTruncatedBeforeMs,
      );
      return valuation ? [{ pool, valuation }] : [];
    });
  }, [official.claude, analyticsEvents, now, quotaSamples, calibrationTruncatedBeforeMs]);
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

  const fitMonitor = view === "monitor" && visibleAgents.length > 0 && minimalMode;

  return (
    <div
      className={cn(
        "flex min-h-dvh flex-col bg-canvas text-ink",
        fitMonitor && "h-dvh overflow-hidden",
      )}
    >
      <Toaster
        theme={theme}
        position="bottom-center"
        toastOptions={{
          className: "!rounded-2xl !border-line !bg-surface !text-ink",
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

      <main
        className={cn(
          "mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6",
          fitMonitor ? "min-h-0 overflow-hidden py-3" : "overflow-y-auto py-4 sm:py-5",
        )}
      >
        {adapterHint && !minimalMode && view === "monitor" && visibleAgents.length ? (
          <div className="mb-3 flex flex-col gap-3 rounded-2xl bg-surface px-4 py-3 shadow-[var(--shadow-border)] sm:flex-row sm:items-center">
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
            <Button className="mt-4" onClick={() => setView("settings")}>
              打开设置
            </Button>
          </Card>
        ) : null}

        {view === "monitor" && visibleAgents.length ? (
          <div
            className={cn("flex flex-col gap-4", fitMonitor && "min-h-0 flex-1 overflow-hidden")}
          >
            <section className="grid shrink-0 items-stretch gap-4 lg:grid-cols-[minmax(0,15rem)_1fr]">
              {tighter ? (
                <Card className="flex h-full flex-col justify-between gap-5">
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-mute">更紧的窗口</p>
                    <p className="font-mono text-4xl leading-none font-medium tracking-tight tabular">
                      {Math.max(0, 100 - tighterPct).toFixed(0)}
                      <span className="ml-1 text-lg text-mute">%</span>
                    </p>
                    <p className="text-sm text-mute">{tighter.label} 先碰到上限</p>
                  </div>
                  <dl className="flex flex-col gap-2.5 text-xs">
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
                      className="w-full"
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

              <Card className="flex h-full flex-col">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <CardTitle>协同时间线</CardTitle>
                    <InlineHelp
                      label={`协同时间线：${visibleAgents.length} 路 Agent 共享同一口 5 小时时钟`}
                    />
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

            <section className="grid min-w-0 shrink-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleAgents.includes("claude") ? (
                <AgentCard
                  name="Claude Code"
                  adapter="~/.claude"
                  plan={claudePlan}
                  meter={claudeMeter}
                  session={claudeSession}
                  live={liveClaude}
                  minimalMode={minimalMode}
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
                  quotaPools={claudePoolViews}
                  weekValue={claudeWeekVal}
                  windowValue={claudeWinVal}
                  weekResetsAt={official.claude?.weekResetsAt ?? null}
                  events={analyticsEvents}
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
                  minimalMode={minimalMode}
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
                  events={analyticsEvents}
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
                  minimalMode={minimalMode}
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
                  events={analyticsEvents}
                  now={now}
                  onToggle={() => useQuota.getState().toggleLive("codex")}
                />
              ) : null}
            </section>

            <section
              className={cn(
                "grid min-h-0 gap-4",
                fitMonitor ? "flex-1" : "lg:grid-cols-[1.2fr_0.8fr]",
              )}
            >
              <Card className={fitMonitor ? "flex min-h-0 flex-1 flex-col" : undefined}>
                <div className="flex items-center gap-1.5">
                  <CardTitle>近 24 小时 token</CardTitle>
                  <InlineHelp
                    label={`近 24 小时 token：按小时叠加，便于看 ${visibleAgents.length} 路 Agent 燃烧节奏`}
                  />
                </div>
                <div className={fitMonitor ? "mt-2 min-h-0 flex-1" : "mt-3"}>
                  <UsageChart
                    agents={visibleAgents}
                    events={visibleEvents}
                    now={now}
                    className={fitMonitor ? "h-full min-h-0" : undefined}
                  />
                </div>
              </Card>
              {!minimalMode ? (
                <Card>
                  <CardTitle>实时流水</CardTitle>
                  <CardHint className="mt-1">点一条看完整会话</CardHint>
                  <div className="mt-3">
                    <EventFeed events={visibleEvents} now={now} onOpen={setSessionId} />
                  </div>
                </Card>
              ) : null}
            </section>
          </div>
        ) : null}

        {view === "settings" ? <SettingsPanel agents={visibleAgents} /> : null}

        {view === "report" ? (
          <ReportPanel
            agents={visibleAgents}
            events={analyticsEvents}
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
      </main>
    </div>
  );
}
