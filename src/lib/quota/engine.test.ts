import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSessions } from "./engine.ts";
import { timelineSessions } from "./timeline-sessions.ts";
import { WINDOW_MS, eventsForActivity, type UsageEvent } from "./types.ts";

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
