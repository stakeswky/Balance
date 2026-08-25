import assert from "node:assert/strict";
import test from "node:test";
import type { AntigravityUsageScanResult } from "./antigravity-usage.ts";
import { pollAntigravityUsage } from "./antigravity-usage-poll.ts";

function snapshot(fetchedAt: number): AntigravityUsageScanResult {
  return {
    events: [],
    databasesRead: 1,
    filesSkipped: 0,
    truncated: false,
    fetchedAt,
    source: "antigravity-conversation-db",
  };
}

test("pollAntigravityUsage forwards since and throttles successful scans for 30 seconds", async () => {
  const requests: Array<{ data: { since: number } }> = [];
  const pull = async (request: { data: { since: number } }) => {
    requests.push(request);
    return snapshot(100);
  };
  const first = await pollAntigravityUsage({
    available: true,
    now: 100,
    since: 50,
    lastPulledAt: null,
    previous: null,
    pull,
  });
  const throttled = await pollAntigravityUsage({
    available: true,
    now: 30_099,
    since: 60,
    lastPulledAt: first.lastPulledAt,
    previous: first.snapshot,
    pull,
  });
  const refreshed = await pollAntigravityUsage({
    available: true,
    now: 30_100,
    since: 70,
    lastPulledAt: throttled.lastPulledAt,
    previous: throttled.snapshot,
    pull,
  });
  assert.deepEqual(requests, [{ data: { since: 50 } }, { data: { since: 70 } }]);
  assert.equal(refreshed.lastPulledAt, 30_100);
});

test("pollAntigravityUsage preserves the previous snapshot when unavailable or rejected", async () => {
  const previous = snapshot(20);
  let calls = 0;
  const unavailable = await pollAntigravityUsage({
    available: false,
    now: 100,
    since: 0,
    lastPulledAt: null,
    previous,
    pull: async () => {
      calls += 1;
      return snapshot(100);
    },
  });
  const rejected = await pollAntigravityUsage({
    available: true,
    now: 200,
    since: 0,
    lastPulledAt: null,
    previous,
    pull: async () => {
      calls += 1;
      throw new Error("locked");
    },
  });
  assert.equal(calls, 1);
  assert.equal(unavailable.snapshot, previous);
  assert.equal(rejected.snapshot, previous);
  assert.equal(rejected.lastPulledAt, 200);
});
