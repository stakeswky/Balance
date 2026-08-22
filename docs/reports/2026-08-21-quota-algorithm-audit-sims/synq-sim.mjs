// Numerical simulation: synq quota-value slope estimators under percent quantization.
// Mimics src/lib/quota/quota-value.ts pipeline vs alternatives.

function median(v) {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function weightedMedian(rows) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (total <= 0) return median(rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  let acc = 0;
  for (const r of sorted) { acc += r.weight; if (acc >= total / 2) return r.value; }
  return sorted[sorted.length - 1].value;
}
function weightedPct(rows, p) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const target = total * p;
  let acc = 0;
  for (const r of sorted) { acc += r.weight; if (acc >= target) return r.value; }
  return sorted[sorted.length - 1].value;
}

// Mimic normalizeWindowSamples plateau compression (keep LAST sample of each pct plateau)
function normalize(samples) {
  const out = [];
  let maxPct = -Infinity;
  for (const row of samples) {
    if (row.pct < maxPct) continue;
    if (row.pct === maxPct) { out[out.length - 1] = row; continue; }
    out.push(row); maxPct = row.pct;
  }
  return out;
}

// Mimic calibrateFromSamples point estimate path
function currentPipeline(samples) {
  const norm = normalize(samples);
  const raw = [];
  for (let i = 1; i < norm.length; i++) {
    const dP = norm[i].pct - norm[i - 1].pct;
    const dU = norm[i].usd - norm[i - 1].usd;
    if (dP < 1) continue;
    if (dU <= 0) continue;
    raw.push({ value: dU / dP, weight: dP });
  }
  const slopes = raw.length >= 3 ? raw.slice(1, -1) : raw;
  if (!slopes.length) return null;
  const values = slopes.map((s) => s.value);
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  const kept = slopes.filter((s) => Math.abs(s.value - m) <= Math.max(3 * mad, 0.25 * m));
  if (!kept.length) return null;
  const point = weightedMedian(kept);
  let low = weightedPct(kept, 0.25), high = weightedPct(kept, 0.75);
  const band = 0.15;
  low = Math.min(low, point * (1 - band));
  high = Math.max(high, point * (1 + band));
  return { point, low, high, n: kept.length, nraw: raw.length };
}

// Theil-Sen on normalized samples: all pairs with dPct >= 1
function theilSen(samples, minDp = 1) {
  const norm = normalize(samples);
  const sl = [];
  for (let i = 0; i < norm.length; i++)
    for (let j = i + 1; j < norm.length; j++) {
      const dP = norm[j].pct - norm[i].pct;
      const dU = norm[j].usd - norm[i].usd;
      if (dP < minDp) continue;
      sl.push(dU / dP);
    }
  if (!sl.length) return null;
  return median(sl);
}

// Endpoint ratio (telescoped ratio-of-sums)
function endpointRatio(samples) {
  const norm = normalize(samples);
  if (norm.length < 2) return null;
  const a = norm[0], b = norm[norm.length - 1];
  const dP = b.pct - a.pct;
  if (dP < 1) return null;
  return (b.usd - a.usd) / dP;
}

function runScenario({ name, reps, trueSlope, maxPct, pollDp, quantize, contaminate }) {
  const res = { cur: [], ts: [], ep: [], curCover: 0, curNull: 0, tsNull: 0, curN: [] };
  for (let r = 0; r < reps; r++) {
    // generate polls
    let p = 0;
    const samples = [];
    while (p < maxPct) {
      p += pollDp();
      const obsPct = quantize ? Math.floor(p) : p;
      samples.push({ pct: obsPct, usd: trueSlope * p });
    }
    if (contaminate && samples.length > 4) {
      // one interior poll observed mid-flush: usd temporarily under-reported by 40%
      const k = Math.floor(samples.length / 2);
      samples[k] = { ...samples[k], usd: samples[k].usd * 0.6 };
    }
    const cur = currentPipeline(samples);
    const ts = theilSen(samples);
    const ep = endpointRatio(samples);
    if (cur == null) res.curNull++;
    else {
      res.cur.push(cur.point);
      res.curN.push(cur.n);
      if (cur.low <= trueSlope && trueSlope <= cur.high) res.curCover++;
    }
    if (ts == null) res.tsNull++; else res.ts.push(ts);
    if (ep != null) res.ep.push(ep);
  }
  const stats = (arr) => {
    if (!arr.length) return { bias: NaN, rmse: NaN, n: 0 };
    const bias = arr.reduce((s, v) => s + v - trueSlope, 0) / arr.length;
    const rmse = Math.sqrt(arr.reduce((s, v) => s + (v - trueSlope) ** 2, 0) / arr.length);
    return { relBias: bias / trueSlope, relRmse: rmse / trueSlope, n: arr.length };
  };
  console.log(`\n=== ${name} (trueSlope=${trueSlope}, reps=${reps}) ===`);
  console.log("current pipeline:", stats(res.cur),
    ` nullRate=${(res.curNull / reps).toFixed(3)}`,
    ` bandCover=${(res.curCover / Math.max(1, reps - res.curNull)).toFixed(3)}`,
    ` medianKeptSlopes=${median(res.curN)}`);
  console.log("theil-sen pairs :", stats(res.ts), ` nullRate=${(res.tsNull / reps).toFixed(3)}`);
  console.log("endpoint ratio  :", stats(res.ep));
}

const REPS = 4000;
const U = (a, b) => () => a + Math.random() * (b - a);

// S1: Claude local-history regime — integer floor percent, moderate window burn to 10%
runScenario({ name: "S1 int-quantized, burn to 10% (few plateaus)", reps: REPS, trueSlope: 0.5, maxPct: 10, pollDp: U(0.2, 1.2), quantize: true });

// S2: burn to 25% (more plateaus)
runScenario({ name: "S2 int-quantized, burn to 25%", reps: REPS, trueSlope: 0.5, maxPct: 25, pollDp: U(0.2, 1.2), quantize: true });

// S3: Codex fractional percent, frequent polls (small dp per poll)
runScenario({ name: "S3 fractional pct, frequent polls dp~U(0.1,0.6), burn to 8%", reps: REPS, trueSlope: 0.5, maxPct: 8, pollDp: U(0.1, 0.6), quantize: false });

// S4: contamination: one interior sample under-reports cumUsd by 40% (JSONL mid-flush)
runScenario({ name: "S4 int-quantized burn to 15% + one corrupted interior sample", reps: REPS, trueSlope: 0.5, maxPct: 15, pollDp: U(0.2, 1.2), quantize: true, contaminate: true });

// --- Level-shift (external usage) scenarios ---
function genExternal({ trueSlope, maxPct, pollDp, jumpAt, jumpSize, mixed }) {
  let p = 0; let extra = 0; let jumped = false;
  const samples = [];
  while (p + extra < maxPct) {
    p += pollDp();
    if (!jumped && p >= jumpAt) {
      extra = jumpSize; jumped = true;
      if (!mixed) {
        // external arrives during idle: emit a poll right after jump with no new local usd
        samples.push({ pct: Math.floor(p + extra), usd: trueSlope * p });
        continue;
      }
    }
    samples.push({ pct: Math.floor(p + extra), usd: trueSlope * p });
  }
  return samples;
}

// Segmented Theil-Sen: break chain at adjacent steps whose dUsd/dPct < 0.4*medianAdjacent (external/cheap),
// run all-pairs TS within segments, pool pairwise slopes.
function segmentedTS(samples) {
  const norm = normalize(samples);
  if (norm.length < 2) return null;
  const adj = [];
  for (let i = 1; i < norm.length; i++) {
    const dP = norm[i].pct - norm[i - 1].pct;
    const dU = norm[i].usd - norm[i - 1].usd;
    adj.push(dP >= 1 ? dU / dP : NaN);
  }
  const finite = adj.filter((v) => Number.isFinite(v) && v > 0);
  const m = median(finite);
  const segs = [];
  let cur = [norm[0]];
  for (let i = 1; i < norm.length; i++) {
    const suspicious = Number.isFinite(adj[i - 1]) && adj[i - 1] < 0.4 * m;
    if (suspicious) { if (cur.length > 1) segs.push(cur); cur = [norm[i]]; }
    else cur.push(norm[i]);
  }
  if (cur.length > 1) segs.push(cur);
  const sl = [];
  for (const seg of segs)
    for (let i = 0; i < seg.length; i++)
      for (let j = i + 1; j < seg.length; j++) {
        const dP = seg[j].pct - seg[i].pct;
        if (dP < 1) continue;
        sl.push((seg[j].usd - seg[i].usd) / dP);
      }
  if (!sl.length) return null;
  return median(sl);
}

function runExternal({ name, reps, trueSlope, maxPct, pollDp, jumpAt, jumpSize, mixed }) {
  const res = { cur: [], ts: [], seg: [], ep: [], curNull: 0 };
  for (let r = 0; r < reps; r++) {
    const samples = genExternal({ trueSlope, maxPct, pollDp, jumpAt, jumpSize, mixed });
    const cur = currentPipeline(samples);
    const ts = theilSen(samples);
    const seg = segmentedTS(samples);
    const ep = endpointRatio(samples);
    if (cur == null) res.curNull++; else res.cur.push(cur.point);
    if (ts != null) res.ts.push(ts);
    if (seg != null) res.seg.push(seg);
    if (ep != null) res.ep.push(ep);
  }
  const stats = (arr) => {
    if (!arr.length) return { n: 0 };
    const bias = arr.reduce((s, v) => s + v - trueSlope, 0) / arr.length;
    const rmse = Math.sqrt(arr.reduce((s, v) => s + (v - trueSlope) ** 2, 0) / arr.length);
    return { relBias: +(bias / trueSlope).toFixed(4), relRmse: +(rmse / trueSlope).toFixed(4), n: arr.length };
  };
  console.log(`\n=== ${name} ===`);
  console.log("current :", stats(res.cur), `nullRate=${(res.curNull / reps).toFixed(3)}`);
  console.log("naive TS:", stats(res.ts));
  console.log("seg TS  :", stats(res.seg));
  console.log("endpoint:", stats(res.ep));
}

runExternal({ name: "S5 external +4pct at p=7 during idle, burn to 15%", reps: 4000, trueSlope: 0.5, maxPct: 15, pollDp: U(0.2, 1.2), jumpAt: 7, jumpSize: 4, mixed: false });
runExternal({ name: "S6 external +4pct at p=7 mixed with local usage, burn to 15%", reps: 4000, trueSlope: 0.5, maxPct: 15, pollDp: U(0.2, 1.2), jumpAt: 7, jumpSize: 4, mixed: true });

// S0: tiny burn (low-confidence regime): burn to 5%
runScenario({ name: "S0 int-quantized, burn to 5% (2-4 plateaus)", reps: 4000, trueSlope: 0.5, maxPct: 5, pollDp: U(0.2, 1.2), quantize: true });
