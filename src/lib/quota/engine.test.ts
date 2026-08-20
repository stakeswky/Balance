import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSessions, meterDataSources, officialOnlyMeter } from "./engine.ts";
import type { OfficialSlice } from "./official.ts";
import { timelineSessions } from "./timeline-sessions.ts";
import { WINDOW_MS, eventsForActivity, type MeterSnapshot, type UsageEvent } from "./types.ts";

function ev(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "event",
    agent: "claude",
    model: "sonnet",
    ts: Date.now(),
    sessionId: "session",
    task: "任务",
    tokensIn: 100,
    tokensOut: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
    ...partial,
  };
}

function meter(partial: Partial<MeterSnapshot> = {}): MeterSnapshot {
  return {
    agent: "claude",
    windowPct: 100,
    weekPct: 73,
    windowTokens: 1_000,
    weekTokens: 8_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    windowBudget: 10_000,
    weekBudget: 100_000,
    windowResetsAt: 1,
    weekResetsAt: 2,
    burnPctPerHour: 10,
    etaMs: 0,
    apiUsdWindow: 0,
    apiUsdWeek: 0,
    status: "critical",
    ...partial,
  };
}

function official(partial: Partial<OfficialSlice> = {}): OfficialSlice {
  return {
    agent: "claude",
    windowPct: 24,
    weekPct: 34,
    windowResetsAt: null,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: null,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel: "Max",
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "oauth-usage",
    fetchedAt: 1,
    windowKind: "five_hour",
    ...partial,
  };
}

test("meter sources stay local and are excluded from official-only decisions without official data", () => {
  const sources = meterDataSources(null);

  assert.deepEqual(sources, { window: "local-estimate", week: "local-estimate" });
  assert.equal(officialOnlyMeter(meter(), sources), null);
});

test("official-only decisions zero the local field when just the week is official", () => {
  const sources = meterDataSources(official({ windowPct: null, weekPct: 34 }));
  const fresh = officialOnlyMeter(meter({ windowPct: 100, weekPct: 34 }), sources);

  assert.deepEqual(sources, { window: "local-estimate", week: "official" });
  assert.equal(fresh?.windowPct, 0);
  assert.equal(fresh?.weekPct, 34);
  assert.equal(fresh?.status, "ok");
});

test("stale official fields remain visible sources but are excluded from official-only decisions", () => {
  const sources = meterDataSources(official({ windowStale: true, weekStale: true }));

  assert.deepEqual(sources, { window: "official-stale", week: "official-stale" });
  assert.equal(officialOnlyMeter(meter({ windowPct: 24, weekPct: 34 }), sources), null);
});

test("groupSessions separates actors that share one billing session", () => {
  const now = Date.now();
  const events = [
    { ...ev({ ts: now - 2_000 }), id: "a", sessionId: "parent", actorId: "agent-a", task: "任务 A" },
    { ...ev({ ts: now - 1_000 }), id: "b", sessionId: "parent", actorId: "agent-b", task: "任务 B" },
  ];
  const groups = groupSessions(events, now, WINDOW_MS);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.id).sort(), ["agent-a", "agent-b"]);
});

test("eventsForActivity opens only the selected actor", () => {
  const events = [
    ev({ id: "a", sessionId: "parent", actorId: "agent-a" }),
    ev({ id: "b", sessionId: "parent", actorId: "agent-b" }),
    ev({ id: "root", sessionId: "parent" }),
  ];
  assert.deepEqual(eventsForActivity(events, "agent-b").map((event) => event.id), ["b"]);
  assert.deepEqual(eventsForActivity(events, "parent").map((event) => event.id), ["root"]);
});

test("timelineSessions draws separate blocks for actors sharing a parent session", () => {
  const now = Date.now();
  const blocks = timelineSessions(
    [
      ev({ id: "a", ts: now - 2_000, sessionId: "parent", actorId: "agent-a", task: "任务 A" }),
      ev({ id: "b", ts: now - 1_000, sessionId: "parent", actorId: "agent-b", task: "任务 B" }),
    ],
    "claude",
    now,
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.id).sort(), ["agent-a", "agent-b"]);
});
