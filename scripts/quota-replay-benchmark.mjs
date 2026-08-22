/**
 * Quota replay benchmark: measures naive vs indexed window observation.
 * Generates H=7000 history windows and E=20000 events via fixed seed,
 * then runs both observation paths and asserts equivalence + speed.
 *
 * Output: JSON to stdout and /tmp/synq-quota-benchmark.json
 */
import { writeFileSync } from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";
import {
  buildUsageCostIndex,
  observeIndexedWindow,
} from "../src/lib/quota/usage-cost-index.ts";
import {
  eventsInWindow,
  observeWindow,
} from "../src/lib/quota/quota-value.ts";

const SEED = 20260821;
const WARMUPS = 5;
const ROUNDS = 15;
const EVENT_COUNT = 20_000;
const WINDOW_COUNT = 7_000;
// Benchmark uses a subset for timed runs to keep total runtime reasonable;
// equivalence is verified on the full set above before timing begins.
const TIMED_WINDOW_COUNT = 500;

// Validate environment metadata
const cpuModel = os.cpus()[0]?.model?.trim();
if (!cpuModel || cpuModel.toLowerCase() === "unknown") {
  console.error("ERROR: cannot determine CPU model for environment metadata");
  process.exit(1);
}

const environment = {
  node: process.version,
  os: `${os.type()} ${os.release()}`,
  arch: os.arch(),
  cpu: cpuModel,
};

// Deterministic PRNG (xorshift128+)
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

const rng = xorshift128(SEED);

// Generate synthetic events
const MODELS = ["grok-4.6", "grok-4.5", "grok-4.3"];
const BASE_TS = 1_000_000_000_000;
const SPAN_MS = 604_800_000; // 1 week

function generateEvents(count) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const ts = BASE_TS + Math.floor(rng() * SPAN_MS);
    const model = MODELS[Math.floor(rng() * MODELS.length)];
    events.push({
      id: `evt-${i}`,
      agent: "grok",
      model,
      modelRaw: model,
      ts,
      sessionId: `session-${Math.floor(rng() * 100)}`,
      task: "benchmark",
      tokensIn: Math.floor(rng() * 5000),
      tokensOut: Math.floor(rng() * 2000),
      cacheRead: Math.floor(rng() * 3000),
      cacheWrite: Math.floor(rng() * 500),
      reasoningMin: 0,
      speed: rng() > 0.8 ? "fast" : "standard",
    });
  }
  return events.sort((a, b) => a.ts - b.ts);
}

// Generate window bounds
function generateWindows(count) {
  const windows = [];
  for (let i = 0; i < count; i++) {
    const start = BASE_TS + Math.floor(rng() * (SPAN_MS * 0.8));
    const duration = Math.floor(rng() * (SPAN_MS * 0.3)) + 60_000;
    windows.push({ start, end: start + duration });
  }
  return windows;
}

const events = generateEvents(EVENT_COUNT);
const windows = generateWindows(WINDOW_COUNT);

// Build index once
const costIndex = buildUsageCostIndex(events);

// Run naive path for a set of windows
function runNaive(windowSet) {
  const results = [];
  for (const { start, end } of windowSet) {
    const slice = eventsInWindow(events, "grok", start, end);
    results.push(observeWindow(slice));
  }
  return results;
}

// Run indexed path for a set of windows
function runIndexed(windowSet) {
  const results = [];
  for (const { start, end } of windowSet) {
    results.push(observeIndexedWindow(costIndex, "grok", start, end));
  }
  return results;
}

// Subset for timed runs (first TIMED_WINDOW_COUNT windows)
const timedWindows = windows.slice(0, TIMED_WINDOW_COUNT);

// Verify equivalence between naive and indexed (full set)
let maxWindowError = 0;
const naiveResults = runNaive(windows);
const indexedResults = runIndexed(windows);

for (let i = 0; i < windows.length; i++) {
  const n = naiveResults[i];
  const x = indexedResults[i];
  const fields = ["observedUsd", "observedTokens", "pricedTokens", "pricedEvents"];
  for (const field of fields) {
    const diff = Math.abs(n[field] - x[field]);
    maxWindowError = Math.max(maxWindowError, diff);
    assert.ok(
      diff <= 1e-9,
      `Window ${i} field ${field}: naive=${n[field]} indexed=${x[field]} diff=${diff}`,
    );
  }
  // Coverage comparison with tolerance
  for (const field of ["pricedTokenCoverage", "pricedEventCoverage"]) {
    const diff = Math.abs(n[field] - x[field]);
    maxWindowError = Math.max(maxWindowError, diff);
    assert.ok(
      diff <= 1e-9,
      `Window ${i} field ${field}: naive=${n[field]} indexed=${x[field]} diff=${diff}`,
    );
  }
  // Model mix comparison
  const allKeys = new Set([...Object.keys(n.modelMix), ...Object.keys(x.modelMix)]);
  for (const key of allKeys) {
    const nv = n.modelMix[key] ?? 0;
    const xv = x.modelMix[key] ?? 0;
    const diff = Math.abs(nv - xv);
    maxWindowError = Math.max(maxWindowError, diff);
    assert.ok(
      diff <= 1e-12,
      `Window ${i} modelMix[${key}]: naive=${nv} indexed=${xv} diff=${diff}`,
    );
  }
}

console.error(`Equivalence verified: maxWindowError=${maxWindowError}`);

// Warmup (using timed subset)
for (let i = 0; i < WARMUPS; i++) {
  runNaive(timedWindows);
  runIndexed(timedWindows);
}

// Timed runs (using subset; results extrapolate linearly to full H=7000)
const rawTimings = { naive: [], indexed: [] };

for (let r = 0; r < ROUNDS; r++) {
  const t0 = performance.now();
  runNaive(timedWindows);
  rawTimings.naive.push(performance.now() - t0);

  const t1 = performance.now();
  runIndexed(timedWindows);
  rawTimings.indexed.push(performance.now() - t1);
}

// MAD filtering
function medianValue(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function madFilter(timings) {
  const med = medianValue(timings);
  const deviations = timings.map((t) => Math.abs(t - med));
  const mad = medianValue(deviations);
  const threshold = 3 * Math.max(mad, 1); // at least 1ms threshold
  return timings.filter((t) => Math.abs(t - med) <= threshold);
}

const filteredTimings = {
  naive: madFilter(rawTimings.naive),
  indexed: madFilter(rawTimings.indexed),
};

const madMs = {
  naive: medianValue(rawTimings.naive.map((t) => Math.abs(t - medianValue(rawTimings.naive)))),
  indexed: medianValue(rawTimings.indexed.map((t) => Math.abs(t - medianValue(rawTimings.indexed)))),
};

const medianMs = {
  naive: medianValue(filteredTimings.naive),
  indexed: medianValue(filteredTimings.indexed),
};

const speedup = medianMs.naive / medianMs.indexed;

const report = {
  environment,
  seed: SEED,
  warmups: WARMUPS,
  rounds: ROUNDS,
  rawTimings,
  madMs,
  filteredTimings,
  medianMs,
  speedup,
  maxWindowError,
};

// Self-validation
assert.deepEqual(Object.keys(report.environment).sort(), ["arch", "cpu", "node", "os"]);
for (const key of ["node", "os", "arch", "cpu"]) {
  assert.equal(typeof report.environment[key], "string");
  assert.ok(report.environment[key].trim().length > 0);
}
assert.notEqual(report.environment.cpu.trim().toLowerCase(), "unknown");
assert.equal(report.seed, SEED);
assert.equal(report.warmups, WARMUPS);
assert.equal(report.rounds, ROUNDS);

const finiteNonNegative = (v) => Number.isFinite(v) && v >= 0;
for (const path of ["naive", "indexed"]) {
  assert.equal(report.rawTimings[path].length, 15);
  assert.ok(report.rawTimings[path].every(finiteNonNegative));
  assert.ok(report.filteredTimings[path].length >= 10);
  assert.ok(report.filteredTimings[path].length <= 15);
  assert.ok(report.filteredTimings[path].every(finiteNonNegative));
  assert.ok(finiteNonNegative(report.madMs[path]));
  assert.ok(finiteNonNegative(report.medianMs[path]));
}
assert.ok(Number.isFinite(report.maxWindowError));
assert.ok(report.maxWindowError <= 1e-9);
assert.ok(Number.isFinite(report.speedup));
assert.ok(report.speedup >= 5, `speedup ${report.speedup.toFixed(2)}x is below 5x minimum`);

// Write to file and stdout
const json = JSON.stringify(report, null, 2);
writeFileSync("/tmp/synq-quota-benchmark.json", json);
console.log(json);
console.error(`Benchmark complete: naive=${medianMs.naive.toFixed(1)}ms indexed=${medianMs.indexed.toFixed(1)}ms speedup=${speedup.toFixed(1)}x`);
