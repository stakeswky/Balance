// Simulation 1: fractional-percent providers (Codex/Grok) + frequent polling
// -> all adjacent dPct < 1 -> zero valid slopes forever.
import { validSlopes, calibrateFromSamples } from "../../../../src/lib/quota/quota-value.ts";

const PV = "2026-08-20-synq-3";
function mk(t, pct, usd) {
  return {
    windowId: "codex:weekly:_:0:604800000",
    agent: "codex",
    product: null,
    timestampMs: t,
    usedPercent: pct,
    cumulativeObservedUsd: usd,
    pricedTokenCoverage: 1,
    modelMix: { "gpt-5.4": 1 },
    pricingVersion: PV,
  };
}

// True slope: $0.50 per pct. Official reports fractional percent (e.g. Codex used_percent float).
// Poll every 2.5s; burn 12%/hour -> pct advances ~0.00833%/poll. Simulate 6 hours = 72% ... use
// coarser: assume store keeps a sample each time pct changes at 0.1 granularity.
const samples = [];
let usd = 0;
for (let i = 0; i <= 300; i++) {
  const pct = i * 0.1; // 0 .. 30% consumed in fine steps
  usd = pct * 0.5;
  samples.push(mk(1000 + i * 60_000, Number(pct.toFixed(4)), usd));
}
const slopes = validSlopes(samples);
console.log("fractional 0.1-step chain: samples=", samples.length, "validSlopes=", slopes.length);
const cal = calibrateFromSamples(samples, 30, false);
console.log("calibration confidence:", cal.confidence, "totalPointUsd:", cal.totalPointUsd);

// Same total consumption, but sampled sparsely (every 1.5%) -> works.
const sparse = [];
for (let i = 0; i <= 20; i++) sparse.push(mk(1000 + i * 60_000, i * 1.5, i * 1.5 * 0.5));
console.log("sparse 1.5-step chain: validSlopes=", validSlopes(sparse).length,
  "confidence:", calibrateFromSamples(sparse, 30, false).confidence);

// Mixed: mostly 0.6 steps with an occasional >=1 jump: how much weight (usd/pct info) is dropped?
let kept = 0, total = 0;
const mixed = [];
let pct = 0;
let rngState = 42;
const rnd = () => (rngState = (rngState * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
for (let i = 0; i <= 200; i++) {
  mixed.push(mk(1000 + i * 60_000, pct, pct * 0.5));
  const step = rnd() < 0.85 ? 0.4 + 0.4 * rnd() : 1.2 + rnd();
  pct += step;
  if (pct > 90) break;
}
const ms = validSlopes(mixed);
total = mixed.at(-1).usedPercent - mixed[0].usedPercent;
kept = ms.reduce((s, r) => s + r.weight, 0);
console.log("mixed steps: total dPct=", total.toFixed(1), "kept dPct in slopes=", kept.toFixed(1),
  `(${(100 * kept / total).toFixed(0)}% info retained)`, "confidence:",
  calibrateFromSamples(mixed, mixed.at(-1).usedPercent, false).confidence);
