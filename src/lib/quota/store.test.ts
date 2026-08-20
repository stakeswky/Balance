import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { OfficialSlice } from "./official.ts";
import { useQuota } from "./store.ts";
import type { AgentId, UsageEvent } from "./types.ts";

const initialState = useQuota.getState();
const initialEvents = [...initialState.events];
const initialRealEvents = [...initialState.realEvents];
const initialLive = [initialState.liveClaude, initialState.liveGrok, initialState.liveCodex];

function event(agent: AgentId, id: string, ts = 1): UsageEvent {
  return {
    id,
    agent,
    model: agent === "claude" ? "sonnet" : agent === "grok" ? "grok-4.6" : "gpt-5.6-sol",
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
    timestamp: 2,
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
