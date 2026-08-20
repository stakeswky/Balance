import { useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { RotateCcw } from "lucide-react";
import { AdviceCard } from "@/components/synq/advice-card";
import { AgentCard } from "@/components/synq/agent-card";
import { EventFeed } from "@/components/synq/event-feed";
import { Header, type ViewId } from "@/components/synq/header";
import { formatDuration, formatUsd } from "@/components/synq/format";
import { PluginPanel } from "@/components/synq/plugin-panel";
import { ReportPanel } from "@/components/synq/report-panel";
import { SessionDialog } from "@/components/synq/session-dialog";
import { SettingsPanel } from "@/components/synq/settings-panel";
import { DualTimeline } from "@/components/synq/timeline";
import { UsageChart } from "@/components/synq/usage-chart";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { applyOfficial, meterFor } from "@/lib/quota/engine";
import { inferCodexProPlanId } from "@/lib/quota/estimate";
import { planById } from "@/lib/quota/plans";
import {
  primaryUsagePercent,
  primaryWindowResetsAt,
  quotaAlertDecision,
  type PrimaryWindowKind,
} from "@/lib/quota/presentation";
import { quotaValueFor } from "@/lib/quota/quota-value";
import { useQuota } from "@/lib/quota/store";
import { AGENT_LABEL } from "@/lib/quota/agent";
import { pullClaudeUsage, pullCodexUsage, pullGrokUsage, pullOfficialHistory, pullOfficialQuota } from "@/lib/quota/watch";

function seedIfEmpty() {
  if (useQuota.getState().events.length === 0) {
    useQuota.getState().loadImported();
  }
}

export function Dashboard() {
  const [view, setView] = useState<ViewId>("monitor");
  const [now, setNow] = useState(() => Date.now());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const historyLoaded = useRef(false);
  const warned = useRef({
    claudeWin: false,
    claudeWeek: false,
    grokWin: false,
    grokWeek: false,
    codexWin: false,
    codexWeek: false,
  });

  const events = useQuota((s) => s.events);
  const liveClaude = useQuota((s) => s.liveClaude);
  const liveGrok = useQuota((s) => s.liveGrok);
  const liveCodex = useQuota((s) => s.liveCodex);
  const demoMode = useQuota((s) => s.demoMode);
  const claudeWriting = useQuota((s) => s.claudeWriting);
  const grokWriting = useQuota((s) => s.grokWriting);
  const codexWriting = useQuota((s) => s.codexWriting);
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

  useEffect(() => {
    const persist = useQuota.persist;
    const unsub = persist.onFinishHydration(seedIfEmpty);
    if (persist.hasHydrated()) seedIfEmpty();
    return unsub;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const checkAlerts = (t = Date.now()) => {
      const state = useQuota.getState();
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
        if (decision.primaryPercent < decision.primaryThreshold - 12) warned.current[winKey] = false;
        if (decision.weekTriggered && !warned.current[weekKey]) {
          warned.current[weekKey] = true;
          const message = `${name} 本周额度已用 ${meter.weekPct.toFixed(0)}%`;
          toast.error(message);
          state.pushAlert({ ts: t, agent, kind: "week", message });
        }
        if (meter.weekPct < state.alertWeekPct - 12) warned.current[weekKey] = false;
      };

      const claudeMeter = applyOfficial(
        meterFor(state.events, "claude", planById(state.claudePlanId), t, state.weekBoostPct),
        state.official.claude,
      );
      const grokMeter = applyOfficial(
        meterFor(state.events, "grok", planById(state.grokPlanId), t, state.weekBoostPct),
        state.official.grok,
      );
      const codexMeter = applyOfficial(
        meterFor(state.events, "codex", planById(state.codexPlanId), t, state.weekBoostPct),
        state.official.codex,
      );
      check(
        "claude",
        claudeMeter,
        state.official.claude?.windowKind ?? "five_hour",
        "claudeWin",
        "claudeWeek",
        "Claude Code",
      );
      check(
        "grok",
        grokMeter,
        state.official.grok?.windowKind ?? "five_hour",
        "grokWin",
        "grokWeek",
        "Grok",
      );
      check(
        "codex",
        codexMeter,
        state.official.codex?.windowKind ?? "five_hour",
        "codexWin",
        "codexWeek",
        "Codex",
      );
    };
    const pullOfficial = async () => {
      try {
        const official = await pullOfficialQuota();
        if (!cancelled) {
          useQuota.getState().setOfficial(official);
          const t = Date.now();
          setNow(t);
          checkAlerts(t);
        }
      } catch {
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
          });
        }
        if (state.liveGrok) {
          const res = await pullGrokUsage({ data: { since: state.grokCursor } });
          if (cancelled) return;
          added += useQuota.getState().ingestGrokLogs(res.events, {
            replace: !state.grokHydrated && res.events.length > 0,
            live: res.live,
          });
        }
        if (state.liveCodex) {
          const res = await pullCodexUsage({ data: { since: state.codexCursor } });
          if (cancelled) return;
          added += useQuota.getState().ingestCodexLogs(res.events, {
            replace: !state.codexHydrated && res.events.length > 0,
            live: res.live,
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
    () => applyOfficial(meterFor(events, "claude", claudePlan, now, weekBoostPct), official.claude),
    [events, claudePlan, now, weekBoostPct, official.claude],
  );
  const grokMeter = useMemo(
    () => applyOfficial(meterFor(events, "grok", grokPlan, now, weekBoostPct), official.grok),
    [events, grokPlan, now, weekBoostPct, official.grok],
  );
  const codexMeter = useMemo(
    () => applyOfficial(meterFor(events, "codex", codexPlan, now, weekBoostPct), official.codex),
    [events, codexPlan, now, weekBoostPct, official.codex],
  );

  const live = liveClaude || liveGrok || liveCodex;
  const claudeWeekVal = useMemo(
    () => quotaValueFor(events, "claude", official.claude, "weekly", now, quotaSamples ?? []),
    [events, official.claude, now, quotaSamples],
  );
  const claudeWinVal = useMemo(
    () => quotaValueFor(events, "claude", official.claude, "five_hour", now, quotaSamples ?? []),
    [events, official.claude, now, quotaSamples],
  );
  const grokWeekVal = useMemo(
    () => quotaValueFor(events, "grok", official.grok, "weekly", now, quotaSamples ?? []),
    [events, official.grok, now, quotaSamples],
  );
  const grokWinVal = useMemo(
    () => quotaValueFor(events, "grok", official.grok, "five_hour", now, quotaSamples ?? []),
    [events, official.grok, now, quotaSamples],
  );
  const codexWeekVal = useMemo(
    () => quotaValueFor(events, "codex", official.codex, "weekly", now, quotaSamples ?? []),
    [events, official.codex, now, quotaSamples],
  );
  const codexWinVal = useMemo(
    () => quotaValueFor(events, "codex", official.codex, "five_hour", now, quotaSamples ?? []),
    [events, official.codex, now, quotaSamples],
  );
  const combinedUsd = claudeWeekVal.l1Usd + grokWeekVal.l1Usd + codexWeekVal.l1Usd;
  const subUsd =
    (claudePlan.kind === "subscription" ? claudePlan.priceUsd : 0) +
    (grokPlan.kind === "subscription" ? grokPlan.priceUsd : 0) +
    (codexPlan.kind === "subscription" ? codexPlan.priceUsd : 0);
  const primaryMeters = [
    { meter: claudeMeter, kind: official.claude?.windowKind ?? "five_hour" },
    { meter: grokMeter, kind: official.grok?.windowKind ?? "five_hour" },
    { meter: codexMeter, kind: official.codex?.windowKind ?? "five_hour" },
  ] satisfies { meter: typeof claudeMeter; kind: PrimaryWindowKind }[];
  const tighter = [...primaryMeters].sort(
    (a, b) => primaryUsagePercent(b.meter, b.kind) - primaryUsagePercent(a.meter, a.kind),
  )[0]!;
  const tighterPct = primaryUsagePercent(tighter.meter, tighter.kind);
  const watching = [liveClaude && "Claude", liveGrok && "Grok", liveCodex && "Codex"].filter(
    (name): name is string => Boolean(name),
  );
  const watchText = !demoMode && watching.length ? `监听 ${watching.join(" / ")} 日志` : undefined;

  useEffect(() => {
    if (demoMode) return;
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
    official.codex?.planLabel,
    codexWeekVal.confidence,
    codexWeekVal.l1Tokens,
    codexWeekVal.usedPct,
    codexPlanId,
  ]);

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          className: "!bg-surface !text-ink !border-line",
        }}
      />
      <Header view={view} onView={setView} live={live} watchText={watchText} />
      <SessionDialog sessionId={sessionId} events={events} now={now} onClose={() => setSessionId(null)} />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {adapterHint && view === "monitor" ? (
          <div className="mb-5 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 shadow-[var(--shadow-border)] sm:flex-row sm:items-center">
            <p className="flex-1 text-sm text-mute">
              {demoMode
                ? "当前是演示数据。打开 Claude 或 Grok 采集会改回只读监听本机日志。"
                : "额度百分比来自官方。金额是本机日志按公开 API 价折算的 API 等价，不是账户现金余额。"}
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
                  {Math.max(0, 100 - tighterPct).toFixed(0)}
                  <span className="ml-1 text-xl text-mute">%</span>
                </p>
                <p className="mt-3 text-sm text-mute">
                  {AGENT_LABEL[tighter.meter.agent]} 先碰到上限
                </p>
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
                      {formatDuration(Math.max(0, primaryWindowResetsAt(tighter.meter, tighter.kind) - now))}
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
                    <CardHint className="mt-1">三路 Agent 共享同一口 5 小时时钟</CardHint>
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

            <section className="grid min-w-0 gap-5 lg:grid-cols-3">
              <AgentCard
                name="Claude Code"
                adapter="~/.claude"
                plan={claudePlan}
                meter={claudeMeter}
                session={claudeSession}
                live={liveClaude}
                quotaNote={official.claude ? "官方 5h / 7d 利用率" : undefined}
                liveNote={
                  demoMode
                    ? undefined
                    : claudeWriting
                      ? "jsonl 正在写入"
                      : "已接上日志，等待新回合"
                }
                weekValue={claudeWeekVal}
                windowValue={claudeWinVal}
                events={events}
                now={now}
                onToggle={() => useQuota.getState().toggleLive("claude")}
              />
              <AgentCard
                name="Grok"
                adapter="~/.grok"
                plan={grokPlan}
                meter={grokMeter}
                session={grokSession}
                live={liveGrok}
                windowLabel="本周额度"
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
                events={events}
                now={now}
                onToggle={() => useQuota.getState().toggleLive("grok")}
              />
              <AgentCard
                name="Codex"
                adapter="~/.codex"
                plan={codexPlan}
                meter={codexMeter}
                session={codexSession}
                live={liveCodex}
                windowLabel={official.codex?.windowKind === "weekly" ? "本周额度" : "5 小时窗"}
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
                events={events}
                now={now}
                onToggle={() => useQuota.getState().toggleLive("codex")}
              />
            </section>

            <AdviceCard meters={[claudeMeter, grokMeter, codexMeter]} />

            <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
              <Card>
                <CardTitle>近 24 小时 token</CardTitle>
                <CardHint className="mt-1">按小时叠加，便于看三路燃烧节奏</CardHint>
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

        {view === "settings" ? <SettingsPanel /> : null}

        {view === "report" ? (
          <ReportPanel
            events={events}
            now={now}
            claudeMeter={claudeMeter}
            grokMeter={grokMeter}
            codexMeter={codexMeter}
            claudePlanId={claudePlanId}
            grokPlanId={grokPlanId}
            codexPlanId={codexPlanId}
            weekBoostPct={weekBoostPct}
            alerts={alerts}
            weekApiUsd={combinedUsd}
            onClearAlerts={() => useQuota.getState().clearAlerts()}
            onOpenSession={setSessionId}
          />
        ) : null}

        {view === "plugin" ? <PluginPanel /> : null}
      </main>
    </div>
  );
}
