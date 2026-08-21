import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupPricing, PRICING_VERSION } from "./pricing.ts";
import { asCodexModel } from "./codex-jsonl.ts";
import { asGrokModel } from "./grok-jsonl.ts";
import { PRICING_TABLE, PRICING_VERIFIED_AT, PRICING_MAX_AGE_MS, OPENAI_CREDITS_PER_USD } from "./pricing-data.ts";

const SNAPSHOT_AT = Date.parse("2026-08-21T12:00:00Z");

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
  const sol = lookupPricing("gpt-5.6-sol", null, SNAPSHOT_AT).pricing!;
  const terra = lookupPricing("gpt-5.6-terra", null, SNAPSHOT_AT).pricing!;
  const luna = lookupPricing("gpt-5.6-luna", null, SNAPSHOT_AT).pricing!;
  const gpt54 = lookupPricing("gpt-5.4", null, SNAPSHOT_AT).pricing!;

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
  assert.equal(lookupPricing("gpt-5.3-codex-spark", "gpt-5.6-luna", SNAPSHOT_AT).pricing, null);
  // gpt-5.4-mini 自本 Step 起已登记，移入正价断言（固定 atMs，避免退役日后翻红）：
  assert.equal(
    lookupPricing("gpt-5.4-mini", "gpt-5.6-luna", SNAPSHOT_AT).pricing!.inputPerToken * 1_000_000,
    0.75,
  );
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

/**
 * Evidence-URL: https://help.openai.com/en/articles/20001106-codex-rate-card
 * Evidence-Checked: 2026-08-21
 * Evidence-Fields: Codex cache write 免费
 * Sanitized-Fixture: {"agent":"codex","cache_write_5m":0,"cache_write_1h":0}
 */
test("Codex and Grok cache writes are free while Claude retains explicit rates", () => {
  assert.equal(lookupPricing("gpt-5.6-sol").pricing!.cacheWrite5mPerToken, 0);
  assert.equal(lookupPricing("grok-4.6").pricing!.cacheWrite1hPerToken, 0);
  assert.equal(lookupPricing("claude-sonnet-5").pricing!.cacheWrite5mPerToken * 1_000_000, 2.5);
  assert.equal(lookupPricing("claude-sonnet-5").pricing!.cacheWrite1hPerToken * 1_000_000, 4);
});

test("cache write repricing bumps the pricing version", () => {
  assert.notEqual(PRICING_VERSION, "2026-08-21-balance-1");
});

/**
 * Evidence-URL: https://help.openai.com/en/articles/20001106-codex-rate-card；https://github.com/ryoppippi/ccusage（fast-multiplier-overrides.json）
 * Evidence-Checked: 2026-08-21
 * Evidence-Fields: Codex/Claude fast 倍率
 * Sanitized-Fixture: {"codex":{"gpt-5.6":2.5,"gpt-5.5":2.5,"gpt-5.4":2},"claude":{"opus-4-6":6,"opus-4-7":6,"opus-4-8":2}}
 */
test("fast model mix pricing multipliers match the verified per-model fixtures", () => {
  assert.equal(lookupPricing("claude-opus-4-6").pricing!.fastApiMultiplier, 6);
  assert.equal(lookupPricing("claude-opus-4-7").pricing!.fastApiMultiplier, 6);
  assert.equal(lookupPricing("claude-opus-4-8").pricing!.fastApiMultiplier, 2);
  assert.equal(lookupPricing("claude-opus-5").pricing!.fastApiMultiplier, null);
  assert.equal(lookupPricing("gpt-5.6-sol").pricing!.fastCreditMultiplier, 2.5);
  assert.equal(lookupPricing("gpt-5.6-terra").pricing!.fastCreditMultiplier, 2.5);
  assert.equal(lookupPricing("gpt-5.6-luna").pricing!.fastCreditMultiplier, 2.5);
  assert.equal(lookupPricing("gpt-5.4").pricing!.fastCreditMultiplier, 2);
  assert.equal(lookupPricing("grok-4.6").pricing!.fastApiMultiplier, null);
  assert.equal(lookupPricing("grok-4.6").pricing!.fastCreditMultiplier, null);
});

/**
 * Evidence-URL: https://learn.chatgpt.com/docs/pricing；https://platform.claude.com/docs/en/about-claude/pricing；https://docs.x.ai/developers/pricing
 * Evidence-Checked: 2026-08-21
 * Evidence-Fields: 每百万 input/output/cache-read、长上下文倍率、退役日
 * Sanitized-Fixture: {"gpt-5.5":[5,30,0.5],"gpt-5.4-mini":[0.75,4.5,0.075],"daybreak-blue":[5,30,0.5],"daybreak-red":[12.5,75,1.25],"grok-4.3":[1.25,2.5,0.2],"grok-4.20":[1.25,2.5,0.2]}
 */
test("newly listed models classify and resolve with exact prices", () => {
  assert.equal(asCodexModel("gpt-5.5"), "gpt-5.5");
  assert.equal(asCodexModel("gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(asCodexModel("daybreak-red-preview"), "daybreak-red");
  assert.equal(asCodexModel("daybreak-blue"), "daybreak-blue");
  assert.equal(asGrokModel("grok-4.20-beta"), "grok-4.20");
  assert.equal(asGrokModel("grok-4.3"), "grok-4.3");
  assert.equal(lookupPricing("gpt-5.5", null, SNAPSHOT_AT).pricing!.inputPerToken * 1_000_000, 5);
  assert.equal(lookupPricing("gpt-5.5", null, SNAPSHOT_AT).pricing!.fastCreditMultiplier, 2.5);
  assert.equal(lookupPricing("gpt-5.4-mini", null, SNAPSHOT_AT).pricing!.outputPerToken * 1_000_000, 4.5);
  assert.equal(lookupPricing("daybreak-blue", null, SNAPSHOT_AT).pricing!.inputPerToken * 1_000_000, 5);
  assert.equal(lookupPricing("daybreak-red", null, SNAPSHOT_AT).pricing!.outputPerToken * 1_000_000, 75);
  assert.equal(lookupPricing("grok-4.3", null, SNAPSHOT_AT).pricing!.inputPerToken * 1_000_000, 1.25);
  assert.equal(lookupPricing("grok-4.20", null, SNAPSHOT_AT).pricing!.longContextThreshold, 200_000);
});

test("retired models stay priced before retirement and unknown after", () => {
  const before = Date.parse("2026-08-30T00:00:00Z");
  const after = Date.parse("2026-08-31T00:00:01Z");
  assert.equal(lookupPricing("gpt-5.4", "gpt-5.4", before).quality, "exact");
  const retired = lookupPricing("gpt-5.4", "gpt-5.4", after);
  assert.equal(retired.quality, "unknown");
  assert.equal(retired.pricing, null);
  assert.equal(lookupPricing("gpt-5.4-mini", "gpt-5.6-luna", after).pricing, null);
});

test("pricing snapshot is fresh and Codex standard rates preserve the credit unit", () => {
  assert.ok(Date.now() - PRICING_VERIFIED_AT <= PRICING_MAX_AGE_MS);
  for (const row of PRICING_TABLE.filter((pricing) => pricing.creditsPerUsd != null)) {
    assert.equal(row.creditsPerUsd, OPENAI_CREDITS_PER_USD);
    assert.equal(row.cacheWrite5mPerToken, 0);
    assert.equal(row.cacheWrite1hPerToken, 0);
  }
});
