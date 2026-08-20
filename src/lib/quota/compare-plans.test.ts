import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePlans } from "./engine.ts";
import { planById } from "./plans.ts";
import type { MeterSnapshot, UsageEvent } from "./types.ts";

const now = Date.parse("2026-08-20T12:00:00Z");

function usageEvent(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "e1",
    agent: "claude",
    model: "fable",
    ts: now - 60_000,
    sessionId: "s1",
    task: "sync quotas",
    tokensIn: 5_500,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
    ...partial,
  };
}

function meter(partial: Partial<MeterSnapshot>): MeterSnapshot {
  return {
    agent: "claude",
    windowPct: 0,
    weekPct: 0,
    windowTokens: 0,
    weekTokens: 0,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    windowBudget: 1,
    weekBudget: 1,
    windowResetsAt: now,
    weekResetsAt: now,
    burnPctPerHour: 0,
    etaMs: null,
    apiUsdWindow: 0,
    apiUsdWeek: 0,
    status: "ok",
    ...partial,
  };
}

test("comparePlans falls back to local percentages without an official baseline", () => {
  const rows = comparePlans(
    [usageEvent()],
    "claude",
    [planById("claude-max-5x"), planById("claude-max-20x")],
    now,
    0,
  );

  assert.equal(rows[0]?.plan.id, "claude-max-5x");
  assert.equal(rows[0]?.windowPct, 50);
  assert.equal(rows[0]?.weekPct, 2);
  assert.equal(rows[1]?.plan.id, "claude-max-20x");
  assert.equal(rows[1]?.windowPct, 20);
  assert.equal(rows[1]?.weekPct, 0.5);
});

test("comparePlans anchors the current plan to official usage and scales alternatives", () => {
  const rows = comparePlans(
    [usageEvent()],
    "claude",
    [planById("claude-max-5x"), planById("claude-max-20x")],
    now,
    0,
    {
      currentPlanId: "claude-max-20x",
      currentMeter: meter({ windowPct: 8, weekPct: 0.2 }),
    },
  );

  const max5x = rows.find((row) => row.plan.id === "claude-max-5x");
  const max20x = rows.find((row) => row.plan.id === "claude-max-20x");
  assert.ok(max5x);
  assert.ok(max20x);
  assert.equal(max20x.windowPct, 8);
  assert.equal(max20x.weekPct, 0.2);
  assert.ok(Math.abs(max5x.windowPct - 20) < 1e-9);
  assert.ok(Math.abs(max5x.weekPct - 0.8) < 1e-9);
});
