import assert from "node:assert/strict";
import { test } from "node:test";
import { costBreakdown } from "./cost.ts";
import type { UsageEvent } from "./types.ts";

function ev(partial: Partial<UsageEvent>): UsageEvent {
  return {
    id: "e1",
    agent: "codex",
    model: "gpt-5.4",
    modelRaw: "gpt-5.4",
    ts: 1,
    sessionId: "s",
    task: "t",
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
    ...partial,
  };
}

test("spec §16 Codex example does not double-bill cached input", () => {
  const cost = costBreakdown(
    ev({
      tokensIn: 331,
      cacheRead: 27008,
      tokensOut: 807,
    }),
  );
  assert.equal(cost.pricingQuality, "exact");
  assert.ok(Math.abs(cost.inputUsd - 0.0008275) < 1e-12);
  assert.ok(Math.abs(cost.cacheReadUsd - 0.006752) < 1e-12);
  assert.ok(Math.abs(cost.outputUsd - 0.012105) < 1e-12);
  assert.ok(Math.abs(cost.totalUsd - 0.0196845) < 1e-12);
});

test("wrong inclusive formula is larger than exclusive cost", () => {
  const exclusive = costBreakdown(ev({ tokensIn: 331, cacheRead: 27008, tokensOut: 807 })).totalUsd;
  const wrong = costBreakdown(ev({ tokensIn: 27339, cacheRead: 27008, tokensOut: 807 })).totalUsd;
  assert.ok(wrong > exclusive * 4);
});

test("unknown model is not priced", () => {
  const cost = costBreakdown(
    ev({
      model: "gpt-5.6-sol",
      modelRaw: "mystery-model-99",
      tokensIn: 1000,
      tokensOut: 1000,
    }),
  );
  assert.equal(cost.pricingQuality, "unknown");
  assert.equal(cost.priced, false);
  assert.equal(cost.totalUsd, 0);
});

test("claude 5m and 1h cache writes use different prices", () => {
  const five = costBreakdown(
    ev({
      agent: "claude",
      model: "sonnet",
      modelRaw: "claude-sonnet-5",
      cacheWrite: 1_000_000,
    }),
  );
  const hour = costBreakdown(
    ev({
      agent: "claude",
      model: "sonnet",
      modelRaw: "claude-sonnet-5",
      cacheWrite: 0,
      cacheWrite1h: 1_000_000,
    }),
  );
  assert.ok(hour.cacheWriteUsd > five.cacheWriteUsd);
  assert.ok(Math.abs(five.cacheWriteUsd - 2.5) < 1e-12);
  assert.ok(Math.abs(hour.cacheWriteUsd - 4) < 1e-12);
});

test("long-context multiplier only applies to models that declare it", () => {
  const grok = costBreakdown(
    ev({
      agent: "grok",
      model: "grok-4.6",
      modelRaw: "grok-4.6",
      tokensIn: 150_000,
      cacheRead: 60_000,
      tokensOut: 1_000,
    }),
  );
  const uncached = 150_000 * (2 / 1_000_000) * 2;
  const cache = 60_000 * (0.5 / 1_000_000) * 2;
  const output = 1_000 * (6 / 1_000_000) * 2;
  assert.ok(Math.abs(grok.totalUsd - (uncached + cache + output)) < 1e-12);

  const opus = costBreakdown(
    ev({
      agent: "claude",
      model: "opus",
      modelRaw: "claude-opus-5",
      tokensIn: 150_000,
      cacheRead: 60_000,
      tokensOut: 1_000,
    }),
  );
  const opusExpected = 150_000 * (5 / 1_000_000) + 60_000 * (0.5 / 1_000_000) + 1_000 * (25 / 1_000_000);
  assert.ok(Math.abs(opus.totalUsd - opusExpected) < 1e-12);
});

test("reported ticks are ignored when computing API-equivalent USD", () => {
  const withTicks = costBreakdown(
    ev({
      agent: "grok",
      model: "grok-4.6",
      modelRaw: "grok-4.6",
      tokensIn: 100_000,
      tokensOut: 0,
      reportedCostTicks: 99_999_999,
    }),
  );
  assert.ok(Math.abs(withTicks.totalUsd - 0.2) < 1e-12);
});

test("unsplit claude cache write drops quality to family-fallback", () => {
  const cost = costBreakdown(
    ev({
      agent: "claude",
      model: "opus",
      modelRaw: "claude-opus-5",
      cacheWrite: 1000,
      cacheWriteUnsplit: true,
    }),
  );
  assert.equal(cost.priced, true);
  assert.equal(cost.pricingQuality, "family-fallback");
});

test("Codex long context and credits use the public multipliers", () => {
  const cost = costBreakdown(
    ev({
      model: "gpt-5.6-sol",
      modelRaw: "gpt-5.6-sol",
      tokensIn: 273_000,
      tokensOut: 1_000,
    }),
  );
  const expectedUsd = 273_000 * (5 / 1_000_000) * 2 + 1_000 * (30 / 1_000_000) * 1.5;
  assert.ok(Math.abs(cost.totalUsd - expectedUsd) < 1e-12);
  assert.ok(Math.abs((cost.openAiCredits ?? 0) - expectedUsd * 25) < 1e-12);
});

test("anomalous token events remain observable and are not priced", () => {
  const event = ev({
    tokensIn: 10,
    anomalies: [{ code: "negative-token", field: "output_tokens", rawValue: "-1" }],
  });
  assert.equal(costBreakdown(event).priced, false);
  assert.equal(costBreakdown(event).totalUsd, 0);
  assert.equal(costBreakdown(event).pricingQuality, "unknown");
  assert.equal(costBreakdown(event).openAiCredits, null);
});

test("Spark remains unpriced instead of inheriting Luna price", () => {
  const cost = costBreakdown(
    ev({
      model: "gpt-5.6-luna",
      modelRaw: "gpt-5.3-codex-spark",
      tokensIn: 1_000_000,
    }),
  );
  assert.equal(cost.priced, false);
  assert.equal(cost.openAiCredits, null);
});
