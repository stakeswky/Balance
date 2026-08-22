import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateFromSamples,
  samplesFromOfficial,
  validSlopes,
  windowBounds,
} from "../src/lib/quota/quota-value.ts";
import { PRICING_VERSION } from "../src/lib/quota/pricing-data.ts";

const base = {
  agent: "grok",
  product: null,
  pricedTokenCoverage: 1,
  modelMix: { "grok-4.6:standard": 1 },
  pricingVersion: PRICING_VERSION,
  planLabel: null,
};

test("fractional official percentages produce calibrated slopes", () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({
    ...base,
    windowId: "grok:weekly:_:1000000000000:1000604800000",
    timestampMs: 1_000_000_000_000 + index * 30_000,
    usedPercent: index * 0.2,
    cumulativeObservedUsd: index * 0.1,
  }));
  assert.ok(validSlopes(rows).length >= 30);
  const result = calibrateFromSamples(rows, 40, false);
  assert.notEqual(result.confidence, "none");
  assert.ok(Math.abs(result.totalPointUsd - 50) < 1e-9);
});

test("expired stale slices cannot create phantom samples", () => {
  const now = Date.parse("2026-08-21T12:00:00Z");
  const fetchedAt = now - 26 * 60 * 60_000;
  const slice = {
    agent: "codex",
    windowPct: 63,
    weekPct: null,
    windowResetsAt: fetchedAt + 2 * 60 * 60_000,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: 5 * 60 * 60_000,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel: "ChatGPT Plus",
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    windowStale: true,
    source: "session-rate-limits",
    fetchedAt,
    windowKind: "five_hour",
  };
  assert.equal(windowBounds(slice, "five_hour", now).rolling, true);
  assert.deepEqual(
    samplesFromOfficial([], { claude: null, grok: null, codex: slice }, now, []),
    [],
  );
});

test("integer quantized pct at 5/10/25% steps calibrates with high confidence", () => {
  // 5% step: 20 samples, each integer pct
  for (const step of [5, 10, 25]) {
    const count = Math.floor(100 / step);
    const rows = Array.from({ length: count + 1 }, (_, i) => ({
      ...base,
      windowId: "grok:weekly:_:2000000000000:2000604800000",
      timestampMs: 2_000_000_000_000 + i * 60_000,
      usedPercent: i * step,
      cumulativeObservedUsd: i * step * 0.5,
    }));
    const slopes = validSlopes(rows);
    assert.ok(slopes.length >= 1, `step=${step}: expected slopes, got ${slopes.length}`);
    const result = calibrateFromSamples(rows, rows.at(-1).usedPercent, false);
    assert.notEqual(result.confidence, "none", `step=${step}: confidence should not be none`);
  }
});

test("single +4% external step is flagged as external usage", () => {
  // Normal burn with one external jump at index 10
  const rows = Array.from({ length: 30 }, (_, i) => {
    const pct = i < 10 ? i * 2 : i < 11 ? 20 + 4 : 24 + (i - 11) * 2;
    return {
      ...base,
      windowId: "grok:weekly:_:3000000000000:3000604800000",
      timestampMs: 3_000_000_000_000 + i * 60_000,
      usedPercent: pct,
      cumulativeObservedUsd: i < 10 ? i * 1.0 : i < 11 ? 10 : 10 + (i - 11) * 1.0,
    };
  });
  const result = calibrateFromSamples(rows, rows.at(-1).usedPercent, false);
  assert.equal(result.externalUsageDetected, true);
});

test("rolling windows produce none confidence", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    ...base,
    windowId: "grok:weekly:_:4000000000000:4000604800000",
    timestampMs: 4_000_000_000_000 + i * 60_000,
    usedPercent: i * 2,
    cumulativeObservedUsd: i * 1.0,
  }));
  const result = calibrateFromSamples(rows, 50, true);
  assert.equal(result.confidence, "none");
});

// ============================================================================
// Shadow estimator comparison: segmented Theil–Sen vs production pipeline
// ============================================================================

// Deterministic PRNG (xorshift128+) for reproducibility
function xorshift128(seed) {
  let s0 = seed >>> 0;
  let s1 = (seed * 2654435761) >>> 0;
  if (s0 === 0) s0 = 1;
  if (s1 === 0) s1 = 1;
  return () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    s1 = x;
    return ((s0 + s1) >>> 0) / 4294967296;
  };
}

function medianOfArray(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function segmentedTheilSen(samples, minDpct = 1) {
  // All pairs with dPct >= minDpct and dUsd >= 0
  const slopes = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const dP = samples[j].usedPercent - samples[i].usedPercent;
      const dU = samples[j].cumulativeObservedUsd - samples[i].cumulativeObservedUsd;
      if (dP < minDpct) continue;
      if (dU < 0) continue;
      slopes.push(dU / dP);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const n = slopes.length;
  const mid = Math.floor(n / 2);
  const point = n % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
  // 95% CI via Sen's method: use percentile indices
  // k = n/2 - z*sqrt(n*(2n+5)/18)/2
  // Use z=2.576 (99% normal quantile) to widen for quantization bias
  const variance = n * (2 * n + 5) / 18;
  const z = 2.576;
  const half = z * Math.sqrt(variance) / 2;
  const k = Math.max(0, Math.round(n / 2 - half));
  const j = Math.min(n - 1, Math.round(n / 2 + half));
  return { point, low: slopes[k], high: slopes[j] };
}

function generateScenario(rng, { trueSlope, maxPct, quantize, pollDp, contaminate }) {
  let pct = 0;
  const samples = [];
  let idx = 0;
  let cumulativeUsd = 0;
  while (pct < maxPct) {
    const dp = typeof pollDp === "function" ? pollDp(rng) : pollDp;
    pct += dp;
    // Realistic measurement noise: +/- 5% jitter on incremental USD
    const incrementUsd = trueSlope * dp * (0.95 + rng() * 0.1);
    cumulativeUsd += incrementUsd;
    const obsPct = quantize ? Math.floor(pct) : pct;
    samples.push({
      ...base,
      windowId: "grok:weekly:_:5000000000000:5000604800000",
      timestampMs: 5_000_000_000_000 + idx * 60_000,
      usedPercent: obsPct,
      cumulativeObservedUsd: cumulativeUsd,
    });
    idx++;
  }
  if (contaminate && samples.length > 4) {
    const k = Math.floor(samples.length / 2);
    samples[k] = {
      ...samples[k],
      cumulativeObservedUsd: samples[k].cumulativeObservedUsd * 0.6,
    };
  }
  return samples;
}

function runShadowComparison(scenario, trials, rng) {
  const prodErrors = [];
  const shadowErrors = [];
  let shadowNull = 0;
  let prodNull = 0;
  let shadowCoverage = 0;

  for (let t = 0; t < trials; t++) {
    const samples = generateScenario(rng, scenario);
    const trueTotal = scenario.trueSlope * 100;

    // Production estimator
    const prod = calibrateFromSamples(samples, samples.at(-1)?.usedPercent ?? 0, false);
    if (prod.totalPointUsd == null) {
      prodNull++;
    } else {
      prodErrors.push(prod.totalPointUsd - trueTotal);
    }

    // Shadow: segmented Theil-Sen
    const tsResult = segmentedTheilSen(samples);
    if (tsResult == null) {
      shadowNull++;
    } else {
      const tsTotal = tsResult.point * 100;
      shadowErrors.push(tsTotal - trueTotal);
      // Check 95% confidence interval coverage
      const lo = tsResult.low * 100;
      const hi = tsResult.high * 100;
      if (trueTotal >= lo && trueTotal <= hi) shadowCoverage++;
    }
  }

  const rmse = (arr) => arr.length ? Math.sqrt(arr.reduce((s, e) => s + e * e, 0) / arr.length) : Infinity;
  const bias = (arr) => arr.length ? arr.reduce((s, e) => s + e, 0) / arr.length : Infinity;
  const trueTotal = scenario.trueSlope * 100;

  return {
    prodRmse: rmse(prodErrors),
    shadowRmse: rmse(shadowErrors),
    prodBias: bias(prodErrors),
    shadowBias: bias(shadowErrors),
    prodNull: prodNull / trials,
    shadowNull: shadowNull / trials,
    shadowCoverageRate: shadowErrors.length ? shadowCoverage / shadowErrors.length : 0,
    trueTotal,
  };
}

test("shadow Theil-Sen quality gate: fixed scenarios (seed 20260821)", () => {
  const SEED = 20260821;
  const TRIALS = 4000;
  const rng = xorshift128(SEED);

  const scenarios = [
    {
      name: "integer-5pct",
      trueSlope: 0.5,
      maxPct: 100,
      quantize: true,
      pollDp: () => 5 + rng() * 2, // ~5-7 pct steps
      contaminate: false,
    },
    {
      name: "integer-10pct",
      trueSlope: 1.2,
      maxPct: 100,
      quantize: true,
      pollDp: () => 10 + rng() * 5, // ~10-15 pct steps
      contaminate: false,
    },
    {
      name: "integer-25pct",
      trueSlope: 2.0,
      maxPct: 100,
      quantize: true,
      pollDp: () => 20 + rng() * 10, // ~20-30 pct steps
      contaminate: false,
    },
    {
      name: "fractional-small-step",
      trueSlope: 0.8,
      maxPct: 60,
      quantize: false,
      pollDp: () => 0.1 + rng() * 0.5, // 0.1-0.6% steps
      contaminate: false,
    },
    {
      name: "external-step-4pct",
      trueSlope: 0.5,
      maxPct: 80,
      quantize: true,
      pollDp: () => 3 + rng() * 2,
      contaminate: true, // one interior sample with 40% under-report
    },
  ];

  const results = {};
  const integerResults = [];

  for (const scenario of scenarios) {
    const result = runShadowComparison(scenario, TRIALS, rng);
    results[scenario.name] = result;
    if (scenario.name.startsWith("integer-")) integerResults.push(result);
    console.log(
      `  ${scenario.name}: prod_rmse=${result.prodRmse.toFixed(4)} shadow_rmse=${result.shadowRmse.toFixed(4)} ` +
      `shadow_bias=${result.shadowBias.toFixed(4)} shadow_cover=${result.shadowCoverageRate.toFixed(3)} ` +
      `shadow_null=${result.shadowNull.toFixed(3)}`
    );
  }

  // Gate 1: integer scenarios — shadow RMSE <= 1.05x production RMSE each
  for (const name of ["integer-5pct", "integer-10pct", "integer-25pct"]) {
    const r = results[name];
    const ratio = r.prodRmse > 0 ? r.shadowRmse / r.prodRmse : 0;
    assert.ok(
      ratio <= 1.05,
      `${name}: shadow/prod RMSE ratio ${ratio.toFixed(4)} exceeds 1.05`,
    );
  }

  // Gate 2: median RMSE ratio across integer scenarios <= 0.75
  const ratios = integerResults.map((r) =>
    r.prodRmse > 0 ? r.shadowRmse / r.prodRmse : 0,
  );
  ratios.sort((a, b) => a - b);
  const medianRatio = ratios[Math.floor(ratios.length / 2)];
  assert.ok(
    medianRatio <= 0.75,
    `median integer RMSE ratio ${medianRatio.toFixed(4)} exceeds 0.75`,
  );

  // Gate 3: external step — relative absolute bias <= 0.05
  const extResult = results["external-step-4pct"];
  const relAbsBias = Math.abs(extResult.shadowBias) / extResult.trueTotal;
  assert.ok(
    relAbsBias <= 0.05,
    `external-step relative abs bias ${relAbsBias.toFixed(4)} exceeds 0.05`,
  );

  // Gate 4: aggregate 95% shadow interval coverage in [0.90, 0.99]
  // across all non-contaminated scenarios (weighted by trial count)
  const coverageScenarios = ["integer-5pct", "integer-10pct", "integer-25pct", "fractional-small-step"];
  const totalCovered = coverageScenarios.reduce((s, k) => s + results[k].shadowCoverageRate, 0);
  const avgCoverage = totalCovered / coverageScenarios.length;
  assert.ok(
    avgCoverage >= 0.90 && avgCoverage <= 0.99,
    `aggregate shadow interval coverage ${avgCoverage.toFixed(4)} not in [0.90, 0.99]`,
  );

  // Gate 5: fractional scenario null rate = 0
  assert.equal(
    results["fractional-small-step"].shadowNull,
    0,
    `fractional scenario shadow null rate is ${results["fractional-small-step"].shadowNull}`,
  );
});
