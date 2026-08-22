import test from "node:test";
import assert from "node:assert/strict";
import {
  validSlopes, calibrateFromSamples, mergeSamples, samplesFromOfficial,
} from "../../../src/lib/quota/quota-value.ts";

const base = {
  agent: "grok", product: null, pricedTokenCoverage: 1,
  modelMix: { "grok-4.6": 1 }, pricingVersion: "v",
};
const win = "grok:weekly:_:0:604800000";

test("SIM-1: fractional pct at 30s cadence starves all slopes", () => {
  // steady burn: 20%/week, sampled every 30s -> dPct per sample ~ 0.00099
  // use coarser 0.2%-per-sample steps (heavy usage) to be generous
  const samples = [];
  for (let i = 0; i < 200; i++) {
    samples.push({
      ...base, windowId: win, timestampMs: i * 30_000,
      usedPercent: +(i * 0.2).toFixed(2),          // 0 .. 39.8 %
      cumulativeObservedUsd: i * 0.05,             // steady USD
    });
  }
  const slopes = validSlopes(samples);
  console.log("SIM-1 slopes:", slopes.length, "total pct span:", 39.8);
  const cal = calibrateFromSamples(samples, 39.8, false);
  console.log("SIM-1 confidence:", cal.confidence, "point:", cal.totalPointUsd);
  assert.equal(slopes.length, 0);
});

test("SIM-2: same trajectory with integer pct calibrates fine", () => {
  const samples = [];
  for (let i = 0; i < 40; i++) {
    samples.push({
      ...base, windowId: win, timestampMs: i * 300_000,
      usedPercent: i, cumulativeObservedUsd: i * 0.5,
    });
  }
  const cal = calibrateFromSamples(samples, 39, false);
  console.log("SIM-2 confidence:", cal.confidence, "point:", cal.totalPointUsd);
  assert.notEqual(cal.confidence, "none");
});

test("SIM-3: stale high pct sample poisons window via monotonic merge", () => {
  // phantom sample from stale codex log: pct 80, old timestamp
  let stored = mergeSamples([], {
    ...base, agent: "codex", windowId: "codex:five_hour:_:0:18000000",
    timestampMs: 1_000, usedPercent: 80, cumulativeObservedUsd: 0,
  });
  // genuine fresh samples afterwards: pct 2..10
  for (let p = 2; p <= 10; p += 2) {
    stored = mergeSamples(stored, {
      ...base, agent: "codex", windowId: "codex:five_hour:_:0:18000000",
      timestampMs: 1_000_000 + p * 60_000, usedPercent: p,
      cumulativeObservedUsd: p * 0.3,
    });
  }
  console.log("SIM-3 stored:", stored.map(s => s.usedPercent));
  assert.deepEqual(stored.map(s => s.usedPercent), [80]);
});

test("SIM-4: stale slice rolled forward creates phantom sample in current window", () => {
  const now = Date.UTC(2026, 7, 21, 12, 0, 0);
  const staleFetched = now - 26 * 3600_000; // log line from 26h ago
  const slice = {
    agent: "codex", windowPct: 63, weekPct: null,
    windowResetsAt: staleFetched + 3600_000, // reset long past
    weekResetsAt: null, weekStartedAt: null,
    windowDurationMs: 18000_000, weekDurationMs: null,
    burnPctPerHour: 0, planLabel: null, products: [],
    prepaidBalance: null, onDemandUsed: null, onDemandCap: null,
    source: "session-rate-limits", fetchedAt: staleFetched, windowKind: "five_hour",
  };
  const out = samplesFromOfficial([], { claude: null, grok: null, codex: slice }, now, []);
  console.log("SIM-4 samples:", out.map(s => ({ id: s.windowId, pct: s.usedPercent, ts: s.timestampMs })));
  assert.equal(out.length, 1);
  const s = out[0];
  const startTok = Number(s.windowId.split(":")[3]);
  assert.ok(s.timestampMs < startTok, "sample timestamp lies before its own window start");
  assert.equal(s.usedPercent, 63);
});
