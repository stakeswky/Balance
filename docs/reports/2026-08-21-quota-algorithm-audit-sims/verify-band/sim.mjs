// Adversarial verification of the ±15% minimum-band coverage claim.
// Uses the real calibrateFromSamples pipeline (same entry as quotaValueFor).
import { calibrateFromSamples } from "../../../../src/lib/quota/quota-value.ts";

const PV = "2026-08-20-synq-3";
const mk = (t, pct, usd) => ({
  windowId: "claude:five_hour:_:0:18000000",
  agent: "claude", product: null, timestampMs: t,
  usedPercent: pct, cumulativeObservedUsd: usd,
  pricedTokenCoverage: 1, modelMix: { fable: 1 }, pricingVersion: PV,
});
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

// Scenario 1: dense polling (app open, 30s official cache), burn rate B %/h.
// pollStepPct = B/120 per poll. Floor quantization. Sample up to upToPct.
function denseTrial(rng, { s, pollStepPct, upToPct }) {
  const rows = [];
  let truePct = rng() * 1.0; // random phase within first plateau
  let t = 1;
  while (truePct < upToPct) {
    rows.push(mk(t++, Math.floor(truePct), truePct * s));
    truePct += pollStepPct * (0.7 + 0.6 * rng());
  }
  return { cal: calibrateFromSamples(rows, Math.floor(truePct), false), trueTotal: 100 * s };
}

// Scenario 2: intermittent app usage. User opens the app K times during the
// early window; each open lasts openMin minutes with 30s polls; burn continues
// while closed. Events are backfilled from JSONL so cumulativeObservedUsd is
// exact at each sample time.
function intermittentTrial(rng, { s, burnPerMin, opens, openMin, upToPct }) {
  const rows = [];
  let truePct = 0;
  let t = 1;
  for (let k = 0; k < opens && truePct < upToPct; k++) {
    // closed gap before this open
    const gapMin = 10 + rng() * 80;
    truePct += burnPerMin * gapMin;
    // open burst: polls every 0.5 min
    const polls = Math.max(1, Math.round(openMin * 2));
    for (let p = 0; p < polls; p++) {
      rows.push(mk(t++, Math.floor(truePct), truePct * s));
      truePct += burnPerMin * 0.5 * (0.5 + rng());
    }
  }
  return { cal: calibrateFromSamples(rows, Math.floor(truePct), false), trueTotal: 100 * s };
}

function run(label, trialFn, n = 4000, seed = 42) {
  const rng = mulberry32(seed);
  const stats = {}; // per-confidence
  let none = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const { cal, trueTotal } = trialFn(rng);
    total++;
    if (cal.totalPointUsd == null) { none++; continue; }
    const c = cal.confidence;
    stats[c] ??= { n: 0, cov: 0, missLow: 0, missHigh: 0, worstRel: 0, sumRelWidth: 0 };
    const st = stats[c];
    st.n++;
    const covered = cal.totalLowUsd <= trueTotal && trueTotal <= cal.totalHighUsd;
    if (covered) st.cov++;
    else if (trueTotal > cal.totalHighUsd) {
      st.missLow++; // interval entirely below truth -> underestimates remaining budget? actually overestimates? interval too low
      st.worstRel = Math.max(st.worstRel, trueTotal / cal.totalHighUsd - 1);
    } else {
      st.missHigh++;
      st.worstRel = Math.max(st.worstRel, cal.totalLowUsd / trueTotal - 1);
    }
    st.sumRelWidth += (cal.totalHighUsd - cal.totalLowUsd) / trueTotal;
  }
  console.log(`\n== ${label} == (no-estimate: ${none}/${total})`);
  for (const [c, st] of Object.entries(stats)) {
    console.log(`  ${c}: n=${st.n} coverage=${(100*st.cov/st.n).toFixed(1)}%` +
      ` missBelowTruth=${st.missLow} missAboveTruth=${st.missHigh}` +
      ` worstGapRel=${(100*st.worstRel).toFixed(0)}% meanRelWidth=${(100*st.sumRelWidth/st.n).toFixed(0)}%`);
  }
}

const s = 0.5; // usd per pct, true total $50

// Realistic dense: app open, moderate burn 10%/h -> 0.083%/poll, low regime (stop at 4-6%)
run("dense open app, 10%/h burn, stop at 5% (low regime)",
  (rng) => denseTrial(rng, { s, pollStepPct: 10/120, upToPct: 3 + 4*rng() }));

// Dense, heavy burn 40%/h -> 0.33%/poll
run("dense open app, 40%/h burn, stop at 5%",
  (rng) => denseTrial(rng, { s, pollStepPct: 40/120, upToPct: 3 + 4*rng() }));

// Dense, extreme burn 72%/h (= researcher's 0.6%/poll), stop at 6%
run("dense open app, 72%/h burn, stop at 6% (researcher cfg)",
  (rng) => denseTrial(rng, { s, pollStepPct: 0.6, upToPct: 6 }));

// Intermittent: 3 opens of 2 min during early window, burn 0.05%/min (~3%/h)
run("intermittent app, 3 opens x 2min, 3%/h burn",
  (rng) => intermittentTrial(rng, { s, burnPerMin: 0.05, opens: 3, openMin: 2, upToPct: 12 }));

// Intermittent: 4 opens x 2 min, faster burn 0.15%/min (~9%/h)
run("intermittent app, 4 opens x 2min, 9%/h burn",
  (rng) => intermittentTrial(rng, { s, burnPerMin: 0.15, opens: 4, openMin: 2, upToPct: 15 }));

// Intermittent: 6 opens x 5 min, 0.3%/min (~18%/h)
run("intermittent app, 6 opens x 5min, 18%/h burn",
  (rng) => intermittentTrial(rng, { s, burnPerMin: 0.3, opens: 6, openMin: 5, upToPct: 30 }));

// Regime boundary: sweep pollStepPct (burn per 30s poll) at low regime stop 5%
for (const step of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8]) {
  run(`sweep pollStep=${step} pct/poll (burn ${(step*120).toFixed(0)}%/h if 30s polls), stop 5%`,
    (rng) => denseTrial(rng, { s, pollStepPct: step, upToPct: 3 + 4*rng() }), 3000, 7);
}
