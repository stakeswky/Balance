import { useCallback, useEffect, useMemo, useState } from "react";
import { MeterBar } from "@/components/balance/meter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentDotClass } from "@/lib/quota/agent";
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
  weekSourceLabel,
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

function RemainRing({ remainPct, agent }: { remainPct: number; agent: WeeklyQuotaRow["agent"] }) {
  const remain = Math.max(0, Math.min(100, remainPct));
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative size-11 shrink-0 rounded-full",
        agent === "claude" && "text-claude",
        agent === "grok" && "text-grok",
        agent === "codex" && "text-codex",
      )}
      style={{
        background: `conic-gradient(currentColor ${remain}%, var(--color-line) 0)`,
      }}
    >
      <span className="absolute inset-[3px] rounded-full bg-surface" />
    </div>
  );
}

function WeekRow({ row, now }: { row: WeeklyQuotaRow; now: number }) {
  const remainText = row.remainPct.toFixed(row.remainPct >= 10 ? 0 : 1);
  const usedText = row.usedPct.toFixed(row.usedPct >= 10 ? 0 : 1);
  return (
    <article className="rounded-xl bg-surface px-3.5 py-3 shadow-[var(--shadow-border)]">
      <div className="flex items-start gap-3">
        <RemainRing remainPct={row.remainPct} agent={row.agent} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn("size-1.5 rounded-full", agentDotClass(row.agent))} />
              <h2 className="truncate text-sm font-medium tracking-tight text-ink">{row.label}</h2>
              <Badge tone={row.status}>{STATUS_COPY[row.status]}</Badge>
            </div>
            <p className="font-mono text-2xl leading-none font-medium tracking-tight tabular">
              {remainText}
              <span className="ml-0.5 text-sm text-mute">%</span>
            </p>
          </div>
          <p className="mt-0.5 truncate text-xs text-mute">
            {row.planName} · {weekSourceLabel(row.source)}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <MeterBar
          value={row.usedPct}
          tone={row.status === "ok" ? row.agent : row.status === "watch" ? "warn" : "crit"}
          label={`本周已用 ${usedText}%`}
        />
      </div>
      <p className="mt-2 text-xs text-faint">{formatResetIn(row.resetsAt, now)}</p>
      {row.fable ? (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <MeterBar
            value={row.fable.usedPct}
            tone={row.fable.remainPct <= 12 ? "crit" : row.fable.remainPct <= 28 ? "warn" : "claude"}
            label={`Fable 5 周额度${row.fable.stale ? " · 快照" : ""}`}
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

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="flex items-baseline justify-between px-4 pt-3 pb-2">
        <div>
          <p className="text-xs tracking-wide text-mute uppercase">余量</p>
          <h1 className="text-sm font-medium tracking-tight">周限额</h1>
        </div>
        <p className="text-xs text-faint">{monitored ? `${monitored} 个订阅` : "未监控"}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
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
          rows.map((row) => <WeekRow key={row.agent} row={row} now={now} />)
        )}
      </div>
      <footer className="border-t border-line px-3 py-2.5">
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
