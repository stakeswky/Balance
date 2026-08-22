import assert from "node:assert/strict";
import { test } from "node:test";
import { costBreakdown, costBreakdownCacheStats } from "./cost.ts";
import { grokReportedCost } from "./grok-jsonl.ts";
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
      reportedCost: grokReportedCost(99_999_999, {}, null),
    }),
  );
  assert.ok(Math.abs(withTicks.totalUsd - 0.2) < 1e-12);
  assert.equal(withTicks.reportedUsd, null);
  assert.equal(withTicks.costSource, "token-recomputed");
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

test("missing raw model stays unpriced", () => {
  const event = ev({ model: "sonnet", modelRaw: undefined, tokensIn: 1_000_000 });
  const cost = costBreakdown(event);
  assert.equal(cost.priced, false);
  assert.equal(cost.totalUsd, 0);
});

/**
 * Evidence-URL: https://help.openai.com/en/articles/20001106-codex-rate-card；https://github.com/ryoppippi/ccusage（fast-multiplier-overrides.json）
 * Evidence-Checked: 2026-08-21
 * Evidence-Fields: Codex/Claude fast 倍率
 * Sanitized-Fixture: {"codex":{"gpt-5.6":2.5,"gpt-5.5":2.5,"gpt-5.4":2},"claude":{"opus-4-6":6,"opus-4-7":6,"opus-4-8":2}}
 */
test("fast model mix applies the Claude API multiplier only to fast events", () => {
  const standard = costBreakdown(
    ev({ agent: "claude", model: "opus", modelRaw: "claude-opus-4-6", speed: "standard", tokensIn: 1_000_000 }),
  );
  const fast = costBreakdown(
    ev({ agent: "claude", model: "opus", modelRaw: "claude-opus-4-6", speed: "fast", tokensIn: 1_000_000 }),
  );
  const unknownSpeed = costBreakdown(
    ev({ agent: "claude", model: "opus", modelRaw: "claude-opus-4-6", tokensIn: 1_000_000 }),
  );
  assert.ok(Math.abs(fast.totalUsd - standard.totalUsd * 6) < 1e-9);
  assert.equal(unknownSpeed.totalUsd, standard.totalUsd);
});

test("Codex fast changes credits and calibration mix without changing model id", () => {
  const standard = costBreakdown(ev({
    agent: "codex",
    model: "gpt-5.6-sol",
    modelRaw: "gpt-5.6-sol",
    speed: "standard",
    tokensIn: 1_000_000,
  }));
  const fast = costBreakdown(ev({
    agent: "codex",
    model: "gpt-5.6-sol",
    modelRaw: "gpt-5.6-sol",
    speed: "fast",
    tokensIn: 1_000_000,
  }));
  assert.equal(fast.totalUsd, standard.totalUsd);
  assert.equal(fast.openAiCredits, standard.openAiCredits! * 2.5);
});

test("unknown image prices reduce coverage without discarding text cost", () => {
  const event = ev({
    agent: "claude",
    model: "sonnet",
    modelRaw: "claude-sonnet-5",
    tokensIn: 1_000,
    imageInputTokens: 1_000,
  });
  const cost = costBreakdown(event);
  assert.equal(cost.priced, true);
  assert.equal(cost.imageUsd, 0);
  assert.equal(cost.fullyPriced, false);
});

/**
 * Evidence-URL: https://ccusage.com/guide/grok/
 * Evidence-Checked: 2026-08-22
 * Evidence-Fields: Grok CLI 1.0.0：`1 tick = 1e-10 USD`、turn 可聚合多请求；版本字段名统一为 `schemaVersion`，实现读取的就是它
 * Sanitized-Fixture: {"schemaVersion":"grok-cli-1.0.0","costUsdTicks":12500000000,"usd":1.25}
 */
test("verified Grok ticks override an ambiguous aggregated-turn recomputation", () => {
  const event = ev({
    agent: "grok",
    model: "grok-4.6",
    modelRaw: "grok-4.6",
    tokensIn: 360_000,
    reportedCost: grokReportedCost(72_000_000_000, { "grok-4.6": 72_000_000_000 }, "grok-cli-1.0.0"),
  });
  const cost = costBreakdown(event);
  assert.equal(cost.reportedUsd, 7.2);
  assert.equal(cost.totalUsd, 7.2);
  assert.equal(cost.costSource, "provider-reported");
  assert.notEqual(cost.recomputedUsd, cost.reportedUsd);
});

test("cost cache reuses identity but invalidates after mutation", () => {
  const event = ev({ tokensIn: 1_000 });
  const before = costBreakdownCacheStats();
  const first = costBreakdown(event);
  const second = costBreakdown(event);
  assert.equal(first, second);
  event.tokensIn = 2_000;
  const third = costBreakdown(event);
  assert.notEqual(third.totalUsd, first.totalUsd);
  const after = costBreakdownCacheStats();
  assert.equal(after.hits - before.hits, 1);
  assert.equal(after.misses - before.misses, 2);
});

test("cost cache invalidates on ts change", () => {
  const event = ev({ tokensIn: 1_000, ts: 100 });
  const before = costBreakdownCacheStats();
  costBreakdown(event);
  event.ts = 200;
  costBreakdown(event);
  const after = costBreakdownCacheStats();
  assert.equal(after.misses - before.misses, 2);
  assert.equal(after.hits - before.hits, 0);
});

test("cost cache invalidates on reportedCost semantics/usdValue change", () => {
  const event = ev({
    agent: "grok",
    model: "grok-4.6",
    modelRaw: "grok-4.6",
    tokensIn: 100_000,
    reportedCost: grokReportedCost(72_000_000_000, { "grok-4.6": 72_000_000_000 }, "grok-cli-1.0.0"),
  });
  const before = costBreakdownCacheStats();
  const first = costBreakdown(event);
  costBreakdown(event); // hit
  event.reportedCost!.usdValue = 9.99;
  const afterUsd = costBreakdown(event);
  assert.notEqual(afterUsd.totalUsd, first.totalUsd);
  event.reportedCost!.semantics = "provider-internal";
  costBreakdown(event);
  const after = costBreakdownCacheStats();
  assert.equal(after.hits - before.hits, 1);
  assert.equal(after.misses - before.misses, 3);
});
