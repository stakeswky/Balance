import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrateFromSamples,
  eventsInWindow,
  makeSample,
  mergeSamples,
  normalizeWindowSamples,
  observeWindow,
  officialWindowId,
  quotaValueFor,
  samplesFromOfficialHistory,
  samplesFromOfficial,
  validSlopes,
  windowBounds,
  type QuotaSample,
} from "./quota-value.ts";
import type { OfficialSlice } from "./official.ts";
import type { UsageEvent } from "./types.ts";

function ev(partial: Partial<UsageEvent> & { ts: number }): UsageEvent {
  return {
    id: partial.id ?? `e-${partial.ts}`,
    agent: partial.agent ?? "codex",
    model: partial.model ?? "gpt-5.4",
    modelRaw: partial.modelRaw ?? "gpt-5.4",
    ts: partial.ts,
    sessionId: partial.sessionId ?? "s",
    task: partial.task ?? "t",
    tokensIn: partial.tokensIn ?? 0,
    tokensOut: partial.tokensOut ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
    cacheWrite1h: partial.cacheWrite1h,
    cacheWriteUnsplit: partial.cacheWriteUnsplit,
    reasoningMin: 0,
  };
}

function sample(partial: Partial<QuotaSample> & Pick<QuotaSample, "usedPercent" | "cumulativeObservedUsd">): QuotaSample {
  return {
    windowId: partial.windowId ?? "codex:weekly:_:100:200",
    agent: partial.agent ?? "codex",
    product: partial.product ?? null,
    timestampMs: partial.timestampMs ?? 1,
    usedPercent: partial.usedPercent,
    cumulativeObservedUsd: partial.cumulativeObservedUsd,
    pricedTokenCoverage: partial.pricedTokenCoverage ?? 1,
    modelMix: partial.modelMix ?? { "gpt-5.4": 1 },
    pricingVersion: partial.pricingVersion ?? "2026-08-20-synq-1",
  };
}

const slice = (partial: Partial<OfficialSlice>): OfficialSlice => ({
  agent: "codex",
  windowPct: 10,
  weekPct: 58,
  windowResetsAt: 2_000_000,
  weekResetsAt: 8_000_000,
  weekStartedAt: 1_000_000,
  windowDurationMs: 5 * 60 * 60 * 1000,
  weekDurationMs: 7 * 24 * 60 * 60 * 1000,
  burnPctPerHour: 1,
  planLabel: "ChatGPT Pro",
  products: [],
  prepaidBalance: null,
  onDemandUsed: null,
  onDemandCap: null,
  source: "wham-usage",
  fetchedAt: 1_500_000,
  windowKind: "weekly",
  ...partial,
});

test("unsplit Claude cache writes lower priced token coverage", () => {
  const observed = observeWindow([
    ev({
      agent: "claude",
      model: "opus",
      modelRaw: "claude-opus-5",
      ts: 1,
      tokensIn: 100,
      cacheWrite: 900,
      cacheWriteUnsplit: true,
    }),
  ]);
  assert.equal(observed.observedTokens, 1000);
  assert.equal(observed.pricedTokens, 100);
  assert.equal(observed.pricedTokenCoverage, 0.1);
});

test("same-window differential yields usdPerPct", () => {
  const slopes = validSlopes([
    sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
    sample({ timestampMs: 2, usedPercent: 20, cumulativeObservedUsd: 8.6 }),
  ]);
  assert.equal(slopes.length, 1);
  assert.ok(Math.abs(slopes[0]!.value - 0.46) < 1e-12);
  assert.equal(slopes[0]!.external, false);
});

test("1% rounding noise cannot reach medium or high confidence", () => {
  const cal = calibrateFromSamples(
    [
      sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
      sample({ timestampMs: 2, usedPercent: 11, cumulativeObservedUsd: 4.46 }),
    ],
    11,
    false,
  );
  assert.notEqual(cal.confidence, "medium");
  assert.notEqual(cal.confidence, "high");
});

test("low confidence needs at least 2 percent of valid slope", () => {
  const cal = calibrateFromSamples(
    [
      sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
      sample({ timestampMs: 2, usedPercent: 12, cumulativeObservedUsd: 4.92 }),
    ],
    12,
    false,
  );
  assert.equal(cal.confidence, "low");
});

test("MAD drops extreme slopes", () => {
  const rows: QuotaSample[] = [];
  for (let i = 0; i < 7; i++) {
    rows.push(
      sample({
        timestampMs: i,
        usedPercent: 10 + i * 3,
        cumulativeObservedUsd: (10 + i * 3) * 0.46,
      }),
    );
  }
  rows.push(sample({ timestampMs: 9, usedPercent: 40, cumulativeObservedUsd: 400 }));
  const slopes = validSlopes(rows).filter((s) => !s.external);
  const cal = calibrateFromSamples(rows, 40, false);
  assert.ok(slopes.some((s) => s.value > 10));
  assert.ok(cal.totalPointUsd != null);
  assert.ok(Math.abs(cal.totalPointUsd / 100 - 0.46) < 0.05);
});

test("percent up and local usd flat is external usage", () => {
  const slopes = validSlopes([
    sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 5 }),
    sample({ timestampMs: 2, usedPercent: 18, cumulativeObservedUsd: 5 }),
  ]);
  assert.equal(slopes[0]?.external, true);
  const cal = calibrateFromSamples(
    [
      sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 5 }),
      sample({ timestampMs: 2, usedPercent: 18, cumulativeObservedUsd: 5 }),
    ],
    18,
    false,
  );
  assert.equal(cal.confidence, "none");
  assert.equal(cal.externalUsageDetected, true);
});

test("model-mix drift above 0.35 stops L2", () => {
  const cal = calibrateFromSamples(
    [
      sample({
        timestampMs: 1,
        usedPercent: 10,
        cumulativeObservedUsd: 4,
        modelMix: { a: 1 },
        agent: "claude",
      }),
      sample({
        timestampMs: 2,
        usedPercent: 20,
        cumulativeObservedUsd: 9,
        modelMix: { a: 1 },
        agent: "claude",
      }),
      sample({
        timestampMs: 3,
        usedPercent: 30,
        cumulativeObservedUsd: 14,
        modelMix: { a: 1 },
        agent: "claude",
      }),
      sample({
        timestampMs: 4,
        usedPercent: 40,
        cumulativeObservedUsd: 19,
        modelMix: { a: 14 / 19, b: 5 / 19 },
        agent: "claude",
      }),
    ],
    40,
    false,
  );
  assert.equal(cal.confidence, "none");
  assert.equal(cal.totalPointUsd, null);
});

test("calibration reuses historical intervals compatible with the current model mix", () => {
  const rows = [
    sample({ agent: "claude", timestampMs: 1, usedPercent: 0, cumulativeObservedUsd: 0, modelMix: {} }),
    sample({ agent: "claude", timestampMs: 2, usedPercent: 2, cumulativeObservedUsd: 6, modelMix: { a: 1 } }),
    sample({ agent: "claude", timestampMs: 3, usedPercent: 4, cumulativeObservedUsd: 12, modelMix: { a: 0.5, b: 0.5 } }),
    sample({ agent: "claude", timestampMs: 4, usedPercent: 6, cumulativeObservedUsd: 18, modelMix: { a: 1 / 3, b: 2 / 3 } }),
    sample({ agent: "claude", timestampMs: 5, usedPercent: 8, cumulativeObservedUsd: 24, modelMix: { a: 0.25, b: 0.75 } }),
    sample({ agent: "claude", timestampMs: 6, usedPercent: 10, cumulativeObservedUsd: 30, modelMix: { a: 0.2, b: 0.8 } }),
  ];
  const cal = calibrateFromSamples(rows, 10, false);
  assert.equal(cal.confidence, "medium");
  assert.equal(cal.totalPointUsd, 300);
});

test("reset and pricing version changes do not mix samples", () => {
  const slopes = validSlopes([
    sample({ windowId: "w1", timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
    sample({ windowId: "w2", timestampMs: 2, usedPercent: 20, cumulativeObservedUsd: 9 }),
    sample({
      windowId: "w2",
      timestampMs: 3,
      usedPercent: 30,
      cumulativeObservedUsd: 14,
      pricingVersion: "other",
    }),
  ]);
  assert.equal(slopes.length, 0);
});

test("spec §16 interval is shown not a single remaining point", () => {
  const cal = calibrateFromSamples(
    [
      sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
      sample({ timestampMs: 2, usedPercent: 20, cumulativeObservedUsd: 8.6 }),
      sample({ timestampMs: 3, usedPercent: 30, cumulativeObservedUsd: 13.8 }),
      sample({ timestampMs: 4, usedPercent: 40, cumulativeObservedUsd: 18.4 }),
    ],
    58,
    false,
  );
  assert.ok(cal.totalLowUsd != null && cal.totalHighUsd != null && cal.totalPointUsd != null);
  assert.ok(cal.totalHighUsd > cal.totalLowUsd);
  assert.ok(cal.remainingHighUsd! > cal.remainingLowUsd!);
  assert.ok(cal.totalHighUsd - cal.totalLowUsd >= 0.3 * cal.totalPointUsd - 1e-6);
});

test("rolling fallback never becomes high confidence", () => {
  const cal = calibrateFromSamples(
    [
      sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
      sample({ timestampMs: 2, usedPercent: 40, cumulativeObservedUsd: 20 }),
    ],
    40,
    true,
  );
  assert.equal(cal.confidence, "none");
});

test("events before startsAt stay outside the window", () => {
  const events = [
    ev({ ts: 50, tokensIn: 1000, tokensOut: 10 }),
    ev({ ts: 150, tokensIn: 1000, tokensOut: 10 }),
    ev({ ts: 250, tokensIn: 1000, tokensOut: 10 }),
  ];
  const inside = eventsInWindow(events, "codex", 100, 200);
  assert.equal(inside.length, 1);
  assert.equal(inside[0]?.ts, 150);
});

test("Grok weekly window prefers weekStartedAt over now-7d", () => {
  const now = 1_500_000;
  const bounds = windowBounds(
    slice({ agent: "grok", weekStartedAt: 1_000_000, weekResetsAt: 8_000_000 }),
    "weekly",
    now,
  );
  assert.equal(bounds.start, 1_000_000);
  assert.equal(bounds.rolling, false);
});

test("only resetsAt infers 5h start", () => {
  const now = 10_000_000;
  const resets = now + 1_000_000;
  const bounds = windowBounds(slice({ windowResetsAt: resets, weekStartedAt: null }), "five_hour", now);
  assert.equal(bounds.start, resets - 5 * 60 * 60 * 1000);
  assert.equal(bounds.rolling, false);
});

test("expired 5h resetsAt rolls forward to the current window", () => {
  const span = 5 * 60 * 60 * 1000;
  const firstReset = 2_000_000;
  const now = firstReset + span * 2 + 10_000;
  const bounds = windowBounds(
    slice({ windowResetsAt: firstReset, windowDurationMs: span, weekStartedAt: null }),
    "five_hour",
    now,
  );
  assert.equal(bounds.rolling, false);
  assert.equal(bounds.start, firstReset + span * 2);
  assert.equal(bounds.resetsAt, firstReset + span * 3);
  assert.ok(bounds.start <= now && now < bounds.resetsAt!);
});

test("windowBounds uses the official duration", () => {
  const duration = 3 * 24 * 60 * 60 * 1000;
  const bounds = windowBounds(
    slice({
      weekStartedAt: null,
      weekResetsAt: 8_000_000,
      weekDurationMs: duration,
    }),
    "weekly",
    7_000_000,
  );
  assert.equal(bounds.start, 8_000_000 - duration);
  assert.equal(bounds.rolling, false);
});

test("windowId changes after reset", () => {
  const a = officialWindowId("claude", "five_hour", null, 1, 2);
  const b = officialWindowId("claude", "five_hour", null, 3, 4);
  assert.notEqual(a, b);
});

test("quotaValueFor keeps L1 when L2 is none", () => {
  const now = 1_600_000;
  const events = [ev({ ts: 1_200_000, tokensIn: 331, cacheRead: 27008, tokensOut: 807 })];
  const value = quotaValueFor(events, "codex", slice({ weekStartedAt: 1_000_000 }), "weekly", now, []);
  assert.ok(value.l1Usd > 0);
  assert.equal(value.confidence, "none");
  assert.equal(value.totalPointUsd, null);
  assert.equal(value.rolling, false);
});

test("mergeSamples replaces same percent and caps windows per agent", () => {
  let rows: QuotaSample[] = [];
  for (let w = 0; w < 10; w++) {
    rows = mergeSamples(
      rows,
      sample({
        windowId: `codex:weekly:_:${w}:${w + 1}`,
        timestampMs: w,
        usedPercent: 10,
        cumulativeObservedUsd: w,
      }),
    );
  }
  const ids = new Set(rows.map((s) => s.windowId));
  assert.equal(ids.size, 8);
  const updated = mergeSamples(
    rows,
    sample({
      windowId: rows[rows.length - 1]!.windowId,
      timestampMs: 99,
      usedPercent: 10,
      cumulativeObservedUsd: 99,
    }),
  );
  const last = updated.filter((s) => s.windowId === rows[rows.length - 1]!.windowId).at(-1);
  assert.equal(last?.cumulativeObservedUsd, 99);
  assert.equal(updated.filter((s) => s.windowId === last?.windowId).length, 1);
});

test("Claude weekly window survives more than eight five-hour windows", () => {
  let rows: QuotaSample[] = [];
  rows = mergeSamples(
    rows,
    sample({
      agent: "claude",
      windowId: "claude:weekly:_:100:200",
      timestampMs: 1,
      usedPercent: 1,
      cumulativeObservedUsd: 1,
    }),
  );
  for (let index = 0; index < 10; index += 1) {
    rows = mergeSamples(
      rows,
      sample({
        agent: "claude",
        windowId: `claude:five_hour:_:${index}:${index + 1}`,
        timestampMs: index + 2,
        usedPercent: 1,
        cumulativeObservedUsd: index + 2,
      }),
    );
  }
  assert.ok(rows.some((row) => row.windowId === "claude:weekly:_:100:200"));
  assert.equal(new Set(rows.filter((row) => row.windowId.includes(":five_hour:")).map((row) => row.windowId)).size, 8);
});

test("samplesFromOfficial skips rolling windows", () => {
  const now = Date.now();
  const events = [ev({ ts: now - 1000, tokensIn: 331, cacheRead: 10, tokensOut: 10 })];
  const samples = samplesFromOfficial(
    events,
    {
      claude: slice({
        agent: "claude",
        weekPct: 20,
        weekStartedAt: null,
        weekResetsAt: null,
        windowResetsAt: null,
        windowPct: 5,
      }),
      grok: null,
      codex: null,
    },
    now,
    [],
  );
  assert.equal(samples.length, 0);
});

test("makeSample coverage drops when a model is unknown", () => {
  const s = makeSample({
    windowId: "w",
    agent: "codex",
    timestampMs: 1,
    usedPercent: 10,
    events: [
      ev({ ts: 1, tokensIn: 100, tokensOut: 10, modelRaw: "gpt-5.4" }),
      ev({ id: "u", ts: 2, tokensIn: 100, tokensOut: 10, modelRaw: "mystery-model-99", model: "gpt-5.6-sol" }),
    ],
  });
  assert.ok(s);
  assert.ok(s!.pricedTokenCoverage < 1);
  assert.ok(s!.pricedTokenCoverage > 0.3);
});

test("stale concurrent percentages cannot create duplicate or backward slopes", () => {
  const normalized = normalizeWindowSamples([
    sample({ timestampMs: 1, usedPercent: 57, cumulativeObservedUsd: 10 }),
    sample({ timestampMs: 2, usedPercent: 58, cumulativeObservedUsd: 18 }),
    sample({ timestampMs: 3, usedPercent: 57, cumulativeObservedUsd: 19 }),
    sample({ timestampMs: 4, usedPercent: 58, cumulativeObservedUsd: 20 }),
    sample({ timestampMs: 5, usedPercent: 59, cumulativeObservedUsd: 28 }),
  ]);
  assert.deepEqual(normalized.map((s) => s.usedPercent), [57, 58, 59]);
  assert.equal(normalized[1]!.cumulativeObservedUsd, 20);
  assert.equal(validSlopes(normalized).length, 2);
});

test("normalization never mixes reset windows", () => {
  const normalized = normalizeWindowSamples([
    sample({ windowId: "w1", timestampMs: 1, usedPercent: 90, cumulativeObservedUsd: 90 }),
    sample({ windowId: "w2", timestampMs: 2, usedPercent: 2, cumulativeObservedUsd: 2 }),
    sample({ windowId: "w2", timestampMs: 3, usedPercent: 3, cumulativeObservedUsd: 3 }),
  ]);
  assert.deepEqual(normalized.map((s) => [s.windowId, s.usedPercent]), [
    ["w1", 90],
    ["w2", 2],
    ["w2", 3],
  ]);
});

test("claude 5h history replay can reach medium confidence", () => {
  const start = Date.parse("2026-08-19T15:52:00Z");
  const reset = start + 5 * 60 * 60 * 1000;
  const events = [0, 1, 2, 3, 4, 5].map((i) =>
    ev({
      id: `c${i}`,
      agent: "claude",
      model: "opus",
      modelRaw: "claude-opus-4-6",
      ts: start + (i + 1) * 10 * 60_000,
      tokensIn: 20_000,
      tokensOut: 4_000,
    }),
  );
  const history = [1, 2, 3, 4, 5, 6].map((fh, index) =>
    slice({
      agent: "claude",
      windowPct: fh,
      weekPct: 20,
      windowResetsAt: reset,
      weekStartedAt: null,
      weekResetsAt: null,
      windowKind: "five_hour",
      fetchedAt: start + (index + 1) * 10 * 60_000 + 1_000,
    }),
  );
  const rows = samplesFromOfficialHistory(events, history, []);
  assert.ok(rows.length >= 3);
  const value = quotaValueFor(events, "claude", history.at(-1), "five_hour", reset - 1_000, rows);
  assert.ok(value.confidence === "medium" || value.confidence === "high" || value.confidence === "low");
  assert.ok(value.l1Usd > 0);
});

test("official history backfills same-window cumulative observations", () => {
  const start = Date.parse("2026-08-13T00:00:00Z");
  const reset = Date.parse("2026-08-20T00:00:00Z");
  const events = [
    ev({ id: "a", ts: start + 1_000, tokensIn: 100_000, tokensOut: 1_000 }),
    ev({ id: "b", ts: start + 2_000, tokensIn: 100_000, tokensOut: 1_000 }),
    ev({ id: "c", ts: start + 3_000, tokensIn: 100_000, tokensOut: 1_000 }),
  ];
  const history = [57, 58, 59].map((usedPercent, index) =>
    slice({
      windowPct: null,
      windowResetsAt: null,
      windowDurationMs: null,
      weekPct: usedPercent,
      weekStartedAt: start,
      weekResetsAt: reset,
      weekDurationMs: reset - start,
      fetchedAt: start + (index + 1) * 1_000 + 500,
      windowKind: "weekly",
    }),
  );
  const rows = samplesFromOfficialHistory(events, history, []);
  assert.deepEqual(rows.map((s) => s.usedPercent), [57, 58, 59]);
  assert.ok(rows[0]!.cumulativeObservedUsd < rows[1]!.cumulativeObservedUsd);
  assert.ok(rows[1]!.cumulativeObservedUsd < rows[2]!.cumulativeObservedUsd);
});

test("calibration ignores partial first and current percent plateaus", () => {
  const rows = [
    sample({ timestampMs: 1, usedPercent: 54, cumulativeObservedUsd: 0.48, modelMix: { "gpt-5.6-sol": 1 } }),
    sample({ timestampMs: 2, usedPercent: 56, cumulativeObservedUsd: 0.72, modelMix: { "gpt-5.6-sol": 1 } }),
    sample({ timestampMs: 3, usedPercent: 57, cumulativeObservedUsd: 5.56, modelMix: { "gpt-5.6-sol": 0.51, "gpt-5.4": 0.49 } }),
    sample({ timestampMs: 4, usedPercent: 58, cumulativeObservedUsd: 13.52, modelMix: { "gpt-5.6-sol": 0.53, "gpt-5.4": 0.47 } }),
    sample({ timestampMs: 5, usedPercent: 59, cumulativeObservedUsd: 21.99, modelMix: { "gpt-5.6-sol": 0.63, "gpt-5.4": 0.37 } }),
    sample({ timestampMs: 6, usedPercent: 60, cumulativeObservedUsd: 31.22, modelMix: { "gpt-5.6-sol": 0.61, "gpt-5.4": 0.39 } }),
    sample({ timestampMs: 7, usedPercent: 61, cumulativeObservedUsd: 35.82, modelMix: { "gpt-5.6-sol": 0.65, "gpt-5.4": 0.35 } }),
  ];
  const cal = calibrateFromSamples(rows, 61, false);
  assert.equal(cal.confidence, "low");
  assert.ok(cal.totalLowUsd != null && cal.totalLowUsd > 700);
  assert.ok(cal.totalHighUsd != null && cal.totalHighUsd < 1_100);
  assert.ok(cal.remainingLowUsd != null && cal.remainingLowUsd > 250);
});

test("calibration ignores an empty bootstrap model mix", () => {
  const rows = [
    sample({ agent: "grok", timestampMs: 1, usedPercent: 0, cumulativeObservedUsd: 0, modelMix: {} }),
    sample({ agent: "grok", timestampMs: 2, usedPercent: 2, cumulativeObservedUsd: 6, modelMix: { "grok-4.6": 1 } }),
    sample({ agent: "grok", timestampMs: 3, usedPercent: 4, cumulativeObservedUsd: 12, modelMix: { "grok-4.6": 1 } }),
    sample({ agent: "grok", timestampMs: 4, usedPercent: 6, cumulativeObservedUsd: 18, modelMix: { "grok-4.6": 1 } }),
    sample({ agent: "grok", timestampMs: 5, usedPercent: 8, cumulativeObservedUsd: 24, modelMix: { "grok-4.6": 1 } }),
    sample({ agent: "grok", timestampMs: 6, usedPercent: 10, cumulativeObservedUsd: 30, modelMix: { "grok-4.6": 1 } }),
  ];
  const cal = calibrateFromSamples(rows, 10, false);
  assert.equal(cal.confidence, "medium");
  assert.equal(cal.totalPointUsd, 300);
});

test("Codex quota value exposes public credit equivalents", () => {
  const now = 1_600_000;
  const official = slice({ weekStartedAt: 1_000_000, weekResetsAt: 8_000_000, weekPct: 40 });
  const windowId = officialWindowId("codex", "weekly", null, 1_000_000, 8_000_000);
  const samples = [
    sample({ windowId, timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 4 }),
    sample({ windowId, timestampMs: 2, usedPercent: 20, cumulativeObservedUsd: 8.6 }),
    sample({ windowId, timestampMs: 3, usedPercent: 30, cumulativeObservedUsd: 13.8 }),
    sample({ windowId, timestampMs: 4, usedPercent: 40, cumulativeObservedUsd: 18.4 }),
  ];
  const value = quotaValueFor(
    [ev({ ts: 1_200_000, tokensIn: 100_000, tokensOut: 1_000 })],
    "codex",
    official,
    "weekly",
    now,
    samples,
  );
  assert.ok(value.l1Credits != null);
  assert.ok(Math.abs(value.l1Credits - value.l1Usd * 25) < 1e-9);
  assert.ok(value.totalLowCredits != null && value.totalLowUsd != null);
  assert.ok(Math.abs(value.totalLowCredits - value.totalLowUsd * 25) < 1e-9);
  assert.ok(value.remainingHighCredits != null && value.remainingHighUsd != null);
  assert.ok(Math.abs(value.remainingHighCredits - value.remainingHighUsd * 25) < 1e-9);
});

test("non-Codex quota does not claim OpenAI credits", () => {
  const now = 1_600_000;
  const official = slice({ agent: "claude", weekStartedAt: 1_000_000, weekResetsAt: 8_000_000 });
  const value = quotaValueFor([], "claude", official, "weekly", now, []);
  assert.equal(value.l1Credits, null);
  assert.equal(value.totalLowCredits, null);
  assert.equal(value.remainingHighCredits, null);
});
