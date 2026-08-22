import { useCallback, useEffect, useMemo, useState } from "react";
import { MeterBar } from "@/components/balance/meter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentDotClass, agentTextClass } from "@/lib/quota/agent";
import { visibleAgentIds } from "@/lib/quota/agent-availability";
import { useQuota } from "@/lib/quota/store";
import {
  pullAgentAvailability,
  pullClaudeUsage,
  pullCodexUsage,
  pullGrokUsage,
  pullOfficialQuota,
} from "@/lib/quota/watch";
import {
  formatResetIn,
  pickPreferredSubscription,
  preferredSubscriptionHint,
  subscriptionLoad,
  weeklyQuotaRows,
  type WeeklyQuotaRow,
} from "@/lib/quota/weekly-dashboard";
import { cn } from "@/lib/utils";

const STATUS_COPY = {
  ok: "充足",
  watch: "留意",
  critical: "将尽",
} as const;

function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function WeekRow({
  row,
  now,
  preferred,
}: {
  row: WeeklyQuotaRow;
  now: number;
  preferred: boolean;
}) {
  const used = subscriptionLoad(row);
  const remain = Math.max(0, 100 - used);
  const remainText = remain.toFixed(remain >= 10 ? 0 : 1);
  const usedText = row.usedPct.toFixed(row.usedPct >= 10 ? 0 : 1);
  const status = used >= 88 ? "critical" : used >= 72 ? "watch" : "ok";
  return (
    <article
      className={cn(
        "rounded-xl bg-surface px-3 py-2 shadow-[var(--shadow-border)]",
        preferred && "shadow-[var(--shadow-border-hover)]",
      )}
      aria-current={preferred ? "true" : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", agentDotClass(row.agent))} />
          <h2 className="truncate text-sm font-medium tracking-tight text-ink">{row.label}</h2>
          {preferred ? <Badge>推荐</Badge> : <Badge tone={status}>{STATUS_COPY[status]}</Badge>}
        </div>
        <p className="font-mono text-xl leading-none font-medium tracking-tight tabular">
          {remainText}
          <span className="ml-0.5 text-xs text-mute">%</span>
        </p>
      </div>
      <div className="mt-2">
        <MeterBar
          value={used}
          tone={used >= 88 ? "crit" : used >= 72 ? "warn" : row.agent}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-faint">
        本周已用 {usedText}% · {formatResetIn(row.resetsAt, now)}
      </p>
      {row.fable ? (
        <div className="mt-2 border-t border-line pt-2">
          <MeterBar
            value={row.fable.usedPct}
            tone={row.fable.remainPct <= 12 ? "crit" : row.fable.remainPct <= 28 ? "warn" : "claude"}
            label={`Fable 5${row.fable.stale ? " · 快照" : ""}`}
          />
        </div>
      ) : null}
    </article>
  );
}

export function TrayDashboard() {
  const [now, setNow] = useState(() => Date.now());
  const [ready, setReady] = useState(false);
  const events = useQuota((state) => state.events);
  const official = useQuota((state) => state.official);
  const availability = useQuota((state) => state.agentAvailability);
  const demoMode = useQuota((state) => state.demoMode);
  const onboardingComplete = useQuota((state) => state.onboardingComplete);
  const claudePlanId = useQuota((state) => state.claudePlanId);
  const grokPlanId = useQuota((state) => state.grokPlanId);
  const codexPlanId = useQuota((state) => state.codexPlanId);
  const weekBoostPct = useQuota((state) => state.weekBoostPct);
  const liveClaude = useQuota((state) => state.liveClaude);
  const liveGrok = useQuota((state) => state.liveGrok);
  const liveCodex = useQuota((state) => state.liveCodex);

  const refresh = useCallback(async () => {
    try {
      const availability = await pullAgentAvailability();
      useQuota.getState().setAgentAvailability(availability);
      useQuota.getState().setOfficial(await pullOfficialQuota());
      const state = useQuota.getState();
      if (state.demoMode) return;
      if (state.liveClaude) {
        const res = await pullClaudeUsage({ data: { since: state.claudeCursor } });
        useQuota.getState().ingestClaudeLogs(res.events, {
          replace: !state.claudeHydrated && res.events.length > 0,
          live: res.live,
          active: res.active,
        });
      }
      if (state.liveGrok) {
        const res = await pullGrokUsage({ data: { since: state.grokCursor } });
        useQuota.getState().ingestGrokLogs(res.events, {
          replace: !state.grokHydrated && res.events.length > 0,
          live: res.live,
          active: res.active,
        });
      }
      if (state.liveCodex) {
        const res = await pullCodexUsage({ data: { since: state.codexCursor } });
        useQuota.getState().ingestCodexLogs(res.events, {
          replace: !state.codexHydrated && res.events.length > 0,
          live: res.live,
          active: res.active,
        });
      }
    } catch {
      /* keep last snapshot */
    } finally {
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    const afterHydration = () => {
      if (useQuota.getState().demoMode) useQuota.getState().resetDemo();
      setReady(true);
      void refresh();
    };
    if (useQuota.persist.hasHydrated()) {
      afterHydration();
      return;
    }
    return useQuota.persist.onFinishHydration(afterHydration);
  }, [refresh]);

  useEffect(() => {
    if (!ready) return;
    const logsId = window.setInterval(() => void refresh(), 8000);
    const nowId = window.setInterval(() => setNow(Date.now()), 30000);
    return () => {
      window.clearInterval(logsId);
      window.clearInterval(nowId);
    };
  }, [ready, liveClaude, liveGrok, liveCodex, demoMode, refresh]);

  const rows = useMemo(
    () =>
      weeklyQuotaRows({
        events,
        availability,
        demoMode,
        official,
        claudePlanId,
        grokPlanId,
        codexPlanId,
        weekBoostPct,
        now,
      }),
    [
      events,
      availability,
      demoMode,
      official,
      claudePlanId,
      grokPlanId,
      codexPlanId,
      weekBoostPct,
      now,
    ],
  );
  const monitored = visibleAgentIds(availability, demoMode, events).length;
  const preferred = useMemo(() => pickPreferredSubscription(rows), [rows]);
  const hint = preferred ? preferredSubscriptionHint(preferred, rows) : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex items-baseline justify-between px-4 pt-2 pb-1.5">
        <p className="text-xs tracking-wide text-mute">余量 · 周限额</p>
        <p className="text-xs text-faint">{monitored ? `${monitored} 个订阅` : "未监控"}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-2">
        {!ready ? (
          <div className="rounded-xl bg-surface px-3.5 py-8 text-center text-sm text-mute shadow-[var(--shadow-border)]">
            正在读取本机配额…
          </div>
        ) : !onboardingComplete ? (
          <div className="rounded-xl bg-surface px-3.5 py-8 text-center text-sm text-mute shadow-[var(--shadow-border)]">
            请先打开主窗口完成初始设置。
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl bg-surface px-3.5 py-8 text-center text-sm text-mute shadow-[var(--shadow-border)]">
            本机还没有检测到 Claude、Grok 或 Codex。
          </div>
        ) : (
          <>
            {hint && preferred ? (
              <section
                className="rounded-xl bg-surface px-3.5 py-2.5 shadow-[var(--shadow-border)]"
                aria-labelledby="tray-pick-title"
              >
                <p className="text-xs text-mute">现在该用</p>
                <h1
                  id="tray-pick-title"
                  className={cn("mt-0.5 text-lg font-medium tracking-tight", agentTextClass(preferred.agent))}
                >
                  {preferred.label}
                </h1>
                <p className="mt-1 text-xs leading-relaxed text-mute">{hint.body}</p>
              </section>
            ) : null}
            {rows.map((row) => (
              <WeekRow key={row.agent} row={row} now={now} preferred={row.agent === preferred?.agent} />
            ))}
          </>
        )}
      </div>
      <footer className="border-t border-line px-3 py-2">
        <Button asChild className="w-full" size="sm">
          <a
            href="/__desktop/show-main"
            onClick={(event) => {
              if (!isTauriShell()) event.preventDefault();
            }}
          >
            打开主窗口
          </a>
        </Button>
      </footer>
    </div>
  );
}
