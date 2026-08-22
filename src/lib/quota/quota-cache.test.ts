import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  quotaCacheSnapshotSchema,
  quotaEventIdentity,
  hydrateCachedEvent,
  isSafeModelRaw,
  type CachedQuotaEvent,
} from "./quota-cache.ts";

import {
  eventIdHash,
  serverQuotaEventIdentity,
  cacheEvent,
} from "./quota-cache.server.ts";

import { costBreakdown } from "./cost.ts";
import type { UsageEvent } from "./types.ts";

describe("sanitized cache schema", () => {
  it("quota-cache.ts has zero node: built-in imports (isomorphic guard)", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname!, "quota-cache.ts"),
      "utf-8",
    );
    assert.ok(!source.includes('from "node:'), "found node: import in quota-cache.ts");
    assert.ok(!source.includes("require(\"node:"), "found node: require in quota-cache.ts");
  });

  it("cacheEvent strips sensitive fields", () => {
    const event: UsageEvent = {
      id: "secret-request-id-12345",
      agent: "claude",
      model: "sonnet",
      modelRaw: "claude-sonnet-4-20250514",
      ts: 1718000000000,
      sessionId: "/Users/alice/.config/claude/session-token",
      task: "Write a prompt injection payload",
      tokensIn: 1000,
      tokensOut: 500,
      cacheRead: 200,
      cacheWrite: 100,
      reasoningMin: 0,
      speed: "standard",
      anomalies: [
        {
          code: "fractional-token",
          field: "tokensIn",
          rawValue: "1000.5 from /Users/alice/secrets.txt",
        },
      ],
    };
    const cached = cacheEvent(event);
    const serialized = JSON.stringify(cached);

    // Must not contain original sensitive data
    assert.ok(!serialized.includes("secret-request-id-12345"), "leaked original id");
    assert.ok(!serialized.includes("/Users/alice"), "leaked file path");
    assert.ok(!serialized.includes("session-token"), "leaked sessionId");
    assert.ok(!serialized.includes("prompt injection"), "leaked task");
    assert.ok(!serialized.includes("secrets.txt"), "leaked anomaly rawValue");

    // Must contain hash and safe fields
    assert.equal(cached.idHash.length, 64);
    assert.ok(/^[a-f0-9]{64}$/.test(cached.idHash));
    assert.equal(cached.agent, "claude");
    assert.equal(cached.model, "sonnet");
    assert.equal(cached.ts, 1718000000000);
    assert.equal(cached.tokensIn, 1000);
    assert.equal(cached.tokensOut, 500);
  });

  it("strict schema rejects extra keys", () => {
    const validEvent: CachedQuotaEvent = {
      idHash: "a".repeat(64),
      agent: "claude",
      model: "sonnet",
      ts: 1718000000000,
      tokensIn: 100,
      tokensOut: 50,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const snapshot = {
      version: 2 as const,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete: true,
      cursors: [],
      events: [validEvent],
      extraKey: "should-fail",
    };
    const result = quotaCacheSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, false, "should reject extra keys");
  });

  it("strict schema rejects NaN and negative numbers", () => {
    const nanEvent = {
      idHash: "a".repeat(64),
      agent: "claude",
      model: "sonnet",
      ts: NaN,
      tokensIn: 100,
      tokensOut: 50,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const snapshot = {
      version: 2 as const,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete: true,
      cursors: [],
      events: [nanEvent],
    };
    const result = quotaCacheSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, false, "should reject NaN ts");

    const negEvent = {
      ...nanEvent,
      ts: 100,
      tokensIn: -5,
    };
    const result2 = quotaCacheSnapshotSchema.safeParse({
      ...snapshot,
      events: [negEvent],
    });
    assert.equal(result2.success, false, "should reject negative tokens");
  });

  it("strict schema rejects unsafe modelRaw (path traversal)", () => {
    const event = {
      idHash: "a".repeat(64),
      agent: "claude",
      model: "sonnet",
      modelRaw: "/Users/alice/token",
      ts: 100,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const snapshot = {
      version: 2,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete: true,
      cursors: [],
      events: [event],
    };
    const result = quotaCacheSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, false, "should reject path-like modelRaw");
  });

  it("strict schema rejects orphan reportedUsd without reportedCostSchema", () => {
    const event = {
      idHash: "a".repeat(64),
      agent: "grok",
      model: "grok-4.6",
      ts: 100,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedUsd: 1.25,
      // missing reportedCostSchema
    };
    const snapshot = {
      version: 2,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete: true,
      cursors: [],
      events: [event],
    };
    const result = quotaCacheSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, false, "should reject orphan reportedUsd");
  });

  it("strict schema rejects cursor with resumeOffset > observedSize", () => {
    const cursor = {
      pathHash: "c".repeat(64),
      agent: "claude" as const,
      resumeOffset: 5000,
      observedSize: 1000,
      mtimeMs: 100,
      ctimeMs: 100,
      dev: 1,
      ino: 1234,
    };
    const snapshot = {
      version: 2,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete: true,
      cursors: [cursor],
      events: [],
    };
    const result = quotaCacheSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, false, "should reject resumeOffset > observedSize");
  });

  it("strict schema rejects historyTruncated/truncatedBeforeMs mismatch", () => {
    const snapshot1 = {
      version: 2,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: true,
      truncatedBeforeMs: null, // mismatch: truncated but no timestamp
      cursorSetComplete: true,
      cursors: [],
      events: [],
    };
    const result1 = quotaCacheSnapshotSchema.safeParse(snapshot1);
    assert.equal(result1.success, false, "should reject truncated=true with null timestamp");

    const snapshot2 = {
      version: 2,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: 12345, // mismatch: not truncated but has timestamp
      cursorSetComplete: true,
      cursors: [],
      events: [],
    };
    const result2 = quotaCacheSnapshotSchema.safeParse(snapshot2);
    assert.equal(result2.success, false, "should reject truncated=false with timestamp");
  });

  it("strict schema rejects cursor with raw path or tail fields", () => {
    const cursor = {
      pathHash: "c".repeat(64),
      agent: "claude",
      resumeOffset: 100,
      observedSize: 200,
      mtimeMs: 100,
      ctimeMs: 100,
      dev: 1,
      ino: 1234,
      path: "/Users/alice/logs/claude.jsonl", // extra field
    };
    const snapshot = {
      version: 2,
      snapshotId: "b".repeat(64),
      savedAt: Date.now(),
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete: true,
      cursors: [cursor],
      events: [],
    };
    const result = quotaCacheSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, false, "should reject cursor with raw path");
  });

  it("same id with different agents produces different idHashes", () => {
    const sharedId = "shared-request-id";
    const hashClaude = eventIdHash("claude", sharedId);
    const hashCodex = eventIdHash("codex", sharedId);
    const hashGrok = eventIdHash("grok", sharedId);

    assert.notEqual(hashClaude, hashCodex);
    assert.notEqual(hashClaude, hashGrok);
    assert.notEqual(hashCodex, hashGrok);

    // All are valid 64-char hex
    for (const h of [hashClaude, hashCodex, hashGrok]) {
      assert.ok(/^[a-f0-9]{64}$/.test(h), `invalid hash format: ${h}`);
    }
  });

  it("quotaEventIdentity returns import: prefix for events without cacheIdentity", () => {
    const event: UsageEvent = {
      id: "test-id",
      agent: "claude",
      model: "sonnet",
      ts: 100,
      sessionId: "s1",
      task: "t",
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningMin: 0,
    };
    const identity = quotaEventIdentity(event);
    assert.ok(identity.startsWith("import:"), `should start with import: but got ${identity}`);
    assert.ok(
      !/^[a-f0-9]{64}$/.test(identity),
      "import: key must not match hex64 pattern",
    );
  });

  it("quotaEventIdentity returns raw cacheIdentity when present", () => {
    const hexId = "f".repeat(64);
    const event: UsageEvent = {
      id: "test-id",
      agent: "claude",
      model: "sonnet",
      ts: 100,
      sessionId: "s1",
      task: "t",
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningMin: 0,
      cacheIdentity: hexId,
    };
    assert.equal(quotaEventIdentity(event), hexId);
  });
});

describe("cache event round trip", () => {
  it("known model round-trip preserves costBreakdown amounts", () => {
    const event: UsageEvent = {
      id: "known-model-test",
      agent: "claude",
      model: "sonnet",
      modelRaw: "claude-sonnet-4-20250514",
      ts: 1718000000000,
      sessionId: "s1",
      task: "test task",
      tokensIn: 1000,
      tokensOut: 500,
      cacheRead: 200,
      cacheWrite: 100,
      reasoningMin: 5,
      speed: "standard",
    };
    const originalCost = costBreakdown(event);
    const cached = cacheEvent(event);
    const hydrated = hydrateCachedEvent(cached);
    const hydratedCost = costBreakdown(hydrated);

    assert.equal(hydratedCost.inputUsd, originalCost.inputUsd);
    assert.equal(hydratedCost.outputUsd, originalCost.outputUsd);
    assert.equal(hydratedCost.cacheReadUsd, originalCost.cacheReadUsd);
    assert.equal(hydratedCost.totalUsd, originalCost.totalUsd);
    assert.equal(hydratedCost.priced, originalCost.priced);
  });

  it("round-trip cacheEvent(hydrateCachedEvent(cached)).idHash === cached.idHash", () => {
    const event: UsageEvent = {
      id: "round-trip-id",
      agent: "codex",
      model: "gpt-5.5",
      modelRaw: "gpt-5.5",
      ts: 1718000000000,
      sessionId: "s1",
      task: "test",
      tokensIn: 500,
      tokensOut: 250,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningMin: 0,
    };
    const cached = cacheEvent(event);
    const hydrated = hydrateCachedEvent(cached);
    const reCached = cacheEvent(hydrated);

    assert.equal(reCached.idHash, cached.idHash, "idHash should survive round-trip");
  });

  it("future unknown model: pricingDisabled, costBreakdown.priced===false, re-cache preserves model", () => {
    const futureModel = "future-model-2030";
    const cached: CachedQuotaEvent = {
      idHash: "d".repeat(64),
      agent: "claude",
      model: futureModel,
      ts: 1718000000000,
      tokensIn: 1000,
      tokensOut: 500,
      cacheRead: 0,
      cacheWrite: 0,
    };

    // Validate that the schema accepts a safe unknown model
    assert.ok(isSafeModelRaw(futureModel), "future model should be safe");

    const hydrated = hydrateCachedEvent(cached);
    assert.equal(hydrated.pricingDisabled, true, "should have pricingDisabled");

    const cost = costBreakdown(hydrated);
    assert.equal(cost.priced, false, "should not be priced");
    assert.equal(cost.pricingQuality, "unknown", "should be unknown quality");

    // Re-cache should preserve the original model
    const reCached = cacheEvent(hydrated);
    assert.equal(reCached.model, futureModel, "re-cache should keep future model");
  });

  it("grok reported cost round-trips through cache", () => {
    const event: UsageEvent = {
      id: "grok-cost-test",
      agent: "grok",
      model: "grok-4.6",
      modelRaw: "grok-4.6",
      ts: 1718000000000,
      sessionId: "s1",
      task: "test",
      tokensIn: 1000,
      tokensOut: 500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningMin: 0,
      reportedCost: {
        totalRawValue: 12500000000,
        byModelRawValue: {},
        rawUnit: "usd-ticks",
        usdValue: 1.25,
        divisor: 10_000_000_000,
        sourceField: "grok-internal",
        schemaVersion: "grok-cli-1.0.0",
        semantics: "api-equivalent",
      },
    };
    const cached = cacheEvent(event);
    assert.equal(cached.reportedUsd, 1.25);
    assert.equal(cached.reportedCostSchema, "grok-cli-1.0.0");

    const hydrated = hydrateCachedEvent(cached);
    assert.equal(hydrated.reportedCost?.usdValue, 1.25);
    assert.equal(hydrated.reportedCost?.semantics, "api-equivalent");
  });
});
