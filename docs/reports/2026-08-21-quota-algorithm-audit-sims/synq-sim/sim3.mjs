// Simulation 3: (a) external usage in first/last segment escapes detection due to slice(1,-1);
// (b) cheap partial-external slope is kept by MAD band and drags the point estimate.
import { calibrateFromSamples, validSlopes } from "../../../../src/lib/quota/quota-value.ts";

const PV = "2026-08-20-synq-3";
const mk = (t, pct, usd, mix = { fable: 1 }) => ({
  windowId: "claude:five_hour:_:0:18000000",
  agent: "claude", product: null, timestampMs: t,
  usedPercent: pct, cumulativeObservedUsd: usd,
  pricedTokenCoverage: 1, modelMix: mix, pricingVersion: PV,
});

// (a) first segment: +10 pct with $0 local (phone usage), then three clean local segments.
{
  const rows = [
    mk(1, 10, 0),
    mk(2, 20, 0),      // external: dPct=10, dUsd=0
    mk(3, 30, 5),      // 0.5/pct
    mk(4, 40, 10),
    mk(5, 45, 12.5),   // current plateau
  ];
  const cal = calibrateFromSamples(rows, 45, false);
  console.log("(a) external first segment -> externalUsageDetected:", cal.externalUsageDetected,
    "confidence:", cal.confidence, "totalPointUsd:", cal.totalPointUsd);
  // Reference: same shape but external segment in the middle
  const rows2 = [
    mk(1, 10, 0),
    mk(2, 20, 5),
    mk(3, 30, 5),      // external in interior
    mk(4, 40, 10),
    mk(5, 45, 12.5),
  ];
  const cal2 = calibrateFromSamples(rows2, 45, false);
  console.log("    interior external (reference) -> detected:", cal2.externalUsageDetected,
    "confidence:", cal2.confidence);
}

// (b) partial external (other device shares the window): one slope at 0.35x of median.
{
  const rows = [
    mk(1, 0, 0),
    mk(2, 10, 10),   // 1.0 (trimmed as censored first)
    mk(3, 20, 18),   // 0.8
    mk(4, 30, 21.5), // 0.35  <- half of usage happened on another device
    mk(5, 40, 31.5), // 1.0
    mk(6, 45, 36.5), // current (trimmed)
  ];
  const cal = calibrateFromSamples(rows, 45, false);
  console.log("(b) slopes kept {0.8, 0.35, 1.0}: point:", cal.totalPointUsd,
    "low:", cal.totalLowUsd?.toFixed(1), "high:", cal.totalHighUsd?.toFixed(1),
    "confidence:", cal.confidence, "(uncontaminated local point would be ~90-100)");
}

// (c) MAD center is unweighted: many tiny noisy dPct=1 slopes vs few large accurate ones.
{
  const rows = [mk(1, 0, 0)];
  let pct = 0, usd = 0, t = 2;
  // 8 slopes of dPct=1 with noisy values ~0.2 (cheap bursts measured over rounded 1%)
  for (let i = 0; i < 8; i++) { pct += 1; usd += 0.2; rows.push(mk(t++, pct, usd)); }
  // 2 accurate large slopes: dPct=10 at true 0.5 usd/pct
  for (let i = 0; i < 2; i++) { pct += 10; usd += 5; rows.push(mk(t++, pct, usd)); }
  const cal = calibrateFromSamples(rows, pct, false);
  const slopes = validSlopes(rows);
  console.log("(c) 8x(w1,v0.2) + 2x(w10,v0.5): raw slopes:", slopes.map(s=>`${s.value.toFixed(2)}w${s.weight}`).join(","));
  console.log("    point:", cal.totalPointUsd, "confidence:", cal.confidence,
    "(weight-consistent estimate: ~0.44-0.5/pct -> 44-50)");
}
