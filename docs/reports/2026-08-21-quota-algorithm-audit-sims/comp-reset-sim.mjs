// Simulate synq normalizeWindowSamples + validSlopes across a compensation reset
const samples = [
  { pct: 55, usd: 80, t: 1 },
  { pct: 60, usd: 88, t: 2 },   // slope so far ~1.6 usd/pct
  { pct: 30, usd: 96, t: 3 },   // compensation reset: pct drops, same windowId
  { pct: 45, usd: 118, t: 4 },  // dropped by monotonic filter (45 < 60)
  { pct: 62, usd: 144, t: 5 },  // first sample above old max 60
];
// monotonic compression (quota-value.ts:300-311)
let maxPct = -Infinity; const kept = [];
for (const s of samples) { if (s.pct < maxPct) continue; if (s.pct === maxPct) { kept[kept.length-1] = s; continue; } kept.push(s); maxPct = s.pct; }
console.log("kept:", kept.map(s => `${s.pct}%/$${s.usd}`).join(" "));
// adjacent slopes (quota-value.ts:271-286)
const slopes = [];
for (let i = 1; i < kept.length; i++) {
  const dP = kept[i].pct - kept[i-1].pct, dU = kept[i].usd - kept[i-1].usd;
  if (dP < 1) continue; slopes.push({ v: dU/dP, w: dP });
}
console.log("slopes:", slopes.map(s => `${s.v.toFixed(2)} usd/pct (w=${s.w})`));
// true slope ~ (144-80)/(7+ ~47 real pct consumed) ≈ 64/54 ≈ 1.2
