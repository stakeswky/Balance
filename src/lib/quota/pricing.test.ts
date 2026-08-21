import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupPricing } from "./pricing.ts";

test("exact model beats alias and family fallback", () => {
  const hit = lookupPricing("claude-opus-5", "sonnet");
  assert.equal(hit.quality, "exact");
  assert.equal(hit.resolvedModel, "claude-opus-5");
});

test("registered alias is exact quality", () => {
  const hit = lookupPricing("claude-opus-5-20260724", "opus");
  assert.equal(hit.quality, "exact");
  assert.equal(hit.resolvedModel, "claude-opus-5");
});

test("family fallback only when raw is empty or contains the family token", () => {
  const family = lookupPricing(undefined, "opus");
  assert.equal(family.quality, "family-fallback");
  assert.equal(family.resolvedModel, "claude-opus-5");

  const fromRaw = lookupPricing("claude-opus-mystery", "opus");
  assert.equal(fromRaw.quality, "family-fallback");
});

test("unknown raw is not silently mapped to a default family", () => {
  const hit = lookupPricing("gpt-4o", "gpt-5.6-sol");
  assert.equal(hit.quality, "unknown");
  assert.equal(hit.pricing, null);
});

test("Codex current public price snapshot is exact", () => {
  const sol = lookupPricing("gpt-5.6-sol").pricing!;
  const terra = lookupPricing("gpt-5.6-terra").pricing!;
  const luna = lookupPricing("gpt-5.6-luna").pricing!;
  const gpt54 = lookupPricing("gpt-5.4").pricing!;

  assert.equal(sol.inputPerToken * 1_000_000, 5);
  assert.equal(sol.cacheReadPerToken * 1_000_000, 0.5);
  assert.equal(sol.outputPerToken * 1_000_000, 30);
  assert.equal(terra.inputPerToken * 1_000_000, 2);
  assert.equal(terra.cacheReadPerToken * 1_000_000, 0.2);
  assert.equal(terra.outputPerToken * 1_000_000, 12);
  assert.equal(luna.inputPerToken * 1_000_000, 0.2);
  assert.equal(luna.cacheReadPerToken * 1_000_000, 0.02);
  assert.equal(luna.outputPerToken * 1_000_000, 1.2);
  assert.equal(gpt54.inputPerToken * 1_000_000, 2.5);
  assert.equal(gpt54.outputPerToken * 1_000_000, 15);
  for (const pricing of [sol, terra, luna, gpt54]) {
    assert.equal(pricing.longContextThreshold, 272_000);
    assert.equal(pricing.longContextInputMultiplier, 2);
    assert.equal(pricing.longContextOutputMultiplier, 1.5);
    assert.equal(pricing.creditsPerUsd, 25);
  }
});

test("unpublished Codex variants stay unpriced", () => {
  assert.equal(lookupPricing("gpt-5.4-mini", "gpt-5.6-luna").pricing, null);
  assert.equal(lookupPricing("gpt-5.3-codex-spark", "gpt-5.6-luna").pricing, null);
});

test("Claude Sonnet 5 and Sonnet 4.6 keep distinct public prices", () => {
  assert.equal(lookupPricing("claude-sonnet-5", "sonnet").pricing?.inputPerToken, 2 / 1_000_000);
  assert.equal(lookupPricing("claude-sonnet-4-6", "sonnet").pricing?.inputPerToken, 3 / 1_000_000);
  assert.equal(lookupPricing("claude-sonnet-4-6", "sonnet").pricing?.outputPerToken, 15 / 1_000_000);
});

test("known dated model ids resolve to their exact base price", () => {
  const hit = lookupPricing("claude-sonnet-4-6-20251110", "sonnet");
  assert.equal(hit.quality, "exact");
  assert.equal(hit.resolvedModel, "claude-sonnet-4-6");
  assert.equal(hit.pricing!.inputPerToken * 1_000_000, 3);
});

test("unknown dated ids remain unknown", () => {
  const hit = lookupPricing("claude-sonnet-9-9-20990101", "sonnet");
  assert.equal(hit.quality, "unknown");
});

test("Grok models keep provider-specific cached input prices", () => {
  assert.equal(lookupPricing("grok-4.6", "grok-4.6").pricing?.cacheReadPerToken, 0.5 / 1_000_000);
  assert.equal(lookupPricing("grok-4.5", "grok-4.5").pricing?.cacheReadPerToken, 0.3 / 1_000_000);
  assert.equal(lookupPricing("grok-build-0.1", "grok-4.6").pricing?.cacheReadPerToken, 0.2 / 1_000_000);
  assert.equal(lookupPricing("grok-4.6-build", "grok-4.6").resolvedModel, "grok-4.6");
});
