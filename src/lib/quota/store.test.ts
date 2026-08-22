import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { OfficialSlice } from "./official.ts";
import { quotaEventIdentity } from "./quota-cache.ts";
import { calibrationDataFrom, migrateQuotaPersist, useQuota } from "./store.ts";
import type { AgentId, UsageEvent } from "./types.ts";
import { CALIBRATION_RETENTION_MS } from "./types.ts";

const initialState = useQuota.getState();
const initialEvents = [...initialState.events];
const initialRealEvents = [...initialState.realEvents];
const initialLive = [initialState.liveClaude, initialState.liveGrok, initialState.liveCodex];

const RECENT_TS = Date.now() - 60_000;

function event(agent: AgentId, id: string, ts = RECENT_TS): UsageEvent {
  return {
    id,
    agent,
    model: agent === "claude" ? "sonnet" : agent === "grok" ? "grok-4.6" : "gpt-5.6-sol",
    modelRaw: agent === "claude" ? "claude-sonnet-5" : agent === "grok" ? "grok-4.6" : "gpt-5.6-sol",
    ts,
    sessionId: `session-${id}`,
    task: `task-${id}`,
    tokensIn: 1_000,
    tokensOut: 100,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
  };
}

function officialClaude(now: number): OfficialSlice {
  return {
    agent: "claude",
    windowPct: 10,
    weekPct: null,
    windowResetsAt: now + 60_000,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: 5 * 60 * 60 * 1_000,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "test",
    fetchedAt: now,
    windowKind: "five_hour",
  };
}

let snapshot: ReturnType<typeof useQuota.getState>;

beforeEach(() => {
  snapshot = useQuota.getState();
  const real = event("claude", "real-claude");
  useQuota.setState({
    events: [real],
    realEvents: [real],
    agentAvailability: { claude: true, grok: false, codex: true },
    captureEnabled: { claude: true, grok: true, codex: false },
    demoMode: false,
    liveClaude: true,
    liveGrok: false,
    liveCodex: false,
    calibrationEventIndex: new Map(),
    calibrationEvents: [],
    quotaCacheHydrated: false,
    cacheHistoryTruncated: false,
    cacheTruncatedBeforeMs: null,
    quotaSamples: [{
      windowId: "sample-window",
      agent: "claude",
      product: null,
      timestampMs: 1,
      usedPercent: 10,
      cumulativeObservedUsd: 1,
      pricedTokenCoverage: 1,
      modelMix: {},
      pricingVersion: "test",
    }],
  });
});

afterEach(() => {
  useQuota.setState(snapshot, true);
});

test("the real store starts empty with every collector stopped", () => {
  assert.deepEqual(initialEvents, []);
  assert.deepEqual(initialRealEvents, []);
  assert.deepEqual(initialLive, [false, false, false]);
});

test("minimal mode defaults on, geek toggle persists, and v0 storage migrates to simple", () => {
  const eventsBefore = useQuota.getState().events;
  assert.equal(initialState.minimalMode, true);

  useQuota.getState().setMinimalMode(false);

  const state = useQuota.getState();
  assert.equal(state.minimalMode, false);
  assert.equal(state.events, eventsBefore);
  const partialize = useQuota.persist.getOptions().partialize;
  assert.ok(partialize);
  const persisted = partialize(state) as Partial<typeof state>;
  assert.equal(persisted.minimalMode, false);
  assert.equal(useQuota.persist.getOptions().version, 1);

  const fromV0False = migrateQuotaPersist({ minimalMode: false, demoMode: true }, 0);
  assert.equal(fromV0False.minimalMode, true);
  assert.equal(fromV0False.demoMode, true);
  const fromV0Missing = migrateQuotaPersist({ demoMode: true }, 0);
  assert.equal(fromV0Missing.minimalMode, true);
  const fromV1Geek = migrateQuotaPersist({ minimalMode: false }, 1);
  assert.equal(fromV1Geek.minimalMode, false);
});

test("demo can be enabled and disabled without losing real events or calibration samples", () => {
  useQuota.getState().setDemoMode(true);
  assert.equal(useQuota.getState().demoMode, true);
  assert.deepEqual(new Set(useQuota.getState().events.map((item) => item.agent)), new Set(["claude", "grok", "codex"]));

  useQuota.getState().setDemoMode(false);
  const state = useQuota.getState();
  assert.equal(state.demoMode, false);
  assert.deepEqual(state.events, state.realEvents);
  assert.equal(state.events[0]?.id, "real-claude");
  assert.equal(state.liveClaude, true);
  assert.equal(state.liveGrok, false);
  assert.equal(state.liveCodex, false);
  assert.equal(state.quotaSamples.length, 1);
});

test("availability disables missing real collectors but demo keeps all streams", () => {
  useQuota.getState().setAgentAvailability({ claude: false, grok: true, codex: false });
  assert.equal(useQuota.getState().liveClaude, false);
  assert.equal(useQuota.getState().liveGrok, true);
  assert.equal(useQuota.getState().liveCodex, false);

  useQuota.getState().setDemoMode(true);
  assert.equal(useQuota.getState().liveClaude, true);
  assert.equal(useQuota.getState().liveGrok, true);
  assert.equal(useQuota.getState().liveCodex, true);
});

test("all real log ingestors update realEvents without replacing demo events", () => {
  useQuota.getState().setDemoMode(true);
  const demoIds = useQuota.getState().events.map((item) => item.id);

  useQuota.getState().ingestClaudeLogs([event("claude", "scan-claude")], { replace: true });
  useQuota.getState().ingestGrokLogs([event("grok", "scan-grok")], { replace: true });
  useQuota.getState().ingestCodexLogs([event("codex", "scan-codex")], { replace: true });

  const state = useQuota.getState();
  assert.deepEqual(state.events.map((item) => item.id), demoIds);
  assert.deepEqual(
    state.realEvents.map((item) => item.id).sort(),
    ["scan-claude", "scan-codex", "scan-grok"],
  );
});

test("manual import and bundled import update realEvents without leaving demo mode", () => {
  useQuota.getState().setDemoMode(true);
  const demoIds = useQuota.getState().events.map((item) => item.id);
  const count = useQuota.getState().importText(JSON.stringify({
    id: "manual-grok",
    agent: "grok",
    model: "grok-4.6",
    timestamp: RECENT_TS,
    session_id: "manual",
    usage: { input_tokens: 10, output_tokens: 2 },
  }), "grok");
  assert.equal(count, 1);
  assert.ok(useQuota.getState().realEvents.some((item) => item.id === "manual-grok"));
  assert.deepEqual(useQuota.getState().events.map((item) => item.id), demoIds);

  assert.ok(useQuota.getState().loadImported() > 0);
  assert.equal(useQuota.getState().demoMode, true);
  assert.ok(useQuota.getState().realEvents.some((item) => item.agent === "claude"));
  assert.deepEqual(useQuota.getState().events.map((item) => item.id), demoIds);
});

test("real-mode ingestors keep the display synchronized with realEvents", () => {
  useQuota.getState().ingestGrokLogs([event("grok", "real-grok")], { replace: true });
  assert.deepEqual(useQuota.getState().events, useQuota.getState().realEvents);
  assert.ok(useQuota.getState().events.some((item) => item.id === "real-grok"));
});

test("live toggles update capture preferences in real mode without exiting demo", () => {
  useQuota.getState().toggleLive("claude");
  assert.equal(useQuota.getState().liveClaude, false);
  assert.equal(useQuota.getState().captureEnabled.claude, false);

  useQuota.getState().setDemoMode(true);
  useQuota.getState().toggleLive("grok");
  assert.equal(useQuota.getState().demoMode, true);
  assert.equal(useQuota.getState().liveGrok, false);
  assert.equal(useQuota.getState().captureEnabled.grok, true);
});

test("setBothLive respects availability in real mode and controls every demo stream", () => {
  useQuota.getState().setBothLive(true);
  assert.equal(useQuota.getState().liveClaude, true);
  assert.equal(useQuota.getState().liveGrok, false);
  assert.equal(useQuota.getState().liveCodex, true);
  assert.deepEqual(useQuota.getState().captureEnabled, { claude: true, grok: true, codex: true });

  useQuota.getState().setDemoMode(true);
  useQuota.getState().setBothLive(false);
  assert.equal(useQuota.getState().demoMode, true);
  assert.equal(useQuota.getState().liveClaude, false);
  assert.equal(useQuota.getState().liveGrok, false);
  assert.equal(useQuota.getState().liveCodex, false);
});

test("official samples are calibrated from realEvents instead of demo events", () => {
  const now = Date.now();
  const real = event("claude", "sample-real", now - 1_000);
  const synthetic = {
    ...event("claude", "sample-demo", now - 1_000),
    tokensIn: 10_000_000,
    tokensOut: 1_000_000,
  };
  useQuota.setState({
    realEvents: [real],
    events: [synthetic],
    official: { claude: officialClaude(now), grok: null, codex: null },
    quotaSamples: [],
    demoMode: true,
  });
  useQuota.getState().recordOfficialSamples(now);
  const sample = useQuota.getState().quotaSamples[0];
  assert.ok(sample);
  assert.ok(sample.cumulativeObservedUsd > 0);
  assert.ok(sample.cumulativeObservedUsd < 0.02);
});

test("same-tick Claude total and Fable alerts receive distinct ids", () => {
  useQuota.setState({ alerts: [] });
  useQuota.getState().pushAlert({
    ts: 1_000,
    agent: "claude",
    kind: "week",
    message: "Claude Code 本周额度已用 90%",
  });
  useQuota.getState().pushAlert({
    ts: 1_000,
    agent: "claude",
    kind: "week",
    message: "Claude Code Fable 5 周额度已用 90%",
  });

  assert.equal(useQuota.getState().alerts.length, 2);
  assert.equal(new Set(useQuota.getState().alerts.map((alert) => alert.id)).size, 2);
});

test("real ingestors keep all active parallel tasks and focus the latest actor", () => {
  const parent = "parent-session";
  const childA = { ...event("claude", "child-a", 10), sessionId: parent, actorId: "agent-a", task: "任务 A" };
  const childB = { ...event("claude", "child-b", 20), sessionId: parent, actorId: "agent-b", task: "任务 B" };
  const active = [
    {
      sessionId: parent,
      actorId: "agent-b",
      actorKind: "subagent" as const,
      cwd: "/tmp",
      task: "任务 B",
      writing: true,
      lastTs: 20,
      startedAt: 20,
      turns: 1,
    },
    {
      sessionId: parent,
      actorId: "agent-a",
      actorKind: "subagent" as const,
      cwd: "/tmp",
      task: "任务 A",
      writing: true,
      lastTs: 10,
      startedAt: 10,
      turns: 1,
    },
  ];
  useQuota.getState().ingestClaudeLogs([childA, childB], { replace: true, live: active[0], active });
  const state = useQuota.getState();
  assert.equal(state.activeClaude.length, 2);
  assert.equal(state.claudeWriting, true);
  assert.equal(state.claudeSession?.id, "agent-b");
  assert.equal(state.claudeSession?.task, "任务 B");

  useQuota.getState().ingestGrokLogs([event("grok", "grok-a", 30)], { active: [] });
  useQuota.getState().ingestCodexLogs([event("codex", "codex-a", 40)], { active: [] });
  assert.deepEqual(useQuota.getState().activeGrok, []);
  assert.deepEqual(useQuota.getState().activeCodex, []);
});

test("Claude exposes a live child even before that child's first usage event", () => {
  useQuota.setState({ events: [], realEvents: [], activeClaude: [], claudeSession: null });
  const live = {
    sessionId: "parent-session",
    actorId: "agent-new",
    actorKind: "subagent" as const,
    cwd: "/tmp",
    task: "刚启动的子任务",
    writing: true,
    lastTs: 50,
    startedAt: 50,
    turns: 0,
  };
  useQuota.getState().ingestClaudeLogs([], { replace: true, live, active: [live] });
  assert.equal(useQuota.getState().claudeSession?.id, "agent-new");
  assert.equal(useQuota.getState().claudeSession?.task, "刚启动的子任务");
  assert.equal(useQuota.getState().claudeWriting, true);
});

test("empty incremental ingest preserves event references", () => {
  // Seed some events so arrays are non-empty
  useQuota.getState().ingestClaudeLogs([event("claude", "ref-test-c", 100)], { replace: true });
  useQuota.getState().ingestGrokLogs([event("grok", "ref-test-g", 200)], { replace: true });
  useQuota.getState().ingestCodexLogs([event("codex", "ref-test-x", 300)], { replace: true });

  const state = useQuota.getState();
  const realEvents = state.realEvents;
  const events = state.events;

  // Empty incremental ingest (replace:false is the default) should not rebuild arrays
  assert.equal(state.ingestClaudeLogs([], { active: [] }), 0);
  const afterClaude = useQuota.getState();
  assert.strictEqual(afterClaude.realEvents, realEvents);
  assert.strictEqual(afterClaude.events, events);
  // live metadata must still update
  assert.deepEqual(afterClaude.activeClaude, []);
  assert.ok(afterClaude.lastBeat > 0);

  assert.equal(afterClaude.ingestGrokLogs([], { active: [] }), 0);
  const afterGrok = useQuota.getState();
  assert.strictEqual(afterGrok.realEvents, realEvents);
  assert.strictEqual(afterGrok.events, events);

  assert.equal(afterGrok.ingestCodexLogs([], { active: [] }), 0);
  const afterCodex = useQuota.getState();
  assert.strictEqual(afterCodex.realEvents, realEvents);
  assert.strictEqual(afterCodex.events, events);
});

test("empty incremental ingest preserves event-derived session (no live downgrade)", () => {
  // First ingest builds an event-derived claudeSession
  const ev = event("claude", "session-derive-c", 500);
  useQuota.getState().ingestClaudeLogs([ev], { replace: true });
  const derivedSession = useQuota.getState().claudeSession;
  assert.ok(derivedSession, "should have event-derived session");

  // Now empty incremental ingest with a different live stub
  const stubLive = {
    sessionId: "other-session",
    actorId: "stub-actor",
    actorKind: "subagent" as const,
    cwd: "/tmp",
    task: "stub task",
    writing: false,
    lastTs: 600,
    startedAt: 600,
    turns: 0,
  };
  useQuota.getState().ingestClaudeLogs([], { live: stubLive });
  const after = useQuota.getState();
  // The event-derived session must not be downgraded to the live stub
  assert.strictEqual(after.claudeSession, derivedSession);
});

test("calibration retention keeps 20001 real events and trims display to 20000", () => {
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const events: UsageEvent[] = [];
  for (let i = 0; i < 20_001; i++) {
    events.push(event("claude", `ev-${i}`, now - WEEK_MS + i * 1000));
  }
  useQuota.getState().ingestClaudeLogs(events, { replace: true });
  const state = useQuota.getState();
  // realEvents must keep all 20001 for calibration
  assert.equal(state.realEvents.length, 20_001);
  // display events must be capped at 20k
  assert.equal(state.events.length, 20_000);
  // cumulative USD should not regress — ensure sorted ascending
  for (let i = 1; i < state.realEvents.length; i++) {
    assert.ok(state.realEvents[i]!.ts >= state.realEvents[i - 1]!.ts);
  }
});

test("publishes first and final cache pages", () => {
  const now = Date.now();
  const cacheEvent1: UsageEvent = {
    ...event("claude", "quota-cache:c1", now - 60_000),
    cacheIdentity: "hash-c1",
  };
  const cacheEvent2: UsageEvent = {
    ...event("claude", "quota-cache:c2", now - 30_000),
    cacheIdentity: "hash-c2",
  };
  const cacheEvent3: UsageEvent = {
    ...event("grok", "quota-cache:g1", now - 20_000),
    cacheIdentity: "hash-g1",
  };

  // Intermediate page (publish:false) — must not update calibrationEvents
  useQuota.getState().ingestQuotaCache([cacheEvent1], { publish: false, complete: false });
  assert.deepEqual(useQuota.getState().calibrationEvents, []);
  assert.equal(useQuota.getState().quotaCacheHydrated, false);

  // First published page (publish:true, complete:false) — publishes sorted calibrationEvents
  useQuota.getState().ingestQuotaCache([cacheEvent2], { publish: true, complete: false });
  const afterFirst = useQuota.getState();
  assert.equal(afterFirst.calibrationEvents.length, 2);
  assert.ok(afterFirst.calibrationEvents[0]!.ts <= afterFirst.calibrationEvents[1]!.ts);
  assert.equal(afterFirst.quotaCacheHydrated, false);

  // Final page (publish:true, complete:true) — marks hydration complete
  useQuota.getState().ingestQuotaCache([cacheEvent3], { publish: true, complete: true });
  const afterFinal = useQuota.getState();
  assert.equal(afterFinal.calibrationEvents.length, 3);
  assert.equal(afterFinal.quotaCacheHydrated, true);
  // Must be sorted by ts
  for (let i = 1; i < afterFinal.calibrationEvents.length; i++) {
    assert.ok(afterFinal.calibrationEvents[i]!.ts >= afterFinal.calibrationEvents[i - 1]!.ts);
  }
});

test("real event replaces cached hash", () => {
  const now = Date.now();
  const cacheEv: UsageEvent = {
    ...event("claude", "quota-cache:abc123", now - 60_000),
    cacheIdentity: "sha256-identity-1",
  };
  // Ingest cache event first
  useQuota.getState().ingestQuotaCache([cacheEv], { publish: true, complete: true });
  assert.equal(useQuota.getState().calibrationEvents.length, 1);
  assert.ok(useQuota.getState().calibrationEvents[0]!.id.startsWith("quota-cache:"));

  // Now ingest a real event with the same cacheIdentity (same sha256 hash from server)
  const realEv: UsageEvent = {
    ...event("claude", "real-log-abc123", now - 60_000),
    cacheIdentity: "sha256-identity-1",
  };
  useQuota.getState().ingestClaudeLogs([realEv], { replace: true });

  // The real event must have replaced the cached one
  const state = useQuota.getState();
  assert.equal(state.calibrationEvents.length, 1);
  assert.equal(state.calibrationEvents[0]!.id, "real-log-abc123");
  assert.ok(!state.calibrationEvents[0]!.id.startsWith("quota-cache:"));
});

test("cache truncation boundary", () => {
  const now = Date.now();
  // Both null → null
  assert.equal(calibrationDataFrom(null, null), null);

  // Only memory boundary → memory boundary
  assert.equal(calibrationDataFrom(now - 1000, null), now - 1000);

  // Only cache boundary → cache boundary
  assert.equal(calibrationDataFrom(null, now - 2000), now - 2000);

  // Both present → take the later (larger) value so neither source masks the other
  assert.equal(calibrationDataFrom(now - 1000, now - 2000), now - 1000);
  assert.equal(calibrationDataFrom(now - 3000, now - 500), now - 500);
});

test("prunes expired calibration events on publish", () => {
  const now = Date.now();
  const expired: UsageEvent = {
    ...event("claude", "quota-cache:old", now - CALIBRATION_RETENTION_MS - 1000),
    cacheIdentity: "hash-old",
  };
  const fresh: UsageEvent = {
    ...event("claude", "quota-cache:new", now - 60_000),
    cacheIdentity: "hash-new",
  };

  // Ingest both without publishing first
  useQuota.getState().ingestQuotaCache([expired, fresh], { publish: false, complete: false });

  // Now publish — the expired event must be pruned
  useQuota.getState().ingestQuotaCache([], { publish: true, complete: true });
  const state = useQuota.getState();
  assert.equal(state.calibrationEvents.length, 1);
  assert.equal(state.calibrationEvents[0]!.id, "quota-cache:new");

  // The index must also not contain the expired entry
  assert.equal(state.calibrationEventIndex.size, 1);
});
