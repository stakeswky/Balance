import assert from "node:assert/strict";
import { test } from "node:test";
import { modelWeekLimitFor } from "./engine.ts";
import type { OfficialSlice } from "./official.ts";
import { planById } from "./plans.ts";

const now = Date.parse("2026-08-20T12:00:00Z");
const fableResetsAt = now + 5 * 24 * 60 * 60 * 1000;

const official: OfficialSlice = {
  agent: "claude",
  windowPct: 10,
  weekPct: 20,
  windowResetsAt: now + 60_000,
  weekResetsAt: fableResetsAt,
  weekStartedAt: now - 2 * 24 * 60 * 60 * 1000,
  windowDurationMs: 5 * 60 * 60 * 1000,
  weekDurationMs: 7 * 24 * 60 * 60 * 1000,
  burnPctPerHour: 0,
  planLabel: "max",
  products: [],
  prepaidBalance: null,
  onDemandUsed: null,
  onDemandCap: null,
  modelWeekLimits: { fable: { usedPct: 24, resetsAt: fableResetsAt } },
  source: "oauth-usage",
  fetchedAt: now,
  windowKind: "five_hour",
};

test("Claude Max plans expose a 50% Fable weekly sub-limit", () => {
  assert.equal(planById("claude-max-5x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-max-20x").modelWeekLimitPct?.fable, 50);
  assert.equal(planById("claude-pro").modelWeekLimitPct?.fable, undefined);
  assert.equal(planById("claude-api").modelWeekLimitPct?.fable, undefined);
});

test("Fable weekly limit uses the official percent instead of local tokens", () => {
  assert.deepEqual(modelWeekLimitFor(planById("claude-max-5x"), official, "fable"), {
    model: "fable",
    limitPctOfWeek: 50,
    usedPct: 24,
    resetsAt: fableResetsAt,
  });
});

test("Fable weekly limit is hidden when official data is unavailable", () => {
  assert.equal(modelWeekLimitFor(planById("claude-max-20x"), null, "fable"), null);
  const withoutFable = structuredClone(official);
  withoutFable.modelWeekLimits = undefined;
  assert.equal(modelWeekLimitFor(planById("claude-max-20x"), withoutFable, "fable"), null);
});

test("plans without a Fable sub-limit ignore an official Fable value", () => {
  assert.equal(modelWeekLimitFor(planById("claude-pro"), official, "fable"), null);
});
