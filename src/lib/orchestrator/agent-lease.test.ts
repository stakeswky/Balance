import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { createAgentLeaseManager } from "./agent-lease.server.ts";

test("serializes the same Agent across runs in FIFO order", async () => {
  const manager = createAgentLeaseManager({ globalMaxConcurrency: 3, now: () => 100 });
  const first = await manager.acquire({
    agent: "codex", runId: "run-one", taskId: "task-one", role: "execution",
    signal: new AbortController().signal,
  });
  const order: string[] = [];
  const secondPromise = manager.acquire({
    agent: "codex", runId: "run-two", taskId: "task-two", role: "execution",
    signal: new AbortController().signal,
  }).then((lease) => { order.push("second"); return lease; });
  const thirdPromise = manager.acquire({
    agent: "codex", runId: "run-three", taskId: "task-three", role: "repair",
    signal: new AbortController().signal,
  }).then((lease) => { order.push("third"); return lease; });
  await nextTurn();
  assert.deepEqual(manager.snapshot(), { active: 1, waiting: 2 });

  await first.release();
  const second = await secondPromise;
  assert.deepEqual(order, ["second"]);
  assert.equal(second.runId, "run-two");
  await second.release();
  const third = await thirdPromise;
  assert.deepEqual(order, ["second", "third"]);
  await third.release();
  assert.deepEqual(manager.snapshot(), { active: 0, waiting: 0 });
});

test("combines global concurrency with one active lease per Agent", async () => {
  const manager = createAgentLeaseManager({ globalMaxConcurrency: 2 });
  const codex = await manager.acquire({
    agent: "codex", runId: "run-one", taskId: "task-one", role: "planning",
    signal: new AbortController().signal,
  });
  const claude = await manager.acquire({
    agent: "claude", runId: "run-two", taskId: "task-two", role: "execution",
    signal: new AbortController().signal,
  });
  let grokAcquired = false;
  const grokPromise = manager.acquire({
    agent: "grok", runId: "run-three", taskId: "task-three", role: "execution",
    signal: new AbortController().signal,
  }).then((lease) => { grokAcquired = true; return lease; });
  await nextTurn();
  assert.equal(grokAcquired, false);
  await codex.release();
  const grok = await grokPromise;
  assert.equal(grokAcquired, true);
  await Promise.all([claude.release(), grok.release()]);
});

test("removes an aborted waiter and never grants it later", async () => {
  const manager = createAgentLeaseManager({ globalMaxConcurrency: 1 });
  const active = await manager.acquire({
    agent: "codex", runId: "run-one", taskId: "task-one", role: "execution",
    signal: new AbortController().signal,
  });
  const waitingController = new AbortController();
  const waiting = manager.acquire({
    agent: "codex", runId: "run-two", taskId: "task-two", role: "execution",
    signal: waitingController.signal,
  });
  waitingController.abort();
  await assert.rejects(waiting, /cancelled|aborted/i);
  assert.deepEqual(manager.snapshot(), { active: 1, waiting: 0 });
  await active.release();
  assert.deepEqual(manager.snapshot(), { active: 0, waiting: 0 });
});

test("shutdown rejects waiters, clears active leases and makes release idempotent", async () => {
  const manager = createAgentLeaseManager({ globalMaxConcurrency: 1 });
  const active = await manager.acquire({
    agent: "codex", runId: "run-one", taskId: "task-one", role: "execution",
    signal: new AbortController().signal,
  });
  const waiting = manager.acquire({
    agent: "claude", runId: "run-two", taskId: "task-two", role: "planning",
    signal: new AbortController().signal,
  });
  await manager.shutdown();
  await assert.rejects(waiting, /shutting down/i);
  assert.deepEqual(manager.snapshot(), { active: 0, waiting: 0 });
  await active.release();
  await active.release();
  await assert.rejects(
    manager.acquire({
      agent: "grok", runId: "run-three", taskId: "task-three", role: "repair",
      signal: new AbortController().signal,
    }),
    /shutting down/i,
  );
});
