import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsagePayload } from "./parse.ts";

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
