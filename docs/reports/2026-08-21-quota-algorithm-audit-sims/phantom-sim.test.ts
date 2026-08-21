import test from "node:test";
import assert from "node:assert/strict";
import { samplesFromOfficial, mergeSamples, windowBounds, officialWindowId, calibrateFromSamples, type QuotaSample } from "../../../src/lib/quota/quota-value.ts";
import type { OfficialSlice } from "../../../src/lib/quota/official.ts";
import { PRICING_VERSION } from "../../../src/lib/quota/pricing.ts";

const H = 3_600_000;

function staleCodexSlice(now: number): OfficialSlice {
  const fetchedAt = now - 26 * H; // last codex CLI run 26h ago
  return {
    agent: "codex",
    windowPct: 63,
    weekPct: null,
    windowResetsAt: fetchedAt + 2 * H, // reset was ~24h ago
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: 5 * H,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel: "ChatGPT Plus",
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "session-rate-limits",
    fetchedAt,
    windowKind: "five_hour",
  };
}

test("stale codex log slice creates a phantom sample in the CURRENT window", () => {
  const now = Date.parse("2026-08-21T12:00:00Z");
  const slice = staleCodexSlice(now);
  const bounds = windowBounds(slice, "five_hour", now);
  console.log("bounds.start:", new Date(bounds.start).toISOString(),
    "resetsAt:", new Date(bounds.resetsAt!).toISOString(), "rolling:", bounds.rolling);
  assert.equal(bounds.rolling, false);
  assert.ok(bounds.start <= now && bounds.resetsAt! > now, "rolled into the tile containing now");

  const samples = samplesFromOfficial([], { claude: null, grok: null, codex: slice }, now, []);
  assert.equal(samples.length, 1);
  const phantom = samples[0]!;
  console.log("phantom:", JSON.stringify(phantom));
  assert.equal(phantom.usedPercent, 63);
  assert.ok(phantom.timestampMs < bounds.start, "sample timestamp predates its own window start");
  const currentWindowId = officialWindowId("codex", "five_hour", null, bounds.start, bounds.resetsAt);
  assert.equal(phantom.windowId, currentWindowId);

  // Recovery: real samples in the SAME windowId with lower pct all get dropped at merge time.
  let store = samples;
  const mk = (ts: number, pct: number, usd: number): QuotaSample => ({
    windowId: currentWindowId,
    agent: "codex",
    product: null,
    timestampMs: ts,
    usedPercent: pct,
    cumulativeObservedUsd: usd,
    pricedTokenCoverage: 1,
    modelMix: { "gpt-5.6-sol": 1 },
    pricingVersion: PRICING_VERSION,
  });
  for (const [i, pct] of [2, 4, 6, 8, 10].entries()) {
    store = mergeSamples(store, mk(now + (i + 1) * 60_000, pct, pct * 0.5));
  }
  console.log("post-merge pcts:", store.map((s) => s.usedPercent));
  assert.deepEqual(store.map((s) => s.usedPercent), [63], "all real samples rejected; only phantom persisted");
  const cal = calibrateFromSamples(store, 10, false);
  assert.equal(cal.confidence, "none");
});

test("stale claude slice (windowStale=true) still produces a phantom sample", () => {
  const now = Date.parse("2026-08-21T12:00:00Z");
  const loadedAt = now - 40 * 60_000; // fetched 40min ago, reset 30min ago
  const slice: OfficialSlice = {
    agent: "claude",
    windowPct: 80,
    weekPct: 30,
    windowResetsAt: now - 30 * 60_000,
    weekResetsAt: now + 3 * 24 * H,
    weekStartedAt: now + 3 * 24 * H - 7 * 24 * H,
    windowDurationMs: 5 * H,
    weekDurationMs: 7 * 24 * H,
    burnPctPerHour: 0,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    windowStale: true,
    weekStale: true,
    source: "oauth-usage",
    fetchedAt: loadedAt,
    windowKind: "five_hour",
  };
  const samples = samplesFromOfficial([], { claude: slice, grok: null, codex: null }, now, []);
  const fiveHour = samples.filter((s) => s.windowId.includes(":five_hour:"));
  assert.equal(fiveHour.length, 1);
  const bounds = windowBounds(slice, "five_hour", now);
  console.log("claude phantom:", JSON.stringify(fiveHour[0]),
    "window start:", new Date(bounds.start).toISOString());
  assert.equal(fiveHour[0]!.usedPercent, 80);
  assert.ok(fiveHour[0]!.timestampMs < bounds.start, "phantom ts before new window start");
});
