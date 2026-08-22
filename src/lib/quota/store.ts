import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  ALL_AGENT_AVAILABILITY,
  EMPTY_AGENT_AVAILABILITY,
  type AgentAvailability,
} from "./agent-availability.ts";
import { rawTokens } from "./engine.ts";
import { importedClaudeEvents, sessionFromEvents } from "./imported.ts";
import { parseUsagePayload } from "./parse.ts";
import { samplesFromOfficial, samplesFromOfficialHistory, type QuotaSample } from "./quota-value.ts";
import { liveRng, newSession, nextLiveEvent, seedHistory } from "./seed.ts";
import {
  grokPlanIdFromLabel,
  nextCodexPlanId,
  type OfficialQuota,
  type OfficialSlice,
} from "./official.ts";
import { quotaEventIdentity } from "./quota-cache.ts";
import { activityIdOf, CALIBRATION_RETENTION_MS } from "./types.ts";
import type { AgentId, AgentLiveInfo, ModelId, SessionState, UsageEvent } from "./types.ts";

const MAX_DISPLAY_EVENTS = 20_000;
const MAX_CALIBRATION_EVENTS = 100_000;
const MAX_ALERTS = 40;

export interface QuotaAlert {
  id: string;
  ts: number;
  agent: AgentId;
  kind: "window" | "week";
  message: string;
}

interface TrimmedEventState {
  realEvents: UsageEvent[];
  displayEvents: UsageEvent[];
  truncatedBeforeMs: number | null;
}

function trimEventState(
  events: UsageEvent[],
  previousTruncatedBeforeMs: number | null,
  now = Date.now(),
): TrimmedEventState {
  const recent = events
    .filter((event) => event.ts >= now - CALIBRATION_RETENTION_MS)
    .sort((left, right) => left.ts - right.ts);
  const hardTrimmed = recent.length > MAX_CALIBRATION_EVENTS;
  const realEvents = hardTrimmed ? recent.slice(-MAX_CALIBRATION_EVENTS) : recent;
  const priorStillRelevant = previousTruncatedBeforeMs != null
    && previousTruncatedBeforeMs >= now - CALIBRATION_RETENTION_MS;
  return {
    realEvents,
    displayEvents: realEvents.slice(-MAX_DISPLAY_EVENTS),
    truncatedBeforeMs: hardTrimmed
      ? realEvents[0]!.ts
      : priorStillRelevant
        ? previousTruncatedBeforeMs
        : null,
  };
}

function isCacheHydratedEvent(event: UsageEvent): boolean {
  return event.id.startsWith("quota-cache:");
}

function upsertCalibrationIndex(
  index: Map<string, UsageEvent>,
  incoming: UsageEvent[],
): void {
  for (const event of incoming) {
    const identity = quotaEventIdentity(event);
    const current = index.get(identity);
    const incomingIsCache = isCacheHydratedEvent(event);
    const currentIsReal = current != null && !isCacheHydratedEvent(current);
    if (incomingIsCache && currentIsReal) continue;
    index.set(identity, event);
    if (!incomingIsCache && event.cacheIdentity != null) {
      // 同一逻辑事件可能先经 importText 以本地 key 入索引；scanner 事件到达即移除，双计最多存活一个轮询周期。
      index.delete(`import:${event.agent}:${event.id}`);
    }
  }
}

function pruneCalibrationIndex(index: Map<string, UsageEvent>, now: number): void {
  for (const [identity, event] of index) {
    if (event.ts < now - CALIBRATION_RETENTION_MS) index.delete(identity);
  }
}

function sortedCalibration(index: Map<string, UsageEvent>): UsageEvent[] {
  return [...index.values()].sort((left, right) => left.ts - right.ts);
}

export function calibrationDataFrom(
  memoryBoundary: number | null,
  cacheBoundary: number | null,
): number | null {
  const values = [memoryBoundary, cacheBoundary].filter(
    (value): value is number => value != null,
  );
  return values.length ? Math.max(...values) : null;
}

export interface QuotaState {
  claudePlanId: string;
  grokPlanId: string;
  codexPlanId: string;
  weekBoostPct: number;
  events: UsageEvent[];
  realEvents: UsageEvent[];
  liveClaude: boolean;
  liveGrok: boolean;
  liveCodex: boolean;
  demoMode: boolean;
  agentAvailability: AgentAvailability;
  captureEnabled: AgentAvailability;
  onboardingComplete: boolean;
  claudeCursor: number;
  grokCursor: number;
  codexCursor: number;
  claudeHydrated: boolean;
  grokHydrated: boolean;
  codexHydrated: boolean;
  claudeWriting: boolean;
  grokWriting: boolean;
  codexWriting: boolean;
  activeClaude: AgentLiveInfo[];
  activeGrok: AgentLiveInfo[];
  activeCodex: AgentLiveInfo[];
  claudeSession: SessionState | null;
  grokSession: SessionState | null;
  codexSession: SessionState | null;
  official: OfficialQuota;
  quotaSamples: QuotaSample[];
  calibrationTruncatedBeforeMs: number | null;
  calibrationEventIndex: Map<string, UsageEvent>;
  calibrationEvents: UsageEvent[];
  quotaCacheHydrated: boolean;
  cacheHistoryTruncated: boolean;
  cacheTruncatedBeforeMs: number | null;
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
  setAgentAvailability: (availability: AgentAvailability) => void;
  setOnboardingComplete: (complete: boolean) => void;
  setDemoMode: (on: boolean) => void;
  toggleLive: (agent: AgentId) => void;
  setBothLive: (on: boolean) => void;
  tick: (now?: number) => UsageEvent[];
  importText: (text: string, agent: AgentId) => number;
  ingestClaudeLogs: (
    incoming: UsageEvent[],
    opts?: { replace?: boolean; live?: AgentLiveInfo | null; active?: AgentLiveInfo[] },
  ) => number;
  ingestGrokLogs: (
    incoming: UsageEvent[],
    opts?: { replace?: boolean; live?: AgentLiveInfo | null; active?: AgentLiveInfo[] },
  ) => number;
  ingestCodexLogs: (
    incoming: UsageEvent[],
    opts?: { replace?: boolean; live?: AgentLiveInfo | null; active?: AgentLiveInfo[] },
  ) => number;
  setOfficial: (official: OfficialQuota) => void;
  recordOfficialSamples: (now?: number) => void;
  recordOfficialHistory: (history: OfficialSlice[]) => void;
  recordCodexHistory: (history: OfficialSlice[]) => void;
  loadImported: () => number;
  resetDemo: () => void;
  setHint: (on: boolean) => void;
  ingestQuotaCache: (
    incoming: UsageEvent[],
    opts: { publish: boolean; complete: boolean },
  ) => void;
  resetQuotaCacheHydration: () => void;
}

function trimEvents(events: UsageEvent[]) {
  if (events.length <= MAX_DISPLAY_EVENTS) return events;
  return events.slice(events.length - MAX_DISPLAY_EVENTS);
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

function eventsForLive(events: UsageEvent[], live: AgentLiveInfo | null | undefined): UsageEvent[] {
  if (!live) return events;
  const key = activityIdOf(live);
  return events.filter((event) => activityIdOf(event) === key);
}

function sessionFromLive(live: AgentLiveInfo | null | undefined, model: ModelId): SessionState | null {
  if (!live) return null;
  return {
    id: activityIdOf(live),
    task: live.task,
    model,
    startedAt: live.startedAt,
    events: live.turns,
    tokens: 0,
  };
}

type IngestOptions = {
  replace?: boolean;
  live?: AgentLiveInfo | null;
  active?: AgentLiveInfo[];
};

function idleIngestPatch(
  state: QuotaState,
  agent: AgentId,
  opts: IngestOptions | undefined,
): Partial<QuotaState> {
  const live = opts?.live;
  const active = opts?.active;
  if (agent === "claude") {
    return {
      activeClaude: active ?? state.activeClaude,
      claudeWriting: active ? active.length > 0 : live?.writing ?? state.claudeWriting,
      claudeSession: state.claudeSession ?? sessionFromLive(live, "sonnet"),
      lastBeat: Date.now(),
    };
  }
  if (agent === "grok") {
    return {
      activeGrok: active ?? state.activeGrok,
      grokWriting: active ? active.length > 0 : live?.writing ?? state.grokWriting,
      grokSession: state.grokSession ?? sessionFromLive(live, "grok-4.6"),
      lastBeat: Date.now(),
    };
  }
  return {
    activeCodex: active ?? state.activeCodex,
    codexWriting: active ? active.length > 0 : live?.writing ?? state.codexWriting,
    codexSession: state.codexSession ?? sessionFromLive(live, "gpt-5.6-sol"),
    lastBeat: Date.now(),
  };
}

export const useQuota = create<QuotaState>()(
  persist(
    (set, get) => ({
      claudePlanId: "claude-max-20x",
      grokPlanId: "grok-super",
      codexPlanId: "chatgpt-plus",
      weekBoostPct: 50,
      events: [],
      realEvents: [],
      liveClaude: false,
      liveGrok: false,
      liveCodex: false,
      demoMode: false,
      agentAvailability: { ...EMPTY_AGENT_AVAILABILITY },
      captureEnabled: { ...ALL_AGENT_AVAILABILITY },
      onboardingComplete: false,
      claudeCursor: 0,
      grokCursor: 0,
      codexCursor: 0,
      claudeHydrated: false,
      grokHydrated: false,
      codexHydrated: false,
      claudeWriting: false,
      grokWriting: false,
      codexWriting: false,
      activeClaude: [],
      activeGrok: [],
      activeCodex: [],
      claudeSession: null,
      grokSession: null,
      codexSession: null,
      official: { claude: null, grok: null, codex: null },
      quotaSamples: [],
      calibrationTruncatedBeforeMs: null,
      calibrationEventIndex: new Map<string, UsageEvent>(),
      calibrationEvents: [],
      quotaCacheHydrated: false,
      cacheHistoryTruncated: false,
      cacheTruncatedBeforeMs: null,
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
          alerts: [
            {
              ...alert,
              id: `al_${alert.ts}_${alert.agent}_${alert.kind}_${alert.message}`,
            },
            ...get().alerts,
          ].slice(0, MAX_ALERTS),
        }),
      clearAlerts: () => set({ alerts: [] }),
      setAgentAvailability: (agentAvailability) => {
        const state = get();
        set({
          agentAvailability,
          liveClaude: state.demoMode
            ? state.liveClaude
            : agentAvailability.claude && state.captureEnabled.claude,
          liveGrok: state.demoMode
            ? state.liveGrok
            : agentAvailability.grok && state.captureEnabled.grok,
          liveCodex: state.demoMode
            ? state.liveCodex
            : agentAvailability.codex && state.captureEnabled.codex,
        });
      },
      setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
      setDemoMode: (on) => {
        if (on) {
          get().resetDemo();
          return;
        }
        const state = get();
        set({
          events: state.realEvents,
          demoMode: false,
          liveClaude: state.agentAvailability.claude && state.captureEnabled.claude,
          liveGrok: state.agentAvailability.grok && state.captureEnabled.grok,
          liveCodex: state.agentAvailability.codex && state.captureEnabled.codex,
          claudeCursor: 0,
          grokCursor: 0,
          codexCursor: 0,
          claudeHydrated: false,
          grokHydrated: false,
          codexHydrated: false,
          claudeWriting: false,
          grokWriting: false,
          codexWriting: false,
          activeClaude: [],
          activeGrok: [],
          activeCodex: [],
          claudeSession: null,
          grokSession: null,
          codexSession: null,
          lastBeat: Date.now(),
        });
      },
      toggleLive: (agent) => {
        const state = get();
        if (state.demoMode) {
          if (agent === "claude") set({ liveClaude: !state.liveClaude });
          else if (agent === "grok") set({ liveGrok: !state.liveGrok });
          else set({ liveCodex: !state.liveCodex });
          return;
        }
        const captureEnabled = { ...state.captureEnabled };
        captureEnabled[agent] = !captureEnabled[agent];
        if (agent === "claude") {
          set({
            captureEnabled,
            liveClaude: state.agentAvailability.claude && captureEnabled.claude,
          });
        } else if (agent === "grok") {
          set({
            captureEnabled,
            liveGrok: state.agentAvailability.grok && captureEnabled.grok,
          });
        } else {
          set({
            captureEnabled,
            liveCodex: state.agentAvailability.codex && captureEnabled.codex,
          });
        }
      },
      setBothLive: (on) => {
        const state = get();
        if (state.demoMode) {
          set({ liveClaude: on, liveGrok: on, liveCodex: on });
          return;
        }
        const captureEnabled = {
          claude: on,
          grok: on,
          codex: on,
        };
        set({
          captureEnabled,
          liveClaude: on && state.agentAvailability.claude,
          liveGrok: on && state.agentAvailability.grok,
          liveCodex: on && state.agentAvailability.codex,
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
        const state = get();
        const merged = [...state.realEvents, ...parsed].sort((a, b) => a.ts - b.ts);
        const trimmed = trimEventState(merged, state.calibrationTruncatedBeforeMs);
        upsertCalibrationIndex(state.calibrationEventIndex, parsed);
        pruneCalibrationIndex(state.calibrationEventIndex, Date.now());
        const calibrationEvents = sortedCalibration(state.calibrationEventIndex);
        set({
          realEvents: trimmed.realEvents,
          events: state.demoMode ? state.events : trimmed.displayEvents,
          calibrationTruncatedBeforeMs: trimmed.truncatedBeforeMs,
          calibrationEvents,
        });
        return parsed.length;
      },
      ingestClaudeLogs: (incoming, opts) => {
        const state = get();
        if (!opts?.replace && incoming.length === 0) {
          set(idleIngestPatch(state, "claude", opts));
          return 0;
        }
        const others = state.realEvents.filter((e) => e.agent !== "claude");
        let claude: UsageEvent[];
        if (opts?.replace) {
          claude = incoming;
        } else {
          const map = new Map(
            state.realEvents.filter((e) => e.agent === "claude").map((e) => [e.id, e] as const),
          );
          for (const ev of incoming) map.set(ev.id, ev);
          claude = [...map.values()];
        }
        const merged = [...others, ...claude].sort((a, b) => a.ts - b.ts);
        const trimmed = trimEventState(merged, state.calibrationTruncatedBeforeMs);
        upsertCalibrationIndex(state.calibrationEventIndex, incoming);
        pruneCalibrationIndex(state.calibrationEventIndex, Date.now());
        const calibrationEvents = sortedCalibration(state.calibrationEventIndex);
        const cursor = claude.reduce((m, e) => Math.max(m, e.ts), state.claudeCursor);
        const live = opts?.live;
        const active = opts?.active;
        const focus = eventsForLive(claude, live);
        set({
          realEvents: trimmed.realEvents,
          events: state.demoMode ? state.events : trimmed.displayEvents,
          calibrationTruncatedBeforeMs: trimmed.truncatedBeforeMs,
          calibrationEvents,
          claudeCursor: cursor,
          claudeHydrated: state.claudeHydrated || incoming.length > 0,
          activeClaude: active ?? state.activeClaude,
          claudeWriting: active ? active.length > 0 : live?.writing ?? state.claudeWriting,
          claudeSession:
            sessionFromEvents(focus) ??
            sessionFromEvents(claude) ??
            sessionFromLive(live, "sonnet") ??
            state.claudeSession,
          lastBeat: Date.now(),
        });
        return incoming.length;
      },
      ingestGrokLogs: (incoming, opts) => {
        const state = get();
        if (!opts?.replace && incoming.length === 0) {
          set(idleIngestPatch(state, "grok", opts));
          return 0;
        }
        const others = state.realEvents.filter((e) => e.agent !== "grok");
        let grok: UsageEvent[];
        if (opts?.replace) {
          grok = incoming;
        } else {
          const map = new Map(
            state.realEvents.filter((e) => e.agent === "grok").map((e) => [e.id, e] as const),
          );
          for (const ev of incoming) map.set(ev.id, ev);
          grok = [...map.values()];
        }
        const merged = [...others, ...grok].sort((a, b) => a.ts - b.ts);
        const trimmed = trimEventState(merged, state.calibrationTruncatedBeforeMs);
        upsertCalibrationIndex(state.calibrationEventIndex, incoming);
        pruneCalibrationIndex(state.calibrationEventIndex, Date.now());
        const calibrationEvents = sortedCalibration(state.calibrationEventIndex);
        const cursor = grok.reduce((m, e) => Math.max(m, e.ts), state.grokCursor);
        const live = opts?.live;
        const active = opts?.active;
        const focus = eventsForLive(grok, live);
        set({
          realEvents: trimmed.realEvents,
          events: state.demoMode ? state.events : trimmed.displayEvents,
          calibrationTruncatedBeforeMs: trimmed.truncatedBeforeMs,
          calibrationEvents,
          grokCursor: cursor,
          grokHydrated: state.grokHydrated || incoming.length > 0,
          activeGrok: active ?? state.activeGrok,
          grokWriting: active ? active.length > 0 : live?.writing ?? state.grokWriting,
          grokSession:
            sessionFromEvents(focus) ??
            sessionFromEvents(grok) ??
            sessionFromLive(live, "grok-4.6") ??
            state.grokSession,
          lastBeat: Date.now(),
        });
        return incoming.length;
      },
      ingestCodexLogs: (incoming, opts) => {
        const state = get();
        if (!opts?.replace && incoming.length === 0) {
          set(idleIngestPatch(state, "codex", opts));
          return 0;
        }
        const others = state.realEvents.filter((e) => e.agent !== "codex");
        let codex: UsageEvent[];
        if (opts?.replace) {
          codex = incoming;
        } else {
          const map = new Map(
            state.realEvents.filter((e) => e.agent === "codex").map((e) => [e.id, e] as const),
          );
          for (const ev of incoming) map.set(ev.id, ev);
          codex = [...map.values()];
        }
        const merged = [...others, ...codex].sort((a, b) => a.ts - b.ts);
        const trimmed = trimEventState(merged, state.calibrationTruncatedBeforeMs);
        upsertCalibrationIndex(state.calibrationEventIndex, incoming);
        pruneCalibrationIndex(state.calibrationEventIndex, Date.now());
        const calibrationEvents = sortedCalibration(state.calibrationEventIndex);
        const cursor = codex.reduce((m, e) => Math.max(m, e.ts), state.codexCursor);
        const live = opts?.live;
        const active = opts?.active;
        const focus = eventsForLive(codex, live);
        set({
          realEvents: trimmed.realEvents,
          events: state.demoMode ? state.events : trimmed.displayEvents,
          calibrationTruncatedBeforeMs: trimmed.truncatedBeforeMs,
          calibrationEvents,
          codexCursor: cursor,
          codexHydrated: state.codexHydrated || incoming.length > 0,
          activeCodex: active ?? state.activeCodex,
          codexWriting: active ? active.length > 0 : live?.writing ?? state.codexWriting,
          codexSession:
            sessionFromEvents(focus) ??
            sessionFromEvents(codex) ??
            sessionFromLive(live, "gpt-5.6-sol") ??
            state.codexSession,
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
        const quotaEvents = state.demoMode ? state.realEvents : state.calibrationEvents;
        set({
          quotaSamples: samplesFromOfficial(quotaEvents, state.official, now, state.quotaSamples ?? []),
        });
      },
      recordOfficialHistory: (history) => {
        if (!history.length) return;
        const state = get();
        const quotaEvents = state.demoMode ? state.realEvents : state.calibrationEvents;
        set({
          quotaSamples: samplesFromOfficialHistory(
            quotaEvents,
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
        const state = get();
        const merged = [
          ...parsed,
          ...state.realEvents.filter((event) => event.agent !== "claude"),
        ].sort((a, b) => a.ts - b.ts);
        const trimmed = trimEventState(merged, state.calibrationTruncatedBeforeMs);
        upsertCalibrationIndex(state.calibrationEventIndex, parsed);
        pruneCalibrationIndex(state.calibrationEventIndex, Date.now());
        const calibrationEvents = sortedCalibration(state.calibrationEventIndex);
        set({
          realEvents: trimmed.realEvents,
          events: state.demoMode ? state.events : trimmed.displayEvents,
          calibrationTruncatedBeforeMs: trimmed.truncatedBeforeMs,
          calibrationEvents,
          claudeCursor: 0,
          claudeHydrated: false,
          claudeSession: state.demoMode ? state.claudeSession : sessionFromEvents(parsed),
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
          activeClaude: [],
          activeGrok: [],
          activeCodex: [],
        });
      },
      setHint: (on) => set({ adapterHint: on }),
      ingestQuotaCache: (incoming, opts) => {
        const state = get();
        upsertCalibrationIndex(state.calibrationEventIndex, incoming);
        if (!opts.publish) return;
        pruneCalibrationIndex(state.calibrationEventIndex, Date.now());
        set({
          calibrationEvents: sortedCalibration(state.calibrationEventIndex),
          quotaCacheHydrated: opts.complete,
        });
      },
      resetQuotaCacheHydration: () => {
        const state = get();
        for (const [identity, event] of state.calibrationEventIndex) {
          if (isCacheHydratedEvent(event)) state.calibrationEventIndex.delete(identity);
        }
        set({
          calibrationEvents: sortedCalibration(state.calibrationEventIndex),
          quotaCacheHydrated: false,
          cacheHistoryTruncated: false,
          cacheTruncatedBeforeMs: null,
        });
      },
    }),
    {
      name: "balance-quota-v8",
      storage: createJSONStorage(() => {
        const memory = new Map<string, string>();
        const legacyNames = ["synq-quota-v8", "synq-quota-v7"];
        return {
          getItem: (name) => {
            try {
              if (typeof localStorage === "undefined") return memory.get(name) ?? null;
              const current = localStorage.getItem(name);
              if (current != null) {
                for (const legacy of legacyNames) {
                  try {
                    localStorage.removeItem(legacy);
                  } catch {
                    /* ignore */
                  }
                }
                return current;
              }
              for (const legacy of legacyNames) {
                let value: string | null = null;
                try {
                  value = localStorage.getItem(legacy);
                } catch {
                  continue;
                }
                if (value == null) continue;
                try {
                  localStorage.setItem(name, value);
                } catch {
                  /* quota — keep serving the migrated payload from memory */
                }
                for (const oldName of legacyNames) {
                  try {
                    localStorage.removeItem(oldName);
                  } catch {
                    /* ignore */
                  }
                }
                return value;
              }
              return null;
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
        agentAvailability: s.agentAvailability,
        captureEnabled: s.captureEnabled,
        onboardingComplete: s.onboardingComplete,
        adapterHint: s.adapterHint,
        alertWindowPct: s.alertWindowPct,
        alertWeekPct: s.alertWeekPct,
        alerts: s.alerts.slice(0, MAX_ALERTS),
        quotaSamples: s.quotaSamples,
      }),
    },
  ),
);
