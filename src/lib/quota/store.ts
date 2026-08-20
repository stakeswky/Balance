import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { rawTokens } from "./engine";
import { parseUsagePayload } from "./parse";
import { importedClaudeEvents, sessionFromEvents } from "./imported";
import { liveRng, newSession, nextLiveEvent, seedHistory } from "./seed";
import { samplesFromOfficial, samplesFromOfficialHistory, type QuotaSample } from "./quota-value";
import {
  grokPlanIdFromLabel,
  nextCodexPlanId,
  type OfficialQuota,
  type OfficialSlice,
} from "./official";
import type { AgentId, ClaudeLiveInfo, SessionState, UsageEvent } from "./types";

const MAX_EVENTS = 20000;
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
  grokPlanId: string;
  codexPlanId: string;
  weekBoostPct: number;
  events: UsageEvent[];
  liveClaude: boolean;
  liveGrok: boolean;
  liveCodex: boolean;
  demoMode: boolean;
  claudeCursor: number;
  grokCursor: number;
  codexCursor: number;
  claudeHydrated: boolean;
  grokHydrated: boolean;
  codexHydrated: boolean;
  claudeWriting: boolean;
  grokWriting: boolean;
  codexWriting: boolean;
  claudeSession: SessionState | null;
  grokSession: SessionState | null;
  codexSession: SessionState | null;
  official: OfficialQuota;
  quotaSamples: QuotaSample[];
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
  ingestClaudeLogs: (
    incoming: UsageEvent[],
    opts?: { replace?: boolean; live?: ClaudeLiveInfo | null },
  ) => number;
  ingestGrokLogs: (
    incoming: UsageEvent[],
    opts?: { replace?: boolean; live?: ClaudeLiveInfo | null },
  ) => number;
  ingestCodexLogs: (
    incoming: UsageEvent[],
    opts?: { replace?: boolean; live?: ClaudeLiveInfo | null },
  ) => number;
  setOfficial: (official: OfficialQuota) => void;
  recordOfficialSamples: (now?: number) => void;
  recordOfficialHistory: (history: OfficialSlice[]) => void;
  recordCodexHistory: (history: OfficialSlice[]) => void;
  loadImported: () => number;
  resetDemo: () => void;
  setHint: (on: boolean) => void;
}

function trimEvents(events: UsageEvent[]) {
  if (events.length <= MAX_EVENTS) return events;
  return events.slice(events.length - MAX_EVENTS);
}

function startTrio(now: number) {
  const rng = liveRng();
  return {
    claudeSession: newSession(rng, "claude", now),
    grokSession: newSession(rng, "grok", now),
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

const INITIAL_CLAUDE = importedClaudeEvents();

export const useQuota = create<QuotaState>()(
  persist(
    (set, get) => ({
      claudePlanId: "claude-max-20x",
      grokPlanId: "grok-super",
      codexPlanId: "chatgpt-plus",
      weekBoostPct: 50,
      events: INITIAL_CLAUDE,
      liveClaude: true,
      liveGrok: true,
      liveCodex: true,
      demoMode: false,
      claudeCursor: 0,
      grokCursor: 0,
      codexCursor: 0,
      claudeHydrated: false,
      grokHydrated: false,
      codexHydrated: false,
      claudeWriting: false,
      grokWriting: false,
      codexWriting: false,
      claudeSession: sessionFromEvents(INITIAL_CLAUDE),
      grokSession: null,
      codexSession: null,
      official: { claude: null, grok: null, codex: null },
      quotaSamples: [],
      lastBeat: 0,
      adapterHint: true,
      alertWindowPct: 80,
      alertWeekPct: 85,
      alerts: [],
      setPlan: (agent, id) => {
        if (agent === "claude") set({ claudePlanId: id });
        else if (agent === "grok") set({ grokPlanId: id });
        else set({ codexPlanId: id });
      },
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
          const leavingDemo = on && get().demoMode;
          set({
            liveClaude: on,
            demoMode: on ? false : get().demoMode,
            claudeHydrated: leavingDemo ? false : get().claudeHydrated,
            claudeCursor: leavingDemo ? 0 : get().claudeCursor,
            claudeSession: on ? (get().claudeSession ?? newSession(rng, "claude", now)) : get().claudeSession,
          });
        } else if (agent === "grok") {
          const on = !get().liveGrok;
          const leavingDemo = on && get().demoMode;
          set({
            liveGrok: on,
            demoMode: on ? false : get().demoMode,
            grokHydrated: leavingDemo ? false : get().grokHydrated,
            grokCursor: leavingDemo ? 0 : get().grokCursor,
            grokSession: on ? (get().grokSession ?? newSession(rng, "grok", now)) : get().grokSession,
          });
        } else {
          const on = !get().liveCodex;
          const leavingDemo = on && get().demoMode;
          set({
            liveCodex: on,
            demoMode: on ? false : get().demoMode,
            codexHydrated: leavingDemo ? false : get().codexHydrated,
            codexCursor: leavingDemo ? 0 : get().codexCursor,
            codexSession: on ? (get().codexSession ?? newSession(rng, "codex", now)) : get().codexSession,
          });
        }
      },
      setBothLive: (on) => {
        const now = Date.now();
        const rng = liveRng();
        set({
          liveClaude: on,
          liveGrok: on,
          liveCodex: on,
          claudeSession: on ? (get().claudeSession ?? newSession(rng, "claude", now)) : get().claudeSession,
          grokSession: on ? (get().grokSession ?? newSession(rng, "grok", now)) : get().grokSession,
          codexSession: on ? (get().codexSession ?? newSession(rng, "codex", now)) : get().codexSession,
        });
      },
      tick: (now = Date.now()) => {
        const state = get();
        const rng = liveRng();
        const emitted: UsageEvent[] = [];
        let claudeSession =
          state.claudeSession ??
          (state.demoMode && state.liveClaude ? newSession(rng, "claude", now) : null);
        let grokSession =
          state.grokSession ?? (state.demoMode && state.liveGrok ? newSession(rng, "grok", now) : null);
        let codexSession =
          state.codexSession ?? (state.demoMode && state.liveCodex ? newSession(rng, "codex", now) : null);

        const maybeRotate = (session: SessionState, agent: AgentId) => {
          if (session.events > 0 && (session.events >= 8 || now - session.startedAt > 18 * 60_000) && rng() < 0.22) {
            return newSession(rng, agent, now);
          }
          return session;
        };

        if (state.demoMode && state.liveClaude && claudeSession && rng() < 0.62) {
          claudeSession = maybeRotate(claudeSession, "claude");
          const ev = nextLiveEvent(rng, "claude", claudeSession, now);
          emitted.push(ev);
          claudeSession = bumpSession(claudeSession, ev);
        }
        if (state.demoMode && state.liveGrok && grokSession && rng() < 0.6) {
          grokSession = maybeRotate(grokSession, "grok");
          const ev = nextLiveEvent(rng, "grok", grokSession, now);
          emitted.push(ev);
          grokSession = bumpSession(grokSession, ev);
        }
        if (state.demoMode && state.liveCodex && codexSession && rng() < 0.58) {
          codexSession = maybeRotate(codexSession, "codex");
          const ev = nextLiveEvent(rng, "codex", codexSession, now);
          emitted.push(ev);
          codexSession = bumpSession(codexSession, ev);
        }

        if (!emitted.length) {
          set({ lastBeat: now, claudeSession, grokSession, codexSession });
          return emitted;
        }

        set({
          events: trimEvents([...state.events, ...emitted]),
          lastBeat: now,
          claudeSession,
          grokSession,
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
      ingestClaudeLogs: (incoming, opts) => {
        const state = get();
        const others = state.events.filter((e) => e.agent !== "claude");
        let claude: UsageEvent[];
        if (opts?.replace) {
          claude = incoming;
        } else {
          const map = new Map(
            state.events.filter((e) => e.agent === "claude").map((e) => [e.id, e] as const),
          );
          for (const ev of incoming) map.set(ev.id, ev);
          claude = [...map.values()];
        }
        const events = trimEvents([...others, ...claude].sort((a, b) => a.ts - b.ts));
        const cursor = claude.reduce((m, e) => Math.max(m, e.ts), state.claudeCursor);
        const live = opts?.live;
        const focus = live ? claude.filter((e) => e.sessionId === live.sessionId) : claude;
        set({
          events,
          claudeCursor: cursor,
          claudeHydrated: state.claudeHydrated || incoming.length > 0,
          claudeWriting: live?.writing ?? state.claudeWriting,
          claudeSession: sessionFromEvents(focus) ?? sessionFromEvents(claude) ?? state.claudeSession,
          lastBeat: Date.now(),
        });
        return incoming.length;
      },
      ingestGrokLogs: (incoming, opts) => {
        const state = get();
        const others = state.events.filter((e) => e.agent !== "grok");
        let grok: UsageEvent[];
        if (opts?.replace) {
          grok = incoming;
        } else {
          const map = new Map(
            state.events.filter((e) => e.agent === "grok").map((e) => [e.id, e] as const),
          );
          for (const ev of incoming) map.set(ev.id, ev);
          grok = [...map.values()];
        }
        const events = trimEvents([...others, ...grok].sort((a, b) => a.ts - b.ts));
        const cursor = grok.reduce((m, e) => Math.max(m, e.ts), state.grokCursor);
        const live = opts?.live;
        const focus = live ? grok.filter((e) => e.sessionId === live.sessionId) : grok;
        set({
          events,
          grokCursor: cursor,
          grokHydrated: state.grokHydrated || incoming.length > 0,
          grokWriting: live?.writing ?? state.grokWriting,
          grokSession:
            sessionFromEvents(focus) ??
            sessionFromEvents(grok) ??
            (live
              ? {
                  id: live.sessionId,
                  task: live.task,
                  model: "grok-4.6",
                  startedAt: live.startedAt,
                  events: live.turns,
                  tokens: 0,
                }
              : state.grokSession),
          lastBeat: Date.now(),
        });
        return incoming.length;
      },
      ingestCodexLogs: (incoming, opts) => {
        const state = get();
        const others = state.events.filter((e) => e.agent !== "codex");
        let codex: UsageEvent[];
        if (opts?.replace) {
          codex = incoming;
        } else {
          const map = new Map(
            state.events.filter((e) => e.agent === "codex").map((e) => [e.id, e] as const),
          );
          for (const ev of incoming) map.set(ev.id, ev);
          codex = [...map.values()];
        }
        const events = trimEvents([...others, ...codex].sort((a, b) => a.ts - b.ts));
        const cursor = codex.reduce((m, e) => Math.max(m, e.ts), state.codexCursor);
        const live = opts?.live;
        const focus = live ? codex.filter((e) => e.sessionId === live.sessionId) : codex;
        set({
          events,
          codexCursor: cursor,
          codexHydrated: state.codexHydrated || incoming.length > 0,
          codexWriting: live?.writing ?? state.codexWriting,
          codexSession:
            sessionFromEvents(focus) ??
            sessionFromEvents(codex) ??
            (live
              ? {
                  id: live.sessionId,
                  task: live.task,
                  model: "gpt-5.6-sol",
                  startedAt: live.startedAt,
                  events: live.turns,
                  tokens: 0,
                }
              : state.codexSession),
          lastBeat: Date.now(),
        });
        return incoming.length;
      },
      setOfficial: (official) => {
        const patch: Partial<QuotaState> = { official, lastBeat: Date.now() };
        const grokPlan = grokPlanIdFromLabel(official.grok?.planLabel ?? null);
        if (grokPlan && !get().demoMode) patch.grokPlanId = grokPlan;
        if (!get().demoMode) {
          patch.codexPlanId = nextCodexPlanId(
            get().codexPlanId,
            official.codex?.planLabel ?? null,
          );
        }
        set(patch);
        get().recordOfficialSamples();
      },
      recordOfficialSamples: (now = Date.now()) => {
        const state = get();
        set({
          quotaSamples: samplesFromOfficial(state.events, state.official, now, state.quotaSamples ?? []),
        });
      },
      recordOfficialHistory: (history) => {
        if (!history.length) return;
        const state = get();
        set({
          quotaSamples: samplesFromOfficialHistory(
            state.events,
            history,
            state.quotaSamples ?? [],
          ),
        });
      },
      recordCodexHistory: (history) => {
        get().recordOfficialHistory(history);
      },
      loadImported: () => {
        const parsed = importedClaudeEvents();
        if (!parsed.length) return 0;
        set({
          events: trimEvents([...parsed, ...get().events.filter((e) => e.agent !== "claude")].sort((a, b) => a.ts - b.ts)),
          liveClaude: true,
          liveGrok: true,
          liveCodex: true,
          demoMode: false,
          claudeCursor: 0,
          claudeHydrated: false,
          grokHydrated: false,
          grokCursor: 0,
          codexCursor: 0,
          codexHydrated: false,
          claudePlanId: "claude-max-20x",
          grokPlanId: "grok-super",
          claudeSession: sessionFromEvents(parsed),
          lastBeat: Date.now(),
        });
        return parsed.length;
      },
      resetDemo: () => {
        const now = Date.now();
        set({
          events: seedHistory(now),
          ...startTrio(now),
          lastBeat: now,
          liveClaude: true,
          liveGrok: true,
          liveCodex: true,
          demoMode: true,
          claudeCursor: 0,
          grokCursor: 0,
          codexCursor: 0,
          claudeHydrated: true,
          grokHydrated: true,
          codexHydrated: true,
          claudeWriting: false,
          grokWriting: false,
          codexWriting: false,
          quotaSamples: [],
        });
      },
      setHint: (on) => set({ adapterHint: on }),
    }),
    {
      name: "synq-quota-v8",
      storage: createJSONStorage(() => {
        const memory = new Map<string, string>();
        return {
          getItem: (name) => {
            try {
              if (typeof localStorage === "undefined") return memory.get(name) ?? null;
              try {
                localStorage.removeItem("synq-quota-v7");
              } catch {
                /* ignore */
              }
              return localStorage.getItem(name);
            } catch {
              return memory.get(name) ?? null;
            }
          },
          setItem: (name, value) => {
            memory.set(name, value);
            try {
              if (typeof localStorage === "undefined") return;
              localStorage.setItem(name, value);
            } catch {
              /* quota — events live in memory / logs */
            }
          },
          removeItem: (name) => {
            memory.delete(name);
            try {
              if (typeof localStorage === "undefined") return;
              localStorage.removeItem(name);
            } catch {
              /* ignore */
            }
          },
        };
      }),
      partialize: (s) => ({
        claudePlanId: s.claudePlanId,
        grokPlanId: s.grokPlanId,
        codexPlanId: s.codexPlanId,
        weekBoostPct: s.weekBoostPct,
        liveClaude: s.liveClaude,
        liveGrok: s.liveGrok,
        liveCodex: s.liveCodex,
        demoMode: s.demoMode,
        adapterHint: s.adapterHint,
        alertWindowPct: s.alertWindowPct,
        alertWeekPct: s.alertWeekPct,
        alerts: s.alerts.slice(0, MAX_ALERTS),
        quotaSamples: s.quotaSamples,
      }),
    },
  ),
);
