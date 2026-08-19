import { create } from "zustand";
import { persist } from "zustand/middleware";
import { rawTokens } from "./engine";
import { parseUsagePayload } from "./parse";
import { liveRng, newSession, nextLiveEvent, seedHistory } from "./seed";
import type { AgentId, SessionState, UsageEvent } from "./types";

const MAX_EVENTS = 720;
const MAX_ALERTS = 40;

export interface QuotaAlert {
  id: string;
  ts: number;
  agent: AgentId;
  kind: "window" | "week";
  message: string;
}

export interface QuotaState {
  claudePlanId: string;
  codexPlanId: string;
  weekBoostPct: number;
  events: UsageEvent[];
  liveClaude: boolean;
  liveCodex: boolean;
  claudeSession: SessionState | null;
  codexSession: SessionState | null;
  lastBeat: number;
  adapterHint: boolean;
  alertWindowPct: number;
  alertWeekPct: number;
  alerts: QuotaAlert[];
  setPlan: (agent: AgentId, id: string) => void;
  setBoost: (n: number) => void;
  setAlertWindow: (n: number) => void;
  setAlertWeek: (n: number) => void;
  pushAlert: (alert: Omit<QuotaAlert, "id">) => void;
  clearAlerts: () => void;
  toggleLive: (agent: AgentId) => void;
  setBothLive: (on: boolean) => void;
  tick: (now?: number) => UsageEvent[];
  importText: (text: string, agent: AgentId) => number;
  resetDemo: () => void;
  setHint: (on: boolean) => void;
}

function trimEvents(events: UsageEvent[]) {
  if (events.length <= MAX_EVENTS) return events;
  return events.slice(events.length - MAX_EVENTS);
}

function startPair(now: number) {
  const rng = liveRng();
  return {
    claudeSession: newSession(rng, "claude", now),
    codexSession: newSession(rng, "codex", now),
  };
}

function bumpSession(session: SessionState, ev: UsageEvent): SessionState {
  return {
    ...session,
    events: session.events + 1,
    tokens: session.tokens + rawTokens(ev),
  };
}

export const useQuota = create<QuotaState>()(
  persist(
    (set, get) => ({
      claudePlanId: "claude-max-5x",
      codexPlanId: "chatgpt-plus",
      weekBoostPct: 50,
      events: [],
      liveClaude: true,
      liveCodex: true,
      claudeSession: null,
      codexSession: null,
      lastBeat: 0,
      adapterHint: true,
      alertWindowPct: 80,
      alertWeekPct: 85,
      alerts: [],
      setPlan: (agent, id) =>
        set(agent === "claude" ? { claudePlanId: id } : { codexPlanId: id }),
      setBoost: (n) => set({ weekBoostPct: Math.max(0, Math.min(100, Math.round(n))) }),
      setAlertWindow: (n) => set({ alertWindowPct: Math.max(40, Math.min(99, Math.round(n))) }),
      setAlertWeek: (n) => set({ alertWeekPct: Math.max(40, Math.min(99, Math.round(n))) }),
      pushAlert: (alert) =>
        set({
          alerts: [{ ...alert, id: `al_${alert.ts}_${alert.agent}` }, ...get().alerts].slice(0, MAX_ALERTS),
        }),
      clearAlerts: () => set({ alerts: [] }),
      toggleLive: (agent) => {
        const now = Date.now();
        const rng = liveRng();
        if (agent === "claude") {
          const on = !get().liveClaude;
          set({
            liveClaude: on,
            claudeSession: on ? (get().claudeSession ?? newSession(rng, "claude", now)) : get().claudeSession,
          });
        } else {
          const on = !get().liveCodex;
          set({
            liveCodex: on,
            codexSession: on ? (get().codexSession ?? newSession(rng, "codex", now)) : get().codexSession,
          });
        }
      },
      setBothLive: (on) => {
        const now = Date.now();
        const rng = liveRng();
        set({
          liveClaude: on,
          liveCodex: on,
          claudeSession: on ? (get().claudeSession ?? newSession(rng, "claude", now)) : get().claudeSession,
          codexSession: on ? (get().codexSession ?? newSession(rng, "codex", now)) : get().codexSession,
        });
      },
      tick: (now = Date.now()) => {
        const state = get();
        const rng = liveRng();
        const emitted: UsageEvent[] = [];
        let claudeSession = state.claudeSession ?? (state.liveClaude ? newSession(rng, "claude", now) : null);
        let codexSession = state.codexSession ?? (state.liveCodex ? newSession(rng, "codex", now) : null);

        const maybeRotate = (session: SessionState, agent: AgentId) => {
          if (session.events > 0 && (session.events >= 8 || now - session.startedAt > 18 * 60_000) && rng() < 0.22) {
            return newSession(rng, agent, now);
          }
          return session;
        };

        if (state.liveClaude && claudeSession && rng() < 0.62) {
          claudeSession = maybeRotate(claudeSession, "claude");
          const ev = nextLiveEvent(rng, "claude", claudeSession, now);
          emitted.push(ev);
          claudeSession = bumpSession(claudeSession, ev);
        }
        if (state.liveCodex && codexSession && rng() < 0.58) {
          codexSession = maybeRotate(codexSession, "codex");
          const ev = nextLiveEvent(rng, "codex", codexSession, now);
          emitted.push(ev);
          codexSession = bumpSession(codexSession, ev);
        }

        if (!emitted.length) {
          set({ lastBeat: now, claudeSession, codexSession });
          return emitted;
        }

        set({
          events: trimEvents([...state.events, ...emitted]),
          lastBeat: now,
          claudeSession,
          codexSession,
        });
        return emitted;
      },
      importText: (text, agent) => {
        const parsed = parseUsagePayload(text, agent);
        if (!parsed.length) return 0;
        set({ events: trimEvents([...get().events, ...parsed].sort((a, b) => a.ts - b.ts)) });
        return parsed.length;
      },
      resetDemo: () => {
        const now = Date.now();
        set({
          events: seedHistory(now),
          ...startPair(now),
          lastBeat: now,
          liveClaude: true,
          liveCodex: true,
        });
      },
      setHint: (on) => set({ adapterHint: on }),
    }),
    {
      name: "synq-quota-v4",
      partialize: (s) => ({
        claudePlanId: s.claudePlanId,
        codexPlanId: s.codexPlanId,
        weekBoostPct: s.weekBoostPct,
        events: s.events.slice(-MAX_EVENTS),
        liveClaude: s.liveClaude,
        liveCodex: s.liveCodex,
        adapterHint: s.adapterHint,
        alertWindowPct: s.alertWindowPct,
        alertWeekPct: s.alertWeekPct,
        alerts: s.alerts.slice(0, MAX_ALERTS),
      }),
    },
  ),
);
