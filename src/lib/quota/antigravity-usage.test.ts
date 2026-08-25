import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateAntigravityUsage,
  type AntigravityUsageEvent,
} from "./antigravity-usage.ts";

function event(
  model: string,
  values: Partial<AntigravityUsageEvent> = {},
): AntigravityUsageEvent {
  return {
    ts: values.ts ?? Date.parse("2026-08-25T04:00:00Z"),
    model,
    quotaGroup: model.startsWith("gemini-") ? "gemini" : "claude-gpt",
    tokensIn: values.tokensIn ?? 1_000_000,
    tokensOut: values.tokensOut ?? 1_000_000,
    cacheRead: values.cacheRead ?? 100_000,
    cacheWrite: values.cacheWrite ?? 0,
    thinkingTokens: values.thinkingTokens ?? 600_000,
    responseTokens: values.responseTokens ?? 400_000,
  };
}

test("aggregateAntigravityUsage prices each model before grouping", () => {
  const summary = aggregateAntigravityUsage([
    event("gemini-3.7-flash-high"),
    event("gemini-3.5-flash-low"),
    event("claude-sonnet-4-6"),
    event("gpt-oss-120b-medium"),
  ], 0);
  assert.deepEqual(summary.models.map((model) => model.model), [
    "claude-sonnet-4-6",
    "gemini-3.5-flash-low",
    "gemini-3.7-flash-high",
    "gpt-oss-120b-medium",
  ]);
  const gemini37 = summary.models.find((model) => model.model === "gemini-3.7-flash-high");
  assert.equal(gemini37?.apiEquivalentUsd, 4.5075);
  assert.equal(gemini37?.pricingSemantics, "google-api-equivalent");
  const gemini35 = summary.models.find((model) => model.model === "gemini-3.5-flash-low");
  assert.equal(gemini35?.apiEquivalentUsd, 10.515);
  const sonnet = summary.models.find((model) => model.model === "claude-sonnet-4-6");
  assert.equal(sonnet?.apiEquivalentUsd, 18.03);
  assert.equal(sonnet?.pricingSemantics, "anthropic-api-estimate");
  const gpt = summary.models.find((model) => model.model === "gpt-oss-120b-medium");
  assert.equal(gpt?.pricedTokens, 0);
  assert.equal(gpt?.pricingSemantics, "unpriced");
});

test("Gemini 3.1 Pro applies long-context price per event", () => {
  const summary = aggregateAntigravityUsage([
    event("gemini-3.1-pro-high", {
      tokensIn: 150_000,
      cacheRead: 60_001,
      tokensOut: 10_000,
      thinkingTokens: 6_000,
      responseTokens: 4_000,
    }),
  ], 0);
  assert.equal(summary.models[0]?.apiEquivalentUsd, 0.8040004000000001);
});

test("thinking tokens are not charged twice and cache writes remain unpriced", () => {
  const summary = aggregateAntigravityUsage([
    event("gemini-3.7-flash-medium", {
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      thinkingTokens: 800_000,
      responseTokens: 200_000,
      cacheRead: 0,
      cacheWrite: 50_000,
    }),
  ], 0);
  assert.equal(summary.models[0]?.apiEquivalentUsd, 4.5);
  assert.equal(summary.models[0]?.pricedTokens, 2_000_000);
  assert.ok((summary.models[0]?.pricingCoverage ?? 1) < 1);
});

test("aggregateAntigravityUsage filters by window start", () => {
  const summary = aggregateAntigravityUsage([
    event("gemini-3.7-flash-high", { ts: 99 }),
    event("gemini-3.7-flash-high", { ts: 100 }),
  ], 100);
  assert.equal(summary.calls, 1);
});

test("aggregateAntigravityUsage skips unsafe token totals", () => {
  const summary = aggregateAntigravityUsage([
    event("gemini-3.7-flash-high", {
      tokensIn: Number.MAX_SAFE_INTEGER,
      tokensOut: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ], 0);
  assert.equal(summary.calls, 0);
  assert.equal(summary.totalTokens, 0);
});
