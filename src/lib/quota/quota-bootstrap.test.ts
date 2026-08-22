import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hydrateQuotaCache,
  startQuotaPolling,
  type QuotaHydrationDeps,
} from "./quota-bootstrap.ts";
import type { CachedQuotaEvent } from "./quota-cache.ts";
import type { QuotaBootstrapPage } from "./quota-cache.ts";

function makeCachedEvent(n: number, agent: "claude" | "codex" | "grok" = "claude"): CachedQuotaEvent {
  return {
    idHash: `${"a".repeat(62)}${String(n).padStart(2, "0")}`,
    agent,
    model: "sonnet",
    ts: 1_000_000 + n * 1_000,
    tokensIn: 100 + n,
    tokensOut: 50 + n,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

describe("hydrateQuotaCache", () => {
  test("hydrates quota cache before polling", async () => {
    // Scenario: two pages, first publish on page 0 and page 1 (complete).
    // Verifies hydration returns savedAt, and ingest is called with correct opts.
    const page0Events = Array.from({ length: 3 }, (_, i) => makeCachedEvent(i));
    const page1Events = Array.from({ length: 2 }, (_, i) => makeCachedEvent(i + 3));

    const pages: QuotaBootstrapPage[] = [
      {
        events: page0Events,
        nextOffset: 3,
        savedAt: 5000,
        historyTruncated: false,
        truncatedBeforeMs: null,
        snapshotKey: "b".repeat(64),
        restart: false,
      },
      {
        events: page1Events,
        nextOffset: null,
        savedAt: 5000,
        historyTruncated: true,
        truncatedBeforeMs: 999,
        snapshotKey: "b".repeat(64),
        restart: false,
      },
    ];

    let pullIndex = 0;
    const ingestCalls: { count: number; publish: boolean; complete: boolean }[] = [];
    const boundaryUpdates: { historyTruncated: boolean; truncatedBeforeMs: number | null }[] = [];
    let resetCount = 0;
    let yieldCount = 0;

    const deps: QuotaHydrationDeps = {
      pull: async (input) => {
        const page = pages[pullIndex]!;
        pullIndex++;
        return page;
      },
      hydrate: (event) => ({
        id: `quota-cache:${event.idHash}`,
        cacheIdentity: event.idHash,
        agent: event.agent,
        model: "sonnet" as any,
        ts: event.ts,
        sessionId: "quota-cache",
        task: "test",
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        cacheRead: event.cacheRead,
        cacheWrite: event.cacheWrite,
        reasoningMin: 0,
      }),
      ingest: (events, opts) => {
        ingestCalls.push({ count: events.length, ...opts });
      },
      reset: () => { resetCount++; },
      setBoundary: (historyTruncated, truncatedBeforeMs) => {
        boundaryUpdates.push({ historyTruncated, truncatedBeforeMs });
      },
      yieldToBrowser: async () => { yieldCount++; },
    };

    const savedAt = await hydrateQuotaCache(deps);
    assert.equal(savedAt, 5000, "should return savedAt from pages");
    assert.equal(pullIndex, 2, "should pull two pages");
    assert.equal(ingestCalls.length, 2, "should ingest twice");
    // First page: publish=true, complete=false
    assert.deepEqual(ingestCalls[0], { count: 3, publish: true, complete: false });
    // Last page: publish=true, complete=true
    assert.deepEqual(ingestCalls[1], { count: 2, publish: true, complete: true });
    // Boundary set on each page
    assert.equal(boundaryUpdates.length, 2);
    assert.deepEqual(boundaryUpdates[1], { historyTruncated: true, truncatedBeforeMs: 999 });
    assert.equal(resetCount, 0, "should not have reset");
    assert.equal(yieldCount, 1, "should yield between pages");

    // Now verify polling: scanner starts only after hydration returns.
    let pollStarted = false;
    let seedCalled = false;
    let seedSince = -1;

    const stop = startQuotaPolling({
      initialSince: savedAt!,
      seedCursors: (since) => { seedCalled = true; seedSince = since; },
      pullLogs: async () => { pollStarted = true; },
      setInterval: (cb, ms) => 42 as any,
      clearInterval: () => {},
    });

    assert.ok(seedCalled, "seedCursors should be called");
    assert.equal(seedSince, 5000, "seedCursors should use savedAt");
    // Allow microtask for initial tick
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(pollStarted, "polling should have started its first tick");
    stop();
  });

  test("restarts unstable hydration", async () => {
    // Scenario: on page 1, server indicates restart because snapshot changed.
    // After restart, hydration proceeds from offset 0 with the new snapshot.
    // Third restart beyond limit throws.
    let pullCount = 0;
    const event0 = makeCachedEvent(0);
    const event1 = makeCachedEvent(1);

    const deps: QuotaHydrationDeps = {
      pull: async (input) => {
        pullCount++;
        // First pull: page 0, no restart
        if (pullCount === 1) {
          return {
            events: [event0],
            nextOffset: 1,
            savedAt: 1000,
            historyTruncated: false,
            truncatedBeforeMs: null,
            snapshotKey: "a".repeat(64),
            restart: false,
          };
        }
        // Second pull: restart signal (snapshot changed)
        if (pullCount === 2) {
          return {
            events: [],
            nextOffset: null,
            savedAt: 2000,
            historyTruncated: false,
            truncatedBeforeMs: null,
            snapshotKey: "c".repeat(64),
            restart: true,
          };
        }
        // After restart: page 0 with new snapshot
        if (pullCount === 3) {
          return {
            events: [event1],
            nextOffset: null,
            savedAt: 2000,
            historyTruncated: false,
            truncatedBeforeMs: null,
            snapshotKey: "c".repeat(64),
            restart: false,
          };
        }
        throw new Error("unexpected pull");
      },
      hydrate: (event) => ({
        id: `quota-cache:${event.idHash}`,
        cacheIdentity: event.idHash,
        agent: event.agent,
        model: "sonnet" as any,
        ts: event.ts,
        sessionId: "quota-cache",
        task: "test",
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        cacheRead: event.cacheRead,
        cacheWrite: event.cacheWrite,
        reasoningMin: 0,
      }),
      ingest: () => {},
      reset: () => {},
      setBoundary: () => {},
      yieldToBrowser: async () => {},
    };

    const savedAt = await hydrateQuotaCache(deps);
    assert.equal(savedAt, 2000, "should use savedAt from new snapshot");
    assert.equal(pullCount, 3, "should have pulled 3 times (original + restart + final)");

    // Now test that > 3 restarts throws
    let restartPullCount = 0;
    const tooManyRestartDeps: QuotaHydrationDeps = {
      pull: async () => {
        restartPullCount++;
        return {
          events: [],
          nextOffset: null,
          savedAt: restartPullCount * 1000,
          historyTruncated: false,
          truncatedBeforeMs: null,
          snapshotKey: `${"d".repeat(62)}${String(restartPullCount).padStart(2, "0")}`,
          restart: true,
        };
      },
      hydrate: (event) => ({} as any),
      ingest: () => {},
      reset: () => {},
      setBoundary: () => {},
      yieldToBrowser: async () => {},
    };

    await assert.rejects(
      () => hydrateQuotaCache(tooManyRestartDeps),
      { message: "quota cache changed repeatedly during hydration" },
    );
    // restart count should be 4 (the 4th triggers the throw)
    assert.equal(restartPullCount, 4, "should stop after 4 restart attempts");
  });
});
