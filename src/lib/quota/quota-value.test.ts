import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrateFromSamples,
  eventsInWindow,
  historicalWindowPrior,
  makeSample,
  mergeSamples,
  normalizeWindowSamples,
  observeWindow,
  officialWindowId,
  quotaValueFor,
  sameOfficialWindowId,
  samplesFromOfficialHistory,
  samplesFromOfficial,
  validSlopes,
  weightedMedian,
  windowBounds,
  type QuotaSample,
} from "./quota-value.ts";
import { costBreakdown } from "./cost.ts";
import type { OfficialSlice } from "./official.ts";
import type { UsageEvent } from "./types.ts";
import { WINDOW_MS } from "./types.ts";
import { PRICING_VERSION } from "./pricing.ts";

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
    anomalies: partial.anomalies,
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
    pricingVersion: partial.pricingVersion ?? PRICING_VERSION,
    planLabel: partial.planLabel ?? null,
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

test("anomalous token events remain observable and are not priced", () => {
  const event = ev({
    ts: 1,
    tokensIn: 10,
    anomalies: [{ code: "negative-token", field: "output_tokens", rawValue: "-1" }],
  });
  assert.equal(costBreakdown(event).priced, false);
  assert.equal(observeWindow([event]).pricedTokenCoverage, 0);
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

test("expired 5h resetsAt falls back to rolling instead of tiling forward", () => {
  const span = 5 * 60 * 60 * 1000;
  const firstReset = 2_000_000;
  const now = firstReset + span * 2 + 10_000;
  const bounds = windowBounds(
    slice({ windowResetsAt: firstReset, windowDurationMs: span, weekStartedAt: null }),
    "five_hour",
    now,
  );
  assert.equal(bounds.rolling, true);
  assert.equal(bounds.resetsAt, null);
  assert.equal(bounds.start, now - span);
});

test("expired five-hour reset becomes rolling instead of a tiled window", () => {
  const now = Date.parse("2026-08-21T12:00:00Z");
  const official = slice({
    fetchedAt: now - 26 * 60 * 60_000,
    windowPct: 63,
    windowResetsAt: now - 24 * 60 * 60_000,
    windowDurationMs: 5 * 60 * 60_000,
  });
  const bounds = windowBounds(official, "five_hour", now);
  assert.equal(bounds.rolling, true);
  assert.equal(bounds.resetsAt, null);
  assert.equal(bounds.start, now - WINDOW_MS);
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

test("provider reset jitter keeps one quota window identity", () => {
  const claudeA = officialWindowId(
    "claude",
    "weekly",
    null,
    Date.parse("2026-08-17T20:59:59.901Z"),
    Date.parse("2026-08-24T20:59:59.901Z"),
  );
  const claudeB = officialWindowId(
    "claude",
    "weekly",
    null,
    Date.parse("2026-08-17T21:00:00.416Z"),
    Date.parse("2026-08-24T21:00:00.416Z"),
  );
  assert.equal(sameOfficialWindowId(claudeA, claudeB), true);

  const codexResetA = 1_787_815_628_000;
  const codexResetB = 1_787_815_629_000;
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.equal(
    sameOfficialWindowId(
      officialWindowId("codex", "weekly", null, codexResetA - week, codexResetA),
      officialWindowId("codex", "weekly", null, codexResetB - week, codexResetB),
    ),
    true,
  );

  assert.equal(
    sameOfficialWindowId(
      officialWindowId(
        "grok",
        "weekly",
        null,
        Date.parse("2026-08-18T13:28:17.000Z"),
        Date.parse("2026-08-25T13:28:17.000Z"),
      ),
      officialWindowId(
        "grok",
        "weekly",
        null,
        Date.parse("2026-08-18T13:28:17.911Z"),
        Date.parse("2026-08-25T13:28:17.911Z"),
      ),
    ),
    true,
  );
});

test("real quota resets still create a new window identity", () => {
  const start = Date.parse("2026-08-20T00:00:00Z");
  const span = 5 * 60 * 60 * 1000;
  assert.notEqual(
    officialWindowId("claude", "five_hour", null, start, start + span),
    officialWindowId("claude", "five_hour", null, start + span, start + 2 * span),
  );
});

test("window ids one second apart are equivalent", () => {
  const left = officialWindowId("claude", "five_hour", null, 1_725_000_029_500, 1_725_018_029_500);
  const right = officialWindowId("claude", "five_hour", null, 1_725_000_030_500, 1_725_018_030_500);
  assert.equal(sameOfficialWindowId(left, right), true);
});

test("window ids outside tolerance remain isolated", () => {
  const left = officialWindowId("claude", "five_hour", null, 1_725_000_000_000, 1_725_018_000_000);
  const right = officialWindowId("claude", "five_hour", null, 1_725_000_003_000, 1_725_018_003_000);
  assert.equal(sameOfficialWindowId(left, right), false);
});

test("nearby but distinct resets are never merged", () => {
  const left = officialWindowId("claude", "five_hour", null, 1_725_000_000_000, 1_725_018_000_000);
  const right = officialWindowId("claude", "five_hour", null, 1_725_000_089_000, 1_725_018_089_000);
  assert.equal(sameOfficialWindowId(left, right), false);
});

test("legacy jittered sample ids coalesce without losing observations", () => {
  const firstId = "claude:weekly:_:1787000399901:1787605199901";
  const secondId = "claude:weekly:_:1787000400416:1787605200416";
  let rows: QuotaSample[] = [];
  rows = mergeSamples(
    rows,
    sample({
      agent: "claude",
      windowId: firstId,
      timestampMs: 1,
      usedPercent: 10,
      cumulativeObservedUsd: 1,
      modelMix: { opus: 1 },
    }),
  );
  rows = mergeSamples(
    rows,
    sample({
      agent: "claude",
      windowId: secondId,
      timestampMs: 2,
      usedPercent: 12,
      cumulativeObservedUsd: 2,
      modelMix: { opus: 1 },
    }),
  );
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.windowId)).size, 1);
  assert.equal(sameOfficialWindowId(rows[0]!.windowId, secondId), true);

  let codexRows: QuotaSample[] = [];
  codexRows = mergeSamples(
    codexRows,
    sample({
      agent: "codex",
      windowId: "codex:weekly:_:1787210828000:1787815628000",
      timestampMs: 1,
      usedPercent: 5,
      cumulativeObservedUsd: 1,
    }),
  );
  codexRows = mergeSamples(
    codexRows,
    sample({
      agent: "codex",
      windowId: "codex:weekly:_:1787210829000:1787815629000",
      timestampMs: 2,
      usedPercent: 7,
      cumulativeObservedUsd: 2,
    }),
  );
  assert.equal(codexRows.length, 2);
  assert.equal(new Set(codexRows.map((row) => row.windowId)).size, 1);

  const grokStartA = Date.parse("2026-08-18T13:28:17.000Z");
  const grokStartB = Date.parse("2026-08-18T13:28:17.911Z");
  const grokEndA = Date.parse("2026-08-25T13:28:17.000Z");
  const grokEndB = Date.parse("2026-08-25T13:28:17.911Z");
  let grokRows: QuotaSample[] = [];
  grokRows = mergeSamples(
    grokRows,
    sample({
      agent: "grok",
      windowId: `grok:weekly:_:${grokStartA}:${grokEndA}`,
      timestampMs: 1,
      usedPercent: 8,
      cumulativeObservedUsd: 1,
      modelMix: { "grok-4.6": 1 },
    }),
  );
  grokRows = mergeSamples(
    grokRows,
    sample({
      agent: "grok",
      windowId: `grok:weekly:_:${grokStartB}:${grokEndB}`,
      timestampMs: 2,
      usedPercent: 10,
      cumulativeObservedUsd: 2,
      modelMix: { "grok-4.6": 1 },
    }),
  );
  assert.equal(grokRows.length, 2);
  assert.equal(new Set(grokRows.map((row) => row.windowId)).size, 1);
});

test("quotaValueFor reuses legacy jittered samples immediately", () => {
  const value = quotaValueFor(
    [],
    "claude",
    slice({
      agent: "claude",
      weekPct: 24,
      weekStartedAt: 1_787_000_400_416,
      weekResetsAt: 1_787_605_200_416,
    }),
    "weekly",
    1_787_300_000_000,
    [
      sample({
        agent: "claude",
        windowId: "claude:weekly:_:1787000399901:1787605199901",
        timestampMs: 1,
        usedPercent: 10,
        cumulativeObservedUsd: 1,
        modelMix: { opus: 1 },
      }),
      sample({
        agent: "claude",
        windowId: "claude:weekly:_:1787000399901:1787605199901",
        timestampMs: 2,
        usedPercent: 12,
        cumulativeObservedUsd: 2,
        modelMix: { opus: 1 },
      }),
    ],
  );
  assert.equal(value.confidence, "low");
  assert.equal(value.totalPointUsd, 50);
});

test("window identity normalization does not move event boundaries", () => {
  const start = Date.parse("2026-08-17T21:00:00.416Z");
  const reset = Date.parse("2026-08-24T21:00:00.416Z");
  const bounds = windowBounds(
    slice({ agent: "claude", weekStartedAt: start, weekResetsAt: reset }),
    "weekly",
    Date.parse("2026-08-20T00:00:00Z"),
  );
  assert.equal(bounds.start, start);
  assert.equal(bounds.resetsAt, reset);
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
        windowId: `codex:weekly:_:${w * 10_000}:${w * 10_000 + 5_000}`,
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
        windowId: `claude:five_hour:_:${index * 10_000}:${index * 10_000 + 5_000}`,
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
  assert.ok(cal.totalLowUsd != null && cal.totalLowUsd > 500);
  assert.ok(cal.totalHighUsd != null && cal.totalHighUsd < 1_200);
  assert.ok(cal.remainingLowUsd != null && cal.remainingLowUsd > 200);
});

test("external use in the first censored interval is still detected", () => {
  const rows = [
    sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 0 }),
    sample({ timestampMs: 2, usedPercent: 20, cumulativeObservedUsd: 0 }),
    sample({ timestampMs: 3, usedPercent: 30, cumulativeObservedUsd: 5 }),
    sample({ timestampMs: 4, usedPercent: 40, cumulativeObservedUsd: 10 }),
    sample({ timestampMs: 5, usedPercent: 45, cumulativeObservedUsd: 12.5 }),
  ];
  const result = calibrateFromSamples(rows, 45, false);
  assert.equal(result.externalUsageDetected, true);
  assert.notEqual(result.confidence, "high");
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

test("official samples align cumulative cost to fetchedAt", () => {
  const fetchedAt = Date.parse("2026-08-21T10:00:00Z");
  const before = ev({
    id: "before",
    agent: "claude",
    model: "sonnet",
    modelRaw: "claude-sonnet-5",
    ts: fetchedAt - 1_000,
    tokensIn: 1_000_000,
  });
  const after = ev({
    id: "after",
    agent: "claude",
    model: "sonnet",
    modelRaw: "claude-sonnet-5",
    ts: fetchedAt + 1_000,
    tokensIn: 1_000_000,
  });
  const official = slice({
    agent: "claude",
    fetchedAt,
    windowPct: 20,
    weekPct: null,
    windowResetsAt: fetchedAt + 60_000,
    weekResetsAt: null,
    weekStartedAt: null,
  });
  const rows = samplesFromOfficial(
    [before, after],
    { claude: official, grok: null, codex: null },
    fetchedAt + 30_000,
    [],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.timestampMs, fetchedAt);
  assert.equal(rows[0]!.cumulativeObservedUsd, costBreakdown(before).totalUsd);
});

test("stale fields cannot create quota samples", () => {
  const now = Date.parse("2026-08-21T10:00:00Z");
  const official = slice({
    agent: "claude",
    fetchedAt: now - 40 * 60_000,
    windowPct: 80,
    weekPct: 30,
    windowStale: true,
    weekStale: true,
  });
  const rows = samplesFromOfficial(
    [],
    { claude: official, grok: null, codex: null },
    now,
    [],
  );
  assert.deepEqual(rows, []);
});

test("future official timestamps cannot pull future events into a sample", () => {
  const now = Date.parse("2026-08-21T10:00:00Z");
  const official = slice({
    agent: "claude",
    fetchedAt: now + 1,
    windowPct: 20,
    windowResetsAt: now + 60_000,
  });
  assert.deepEqual(
    samplesFromOfficial(
      [],
      { claude: official, grok: null, codex: null },
      now,
      [],
    ),
    [],
  );
});

test("a large same-window percentage drop starts a new calibration segment", () => {
  const rows = normalizeWindowSamples([
    sample({ timestampMs: 1, usedPercent: 55, cumulativeObservedUsd: 80 }),
    sample({ timestampMs: 2, usedPercent: 60, cumulativeObservedUsd: 88 }),
    sample({ timestampMs: 3, usedPercent: 30, cumulativeObservedUsd: 96 }),
    sample({ timestampMs: 4, usedPercent: 45, cumulativeObservedUsd: 118 }),
    sample({ timestampMs: 5, usedPercent: 62, cumulativeObservedUsd: 144 }),
  ]);
  assert.deepEqual(rows.map((row) => row.usedPercent), [55, 60, 30, 45, 62]);
  assert.deepEqual(
    validSlopes(rows).map((row) => [row.segmentId, Number(row.value.toFixed(2))]),
    [[0, 1.6], [1, 1.47], [1, 1.53]],
  );
});

test("drops up to two points are treated as concurrent snapshot jitter", () => {
  const rows = normalizeWindowSamples([
    sample({ timestampMs: 1, usedPercent: 57, cumulativeObservedUsd: 10 }),
    sample({ timestampMs: 2, usedPercent: 60, cumulativeObservedUsd: 18 }),
    sample({ timestampMs: 3, usedPercent: 58, cumulativeObservedUsd: 19 }),
    sample({ timestampMs: 4, usedPercent: 61, cumulativeObservedUsd: 28 }),
  ]);
  assert.deepEqual(rows.map((row) => row.usedPercent), [57, 60, 61]);
});

test("a reset followed by less than one point cannot reuse an older segment", () => {
  const result = calibrateFromSamples([
    sample({ timestampMs: 1, usedPercent: 55, cumulativeObservedUsd: 80 }),
    sample({ timestampMs: 2, usedPercent: 60, cumulativeObservedUsd: 88 }),
    sample({ timestampMs: 3, usedPercent: 30, cumulativeObservedUsd: 96 }),
    sample({ timestampMs: 4, usedPercent: 30.2, cumulativeObservedUsd: 96.3 }),
    sample({ timestampMs: 5, usedPercent: 30.8, cumulativeObservedUsd: 97.2 }),
  ], 30.8, false);
  assert.equal(result.confidence, "none");
  assert.equal(result.totalPointUsd, null);
});

test("cumulative usd regressions are dropped but counted as anomalies", () => {
  const result = calibrateFromSamples([
    sample({ timestampMs: 1, usedPercent: 10, cumulativeObservedUsd: 10 }),
    sample({ timestampMs: 2, usedPercent: 20, cumulativeObservedUsd: 8 }),
    sample({ timestampMs: 3, usedPercent: 30, cumulativeObservedUsd: 13 }),
  ], 30, false);
  assert.equal(result.anomalousPairs, 1);
  assert.equal(result.confidence, "low");
});

test("fractional percentages accumulate into valid anchor-chain slopes", () => {
  const rows: QuotaSample[] = [];
  for (let index = 0; index <= 200; index += 1) {
    const usedPercent = Number((index * 0.2).toFixed(4));
    rows.push(sample({
      timestampMs: index * 30_000,
      usedPercent,
      cumulativeObservedUsd: usedPercent * 0.5,
    }));
  }
  const slopes = validSlopes(rows);
  assert.ok(slopes.length >= 30);
  assert.ok(slopes.every((row) => row.weight >= 1));
  assert.ok(slopes.every((row) => Math.abs(row.value - 0.5) < 1e-9));
  assert.notEqual(calibrateFromSamples(rows, 40, false).confidence, "none");
});

test("coverage failure breaks an anchor chain", () => {
  const rows = [
    sample({ timestampMs: 1, usedPercent: 0, cumulativeObservedUsd: 0 }),
    sample({ timestampMs: 2, usedPercent: 0.6, cumulativeObservedUsd: 0.3 }),
    sample({ timestampMs: 3, usedPercent: 1.2, cumulativeObservedUsd: 0.6, pricedTokenCoverage: 0.5 }),
    sample({ timestampMs: 4, usedPercent: 1.8, cumulativeObservedUsd: 0.9 }),
    sample({ timestampMs: 5, usedPercent: 2.9, cumulativeObservedUsd: 1.45 }),
  ];
  const slopes = validSlopes(rows);
  assert.equal(slopes.length, 1);
  assert.equal(slopes[0]!.segmentId, 1);
  assert.ok(Math.abs(slopes[0]!.weight - 1.1) < 1e-9);
  assert.equal(slopes[0]!.value, 0.5);
});

test("weighted median interpolates an exact half-weight boundary", () => {
  assert.equal(weightedMedian([
    { value: 0.4, weight: 10 },
    { value: 0.6, weight: 10 },
  ]), 0.5);
});

test("weighted MAD keeps high-weight accurate slopes", () => {
  const rows = [sample({ timestampMs: 0, usedPercent: 0, cumulativeObservedUsd: 0 })];
  let pct = 0;
  let usd = 0;
  for (let index = 1; index <= 8; index += 1) {
    pct += 1;
    usd += 0.2;
    rows.push(sample({ timestampMs: index, usedPercent: pct, cumulativeObservedUsd: usd }));
  }
  for (let index = 9; index <= 11; index += 1) {
    pct += 10;
    usd += 5;
    rows.push(sample({ timestampMs: index, usedPercent: pct, cumulativeObservedUsd: usd }));
  }
  const result = calibrateFromSamples(rows, pct, false);
  assert.equal(result.totalPointUsd, 50);
  assert.equal(result.confidence, "low");
});

test("a comparable cheap interval is excluded from the point estimate", () => {
  const rows = [
    sample({ timestampMs: 1, usedPercent: 0, cumulativeObservedUsd: 0 }),
    sample({ timestampMs: 2, usedPercent: 10, cumulativeObservedUsd: 10 }),
    sample({ timestampMs: 3, usedPercent: 20, cumulativeObservedUsd: 20 }),
    sample({ timestampMs: 4, usedPercent: 30, cumulativeObservedUsd: 23.5 }),
    sample({ timestampMs: 5, usedPercent: 40, cumulativeObservedUsd: 33.5 }),
    sample({ timestampMs: 6, usedPercent: 50, cumulativeObservedUsd: 43.5 }),
  ];
  const result = calibrateFromSamples(rows, 50, false);
  assert.equal(result.totalPointUsd, 100);
  assert.notEqual(result.confidence, "high");
});

test("a cheap interval with a changed model mix is not labeled external", () => {
  const cheapMix = { "claude-haiku-4-5": 1 };
  const rows = [
    sample({ timestampMs: 1, usedPercent: 0, cumulativeObservedUsd: 0 }),
    sample({ timestampMs: 2, usedPercent: 10, cumulativeObservedUsd: 10 }),
    sample({ timestampMs: 3, usedPercent: 20, cumulativeObservedUsd: 13.5, modelMix: cheapMix }),
    sample({ timestampMs: 4, usedPercent: 30, cumulativeObservedUsd: 23.5, modelMix: cheapMix }),
  ];
  const result = calibrateFromSamples(rows, 30, false);
  assert.equal(result.externalUsageDetected, false);
});

test("a cheap interval with unknown model mix is retained but capped low", () => {
  const cumulative = [0, 10, 20, 23.5, 33.5, 43.5, 53.5];
  const rows = [0, 10, 20, 30, 40, 50, 60].map((usedPercent, index) =>
    sample({
      timestampMs: index + 1,
      usedPercent,
      cumulativeObservedUsd: cumulative[index]!,
      modelMix: {},
    }),
  );
  const result = calibrateFromSamples(rows, 60, false);
  assert.equal(result.externalUsageDetected, false);
  assert.equal(result.confidence, "low");
});

test("low-confidence quantization band is at least one over cumulative percent", () => {
  const rows = [
    sample({ timestampMs: 1, usedPercent: 0, cumulativeObservedUsd: 0 }),
    sample({ timestampMs: 2, usedPercent: 2, cumulativeObservedUsd: 1 }),
  ];
  const result = calibrateFromSamples(rows, 2, false);
  assert.equal(result.confidence, "low");
  assert.equal(result.totalPointUsd, 50);
  assert.equal(result.totalLowUsd, 25);
  assert.equal(result.totalHighUsd, 75);
});

test("a stable previous window supplies only a low-confidence prior", () => {
  const previousId = "codex:five_hour:_:1000000000000:1000018000000";
  const previous = [0, 5, 10, 15].map((usedPercent, index) => sample({
    windowId: previousId,
    timestampMs: index + 1,
    usedPercent,
    cumulativeObservedUsd: usedPercent * 0.5,
    modelMix: { "gpt-5.6-sol": 1 },
    planLabel: "ChatGPT Plus",
  }));
  const now = Date.parse("2026-08-21T10:00:00Z");
  const official = slice({
    agent: "codex",
    planLabel: "ChatGPT Plus",
    fetchedAt: now,
    windowPct: 1,
    windowResetsAt: now + WINDOW_MS,
    windowDurationMs: WINDOW_MS,
  });
  const current = ev({
    agent: "codex",
    model: "gpt-5.6-sol",
    modelRaw: "gpt-5.6-sol",
    tokensIn: 1_000_000,
    ts: now,
  });
  const result = quotaValueFor([current], "codex", official, "five_hour", now, previous);
  assert.equal(result.calibrationSource, "historical-prior");
  assert.equal(result.confidence, "low");
  assert.equal(result.totalPointUsd, 50);
});

test("historical prior selects the three newest windows regardless of input order", () => {
  // Window ID anchors must differ by more than WINDOW_ID_TOLERANCE_MS (2000)
  // so sameOfficialWindowId treats them as distinct windows.
  const rows = (windowId: string, at: number, usdPerPct: number) =>
    [0, 5, 10, 15].map((usedPercent, index) => sample({
      windowId,
      timestampMs: at + index,
      usedPercent,
      cumulativeObservedUsd: usedPercent * usdPerPct,
      modelMix: { "gpt-5.6-sol": 1 },
      planLabel: "ChatGPT Plus",
    }));
  const samples = [
    rows("codex:five_hour:_:50000:60000", 50000, 0.5),
    rows("codex:five_hour:_:40000:49900", 40000, 0.5),
    rows("codex:five_hour:_:30000:39900", 30000, 0.5),
    rows("codex:five_hour:_:10000:19900", 10000, 0.1),
    rows("codex:five_hour:_:20000:29900", 20000, 0.1),
  ].flat();
  const result = historicalWindowPrior(
    samples,
    "codex:five_hour:_:70000:80000",
    70000,
    "codex",
    "five_hour",
    "ChatGPT Plus",
    1,
    { "gpt-5.6-sol": 1 },
  );
  assert.equal(result!.totalPointUsd, 50);
});

test("historical prior rejects open windows and incompatible model mix", () => {
  // Window ID anchors must differ by more than WINDOW_ID_TOLERANCE_MS (2000)
  // so sameOfficialWindowId treats them as distinct windows.
  const rows = (windowId: string, mix: Record<string, number>) =>
    [0, 5, 10, 15].map((usedPercent, index) => sample({
      windowId,
      timestampMs: 10000 + index,
      usedPercent,
      cumulativeObservedUsd: usedPercent * 0.5,
      modelMix: mix,
      planLabel: "Claude Max",
    }));
  const compatible = { "claude-sonnet-5": 1 };
  // Open window: resetsAt (90000) > currentWindowStartMs (70000) → rejected
  assert.equal(historicalWindowPrior(
    rows("claude:five_hour:_:10000:90000", compatible),
    "claude:five_hour:_:70000:100000",
    70000,
    "claude",
    "five_hour",
    "Claude Max",
    1,
    compatible,
  ), null);
  // Incompatible model mix → rejected
  assert.equal(historicalWindowPrior(
    rows("claude:five_hour:_:10000:60000", { "claude-haiku-4-5": 1 }),
    "claude:five_hour:_:70000:100000",
    70000,
    "claude",
    "five_hour",
    "Claude Max",
    1,
    compatible,
  ), null);
});

test("external usage in the current window blocks historical priors", () => {
  const now = Date.parse("2026-08-21T10:00:00Z");
  const previous = [0, 5, 10, 15].map((usedPercent, index) => sample({
    windowId: "codex:five_hour:_:1000000000000:1000018000000",
    timestampMs: index + 1,
    usedPercent,
    cumulativeObservedUsd: usedPercent * 0.5,
    modelMix: { "gpt-5.6-sol": 1 },
    planLabel: "ChatGPT Plus",
  }));
  const currentId = officialWindowId("codex", "five_hour", null, now, now + WINDOW_MS);
  const currentWindow = [
    sample({
      windowId: currentId,
      timestampMs: now + 1_000,
      usedPercent: 0,
      cumulativeObservedUsd: 0,
      modelMix: { "gpt-5.6-sol": 1 },
      planLabel: "ChatGPT Plus",
    }),
    sample({
      windowId: currentId,
      timestampMs: now + 2_000,
      usedPercent: 4,
      cumulativeObservedUsd: 0,
      modelMix: {},
      planLabel: "ChatGPT Plus",
    }),
  ];
  const official = slice({
    agent: "codex",
    planLabel: "ChatGPT Plus",
    fetchedAt: now,
    windowPct: 4,
    windowResetsAt: now + WINDOW_MS,
    windowDurationMs: WINDOW_MS,
  });
  const local = ev({
    agent: "codex",
    model: "gpt-5.6-sol",
    modelRaw: "gpt-5.6-sol",
    tokensIn: 1_000_000,
    ts: now,
  });
  const result = quotaValueFor(
    [local],
    "codex",
    official,
    "five_hour",
    now,
    [...previous, ...currentWindow],
  );
  assert.equal(result.externalUsageDetected, true);
  assert.equal(result.calibrationSource, "none");
  assert.equal(result.totalPointUsd, null);
});
