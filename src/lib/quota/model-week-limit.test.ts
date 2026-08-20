import assert from "node:assert/strict";
import { test } from "node:test";
import { modelWeekLimitFor } from "./engine.ts";
import type { OfficialSlice } from "./official.ts";
import { planById } from "./plans.ts";
import type { UsageEvent } from "./types.ts";
import { WEEK_MS } from "./types.ts";

const now = Date.parse("2026-08-20T12:00:00Z");

const official: OfficialSlice = {
  agent: "claude",
  windowPct: 10,
  weekPct: 20,
  windowResetsAt: now + 60_000,
  weekResetsAt: now + 5 * 24 * 60 * 60 * 1_000,
  weekStartedAt: now - 2 * 24 * 60 * 60 * 1_000,
  windowDurationMs: 5 * 60 * 60 * 1_000,
  weekDurationMs: WEEK_MS,
  burnPctPerHour: 0,
  planLabel: "max",
  products: [],
  prepaidBalance: null,
  onDemandUsed: null,
  onDemandCap: null,
  source: "test",
  fetchedAt: now,
  windowKind: "five_hour",
};

function event(
  id: string,
  model: UsageEvent["model"],
  tokensIn: number,
  ts = now - 1_000,
): UsageEvent {
  return {
    id,
    agent: "claude",
    model,
    ts,
    sessionId: "session",
    task: "quota test",
    tokensIn,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
  };
}

test("Claude Max plans expose a 50% Fable weekly sub-limit", () => {
  assert.equal(planById("claude-max-5x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-max-20x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-pro").modelWeekLimitPct?.fable, undefined);
  assert.equal(planById("claude-api").modelWeekLimitPct?.fable, undefined);
});

test("Fable weekly sub-limit counts only current-window Fable weighted tokens", () => {
  const plan = {
    ...planById("claude-max-5x"),
    weekTokenBudget: 1_000,
  };
  const result = modelWeekLimitFor(
    [
      event("fable-current", "fable", 50),
      event("opus-current", "opus", 10_000),
      event("fable-old", "fable", 10_000, now - WEEK_MS - 1),
      event("fable-before-reset", "fable", 10_000, now - 3 * 24 * 60 * 60 * 1_000),
    ],
    plan,
    official,
    "fable",
    now,
    0,
  );

  assert.deepEqual(result, {
    model: "fable",
    limitPctOfWeek: 50,
    weightedTokens: 400,
    budget: 500,
    usedPct: 80,
  });
});

test("weekly boost expands the Fable sub-limit with the total weekly pool", () => {
  const plan = {
    ...planById("claude-max-20x"),
    weekTokenBudget: 1_000,
  };
  const result = modelWeekLimitFor(
    [event("fable-current", "fable", 50)],
    plan,
    null,
    "fable",
    now,
    100,
  );

  assert.equal(result?.budget, 1_000);
  assert.equal(result?.usedPct, 40);
});

test("plans without a Fable sub-limit return null", () => {
  assert.equal(
    modelWeekLimitFor(
      [event("fable-current", "fable", 50)],
      planById("claude-pro"),
      null,
      "fable",
      now,
      0,
    ),
    null,
  );
});
