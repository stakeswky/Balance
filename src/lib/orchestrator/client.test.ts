import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfficialSlice } from "../quota/official.ts";
import type { QuotaValue, ValueConfidence } from "../quota/quota-value.ts";
import { buildQuotaCapacityEvidence } from "./client.ts";

const NOW = Date.UTC(2026, 7, 24, 16, 0, 0);

function value(input: {
  confidence: ValueConfidence;
  remainingLowUsd: number | null;
  totalHighUsd: number | null;
}): QuotaValue {
  return {
    ...input,
    usedPct: 0,
    l1Usd: 0,
    l1Credits: null,
    l1Tokens: 0,
    pricedTokenCoverage: 0,
    pricedEventCoverage: 0,
    rolling: false,
    windowId: "test",
    totalLowUsd: null,
    totalPointUsd: null,
    remainingPointUsd: null,
    remainingHighUsd: null,
    totalLowCredits: null,
    totalPointCredits: null,
    totalHighCredits: null,
    remainingLowCredits: null,
    remainingPointCredits: null,
    remainingHighCredits: null,
    calibrationSource: "none",
    pricingVersion: "test",
    externalUsageDetected: false,
    anomalousPairs: 0,
    historyComplete: true,
  };
}

function official(patch: Partial<OfficialSlice>): OfficialSlice {
  return {
    agent: "codex",
    windowPct: null,
    weekPct: null,
    windowResetsAt: null,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: null,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "test",
    fetchedAt: NOW,
    windowKind: "five_hour",
    ...patch,
  };
}

test("capacity evidence selects the tighter trustworthy dollar interval", () => {
  const result = buildQuotaCapacityEvidence(
    value({ confidence: "high", remainingLowUsd: 20, totalHighUsd: 100 }),
    value({ confidence: "medium", remainingLowUsd: 5, totalHighUsd: 100 }),
    official({ windowPct: 90, weekPct: 70 }),
    NOW,
  );
  assert.deepEqual(result, {
    officialRemainingPct: 10,
    officialObservedAt: NOW,
    officialResetsAt: null,
    officialFresh: true,
    officialSource: "test",
    l3RemainingPct: 5,
    l3Confidence: "medium",
    l3ObservedAt: NOW,
  });
});

test("capacity evidence ignores low-confidence intervals and stale official windows", () => {
  const result = buildQuotaCapacityEvidence(
    value({ confidence: "low", remainingLowUsd: 50, totalHighUsd: 100 }),
    value({ confidence: "none", remainingLowUsd: null, totalHighUsd: null }),
    official({ windowPct: 99, windowStale: true, weekPct: 60, weekStale: false }),
    NOW,
  );
  assert.deepEqual(result, {
    officialRemainingPct: 40,
    officialObservedAt: NOW,
    officialResetsAt: null,
    officialFresh: true,
    officialSource: "test",
    l3RemainingPct: null,
    l3Confidence: "none",
    l3ObservedAt: null,
  });
});

test("capacity evidence stays unknown when all evidence is unusable", () => {
  const result = buildQuotaCapacityEvidence(
    value({ confidence: "high", remainingLowUsd: -1, totalHighUsd: 100 }),
    value({ confidence: "high", remainingLowUsd: 1, totalHighUsd: 0 }),
    official({ windowPct: null, weekPct: 80, weekStale: true }),
    NOW,
  );
  assert.deepEqual(result, {
    officialRemainingPct: null,
    officialObservedAt: null,
    officialResetsAt: null,
    officialFresh: false,
    officialSource: null,
    l3RemainingPct: null,
    l3Confidence: "none",
    l3ObservedAt: null,
  });
});
