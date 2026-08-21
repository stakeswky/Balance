// Benchmark of synq quota chain hot paths, importing the real TS modules.
import { performance } from "node:perf_hooks";
import {
  observeWindow,
  eventsInWindow,
  quotaValueFor,
  samplesFromOfficialHistory,
  samplesFromOfficial,
} from "../../../src/lib/quota/quota-value.ts";
import { meterFor, hourlySeries, modelShares, groupSessions } from "../../../src/lib/quota/engine.ts";
import { planById } from "../../../src/lib/quota/plans.ts";
import { WEEK_MS, WINDOW_MS } from "../../../src/lib/quota/types.ts";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const agents = ["claude", "claude", "claude", "codex", "codex", "grok"];
const models = {
  claude: ["claude-fable-5", "claude-sonnet-5", "claude-opus-5"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra"],
  grok: ["grok-4.6"],
};
const family = { claude: "sonnet", codex: "gpt-5.6-sol", grok: "grok-4.6" };

function makeEvents(n, spanMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const agent = agents[i % agents.length];
    const m = models[agent][i % models[agent].length];
    out.push({
      id: `ev_${i}`,
      agent,
      model: family[agent],
      modelRaw: m,
      ts: NOW - spanMs + Math.floor((i / n) * spanMs),
      sessionId: `s_${i % 300}`,
      task: "work",
      tokensIn: 1200 + (i % 700),
      tokensOut: 800 + (i % 300),
      cacheRead: 50_000 + (i % 10_000),
      cacheWrite: 4_000 + (i % 900),
      reasoningMin: 0.4,
    });
  }
  return out;
}

// History slices: claude with both window & weekly pct -> 2 samples per slice
function makeHistory(h) {
  const weekStart = NOW - 4 * 24 * 3600 * 1000;
  const out = [];
  for (let i = 0; i < h; i++) {
    const fetchedAt = weekStart + Math.floor(((i + 1) / h) * 4 * 24 * 3600 * 1000);
    const winStart = weekStart + Math.floor((fetchedAt - weekStart) / WINDOW_MS) * WINDOW_MS;
    out.push({
      agent: "claude",
      windowPct: (i % 100),
      weekPct: Math.min(99, (i / h) * 100),
      windowResetsAt: winStart + WINDOW_MS,
      weekResetsAt: weekStart + WEEK_MS,
      weekStartedAt: weekStart,
      windowDurationMs: WINDOW_MS,
      weekDurationMs: WEEK_MS,
      burnPctPerHour: 1,
      planLabel: "max",
      products: [],
      prepaidBalance: null,
      onDemandUsed: null,
      onDemandCap: null,
      source: "plan-usage-history",
      fetchedAt,
      windowKind: "five_hour",
    });
  }
  return out;
}

function bench(label, fn, iters = 1) {
  // warmup
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const t1 = performance.now();
  console.log(`${label}: ${((t1 - t0) / iters).toFixed(1)} ms/op (${iters} iters)`);
}

const E = 20_000;
const events = makeEvents(E, 8 * 24 * 3600 * 1000);
console.log(`events: ${E}`);

bench("observeWindow(all 20k events)  [costBreakdown per event]", () => observeWindow(events), 5);
bench("eventsInWindow(20k, 7d)", () => eventsInWindow(events, "claude", NOW - WEEK_MS, NOW), 5);

const officialClaude = makeHistory(1).at(-1);
const officialSet = { claude: officialClaude, grok: null, codex: null };

// one persisted-samples baseline (max retention-ish)
let samples = [];
const hist2000 = makeHistory(2000);
{
  const t0 = performance.now();
  samples = samplesFromOfficialHistory(events, hist2000.slice(0, 200), []);
  const t1 = performance.now();
  console.log(`samplesFromOfficialHistory H=200, E=20k: ${(t1 - t0).toFixed(0)} ms  -> samples=${samples.length}`);
}
{
  const t0 = performance.now();
  const s = samplesFromOfficialHistory(events, hist2000, []);
  const t1 = performance.now();
  console.log(`samplesFromOfficialHistory H=2000, E=20k: ${(t1 - t0).toFixed(0)} ms -> samples=${s.length}`);
  samples = s;
}

// UI tick: 6x quotaValueFor + 6x meterFor + charts
const plan = planById("claude-max-20x");
const planC = planById("chatgpt-plus");
const planG = planById("grok-super");
bench("one dashboard tick (6 quotaValueFor + 6 meterFor + hourlySeries + 3 modelShares)", () => {
  for (const [agent, off] of [["claude", officialClaude], ["grok", null], ["codex", null]]) {
    quotaValueFor(events, agent, off, "weekly", NOW, samples);
    quotaValueFor(events, agent, off, "five_hour", NOW, samples);
  }
  meterFor(events, "claude", plan, NOW, 50);
  meterFor(events, "grok", planG, NOW, 50);
  meterFor(events, "codex", planC, NOW, 50);
  // checkAlerts duplicates
  meterFor(events, "claude", plan, NOW, 50);
  meterFor(events, "grok", planG, NOW, 50);
  meterFor(events, "codex", planC, NOW, 50);
  hourlySeries(events, NOW, 24);
  modelShares(events, "claude", NOW, WEEK_MS);
  modelShares(events, "grok", NOW, WEEK_MS);
  modelShares(events, "codex", NOW, WEEK_MS);
}, 5);

// recordOfficialSamples equivalent (runs 2x per 2.5s cycle)
bench("samplesFromOfficial (recordOfficialSamples, 1 call)", () => {
  samplesFromOfficial(events, officialSet, NOW, samples);
}, 5);

// persist cost
{
  const payload = { quotaSamples: samples, alerts: [] };
  const t0 = performance.now();
  let len = 0;
  for (let i = 0; i < 5; i++) len = JSON.stringify(payload).length;
  const t1 = performance.now();
  console.log(`JSON.stringify(quotaSamples=${samples.length}): ${((t1 - t0) / 5).toFixed(1)} ms/op, ${(len / 1024).toFixed(0)} KB`);
}

// ingest churn: rebuild map + sort of 20k (per agent per 2.5s)
bench("ingest rebuild (Map over 20k + sort)", () => {
  const others = events.filter((e) => e.agent !== "claude");
  const map = new Map(events.filter((e) => e.agent === "claude").map((e) => [e.id, e]));
  const merged = [...others, ...map.values()].sort((a, b) => a.ts - b.ts);
  return merged.length;
}, 5);

// groupSessions (report view)
bench("groupSessions(20k, week)", () => groupSessions(events, NOW, WEEK_MS), 5);
