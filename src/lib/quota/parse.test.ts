import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsagePayload } from "./parse.ts";
import { observeWindow } from "./quota-value.ts";

test("propagates token anomalies for imported OpenAI-style rows", () => {
  const events = parseUsagePayload(
    JSON.stringify([
      {
        agent: "codex",
        model: "gpt-5.4",
        timestamp: 1_725_000_100_000,
        usage: { input_tokens: 100, cache_read_input_tokens: 250, output_tokens: -5 },
      },
    ]),
    "codex",
  );
  assert.equal(events.length, 1);
  assert.deepEqual(
    events[0]!.anomalies?.map((anomaly) => anomaly.code).sort(),
    ["cached-input-exceeds-input", "negative-token"],
  );
  assert.equal(events[0]!.tokensIn, 0);
  assert.equal(events[0]!.cacheRead, 100);
  assert.equal(events[0]!.tokensOut, 0);
});

test("imported rows keep explicit image token fields", () => {
  const events = parseUsagePayload(
    JSON.stringify([
      {
        agent: "claude",
        model: "claude-sonnet-5",
        timestamp: 1_725_000_100_000,
        usage: { input_tokens: 10, output_tokens: 5, image_input_tokens: 640, image_output_tokens: 8 },
      },
    ]),
    "claude",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.imageInputTokens, 640);
  assert.equal(events[0]!.imageOutputTokens, 8);
});

test("imported rows with missing raw model stay unpriced", () => {
  const events = parseUsagePayload(
    JSON.stringify([
      { agent: "codex", timestamp: 1_725_000_100_000, usage: { input_tokens: 10, output_tokens: 5 } },
    ]),
    "codex",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.modelRaw, undefined);
  assert.equal(observeWindow([events[0]!]).pricedTokenCoverage, 0);
});

const SPEED_CASES = [
  { raw: "fast", expected: "fast" },
  { raw: "FAST", expected: "fast" },
  { raw: "standard", expected: "standard" },
  { raw: undefined, expected: "unknown" },
  { raw: "turbo", expected: "unknown" },
] as const;

test("imported rows record explicit usage speed only", () => {
  for (const { raw, expected } of SPEED_CASES) {
    const events = parseUsagePayload(
      JSON.stringify([
        {
          agent: "codex",
          model: "gpt-5.4",
          timestamp: 1_725_000_100_000,
          usage: { input_tokens: 10, output_tokens: 5, ...(raw === undefined ? {} : { speed: raw }) },
        },
      ]),
      "codex",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.speed, expected);
  }
});
