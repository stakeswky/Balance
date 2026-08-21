// Simulation 2: (a) weightedMedian lower-median convention bias with equal weights;
// (b) coverage of [totalLowUsd, totalHighUsd] under integer floor-quantization with
//     sparse polling, for low/medium confidence outputs.
import { calibrateFromSamples } from "../../../../src/lib/quota/quota-value.ts";

const PV = "2026-08-20-synq-3";
const mk = (t, pct, usd) => ({
  windowId: "claude:five_hour:_:0:18000000",
  agent: "claude", product: null, timestampMs: t,
  usedPercent: pct, cumulativeObservedUsd: usd,
  pricedTokenCoverage: 1, modelMix: { fable: 1 }, pricingVersion: PV,
});

// (a) two clean segments with slopes 0.40 and 0.60 (equal weight 10 each). Fair point 0.50.
{
  const rows = [
    mk(1, 10, 0),        // censored first slope trimmed only when n>=3; here n=2 raw slopes
    mk(2, 20, 4.0),      // slope 0.40 over 10 pct
    mk(3, 30, 10.0),     // slope 0.60 over 10 pct
  ];
  const cal = calibrateFromSamples(rows, 30, false);
  console.log("(a) slopes {0.40 w10, 0.60 w10} -> totalPointUsd:", cal.totalPointUsd,
    "(fair midpoint would be 50)");
  // 4 equal segments: 0.4, 0.6, 0.4, 0.6 -> interior after trim: 0.6, 0.4 -> point?
  const rows4 = [mk(1,10,0), mk(2,20,4), mk(3,30,10), mk(4,40,14), mk(5,50,20)];
  const cal4 = calibrateFromSamples(rows4, 50, false);
  console.log("(a2) slopes {.4,.6,.4,.6} w10 each -> point:", cal4.totalPointUsd);
}

// (b) coverage under floor-quantization, uniform burn, sparse polling.
function trial(rng, { s, pollPct, upToPct }) {
  // s = true usd per pct; poll advances pollPct true-percent per poll with jitter.
  const rows = [];
  let truePct = rng() * pollPct; // random phase
  let t = 1;
  while (truePct < upToPct) {
    rows.push(mk(t++, Math.floor(truePct), truePct * s));
    truePct += pollPct * (0.5 + rng());
  }
  return calibrateFromSamples(rows, Math.floor(truePct), false);
}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

for (const cfg of [
  { s: 0.5, pollPct: 0.6, upToPct: 6, label: "small window (low conf regime)" },
  { s: 0.5, pollPct: 0.6, upToPct: 12, label: "medium regime" },
  { s: 0.5, pollPct: 1.4, upToPct: 20, label: "sparse polls (1.4 pct/poll), 20%" },
  { s: 0.5, pollPct: 2.5, upToPct: 30, label: "very sparse (2.5 pct/poll), 30%" },
]) {
  const rng = mulberry32(1234);
  let n = 0, covered = 0, none = 0; const byConf = {}; let sumPoint = 0;
  for (let i = 0; i < 4000; i++) {
    const cal = trial(rng, cfg);
    if (cal.totalPointUsd == null) { none++; continue; }
    n++;
    byConf[cal.confidence] = (byConf[cal.confidence] ?? 0) + 1;
    sumPoint += cal.totalPointUsd;
    const trueTotal = 100 * cfg.s;
    if (cal.totalLowUsd <= trueTotal && trueTotal <= cal.totalHighUsd) covered++;
  }
  console.log(`(b) ${cfg.label}: est-rate=${n}/${n+none} coverage=${(100*covered/Math.max(1,n)).toFixed(1)}%`,
    `mean point=${(sumPoint/Math.max(1,n)).toFixed(1)} (true 50)`, "conf:", byConf);
}
