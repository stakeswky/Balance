import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCacheWrites, exclusiveCachedInput, normalizeToken, rawExclusiveTokens } from "./tokens.ts";

test("codex-style input includes cached tokens and must be split", () => {
  const split = exclusiveCachedInput(27339, 27008);
  assert.equal(split.uncachedInputTokens, 331);
  assert.equal(split.cacheReadTokens, 27008);
  assert.equal(split.cachedExceedsInput, false);
});

test("cached greater than input clamps uncached to 0 and reports anomaly", () => {
  const split = exclusiveCachedInput(100, 250);
  assert.equal(split.uncachedInputTokens, 0);
  assert.equal(split.cacheReadTokens, 100);
  assert.equal(split.cachedExceedsInput, true);
});

test("cached equal to input is all cache read", () => {
  const split = exclusiveCachedInput(50, 50);
  assert.equal(split.uncachedInputTokens, 0);
  assert.equal(split.cacheReadTokens, 50);
});

test("claude nested 5m/1h cache writes stay split", () => {
  const w = claudeCacheWrites({
    cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 12 },
  });
  assert.equal(w.cacheWrite5mTokens, 8);
  assert.equal(w.cacheWrite1hTokens, 12);
  assert.equal(w.splitUnknown, false);
});

test("claude cache_creation_input_tokens total is treated as 5m with unknown split", () => {
  const w = claudeCacheWrites({ cache_creation_input_tokens: 39408 });
  assert.equal(w.cacheWrite5mTokens, 39408);
  assert.equal(w.cacheWrite1hTokens, 0);
  assert.equal(w.splitUnknown, true);
});

test("raw exclusive tokens do not double-count cache", () => {
  assert.equal(
    rawExclusiveTokens({ tokensIn: 331, tokensOut: 807, cacheRead: 27008, cacheWrite: 0 }),
    331 + 807 + 27008,
  );
});

test("structured token anomaly codes survive normalization", () => {
  assert.deepEqual(normalizeToken(5, "input_tokens"), { value: 5, anomalies: [] });
  assert.deepEqual(normalizeToken(null, "input_tokens"), { value: 0, anomalies: [] });
  assert.deepEqual(normalizeToken(-3, "output_tokens"), {
    value: 0,
    anomalies: [{ code: "negative-token", field: "output_tokens", rawValue: "-3" }],
  });
  assert.deepEqual(normalizeToken(Number.POSITIVE_INFINITY, "input_tokens"), {
    value: 0,
    anomalies: [{ code: "non-finite-token", field: "input_tokens", rawValue: "Infinity" }],
  });
  assert.deepEqual(normalizeToken("not-a-number", "cached_input_tokens"), {
    value: 0,
    anomalies: [{ code: "non-finite-token", field: "cached_input_tokens", rawValue: "not-a-number" }],
  });
  assert.deepEqual(normalizeToken(1.5, "output_tokens"), {
    value: 0,
    anomalies: [{ code: "fractional-token", field: "output_tokens", rawValue: "1.5" }],
  });
});

test("structured token anomaly is reported when cached exceeds input", () => {
  const split = exclusiveCachedInput(100, 250);
  assert.equal(split.uncachedInputTokens, 0);
  assert.equal(split.cacheReadTokens, 100);
  assert.equal(split.cachedExceedsInput, true);
  assert.deepEqual(split.anomalies, [
    { code: "cached-input-exceeds-input", field: "cached_input_tokens", rawValue: "250" },
  ]);
});
