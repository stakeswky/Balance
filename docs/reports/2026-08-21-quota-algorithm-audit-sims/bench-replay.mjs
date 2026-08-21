// Measure samplesFromOfficialHistory with the REAL codex officialHistory from this machine.
import { performance } from "node:perf_hooks";
import { scanCodexUsage, createCodexScanState } from "../../../src/lib/quota/codex-log.server.ts";
import { samplesFromOfficialHistory } from "../../../src/lib/quota/quota-value.ts";

const res = scanCodexUsage(0, { state: createCodexScanState() });
console.log(`real codex officialHistory H=${res.officialHistory.length}, codex events=${res.events.length}`);

// realEvents in the store = codex events + other agents, capped at 20k. Pad with claude noise.
const NOW = Date.now();
const events = [...res.events];
for (let i = events.length; i < 20000; i++) {
  events.push({
    id: `pad_${i}`, agent: "claude", model: "sonnet", modelRaw: "claude-sonnet-5",
    ts: NOW - 8 * 24 * 3600 * 1000 + Math.floor((i / 20000) * 8 * 24 * 3600 * 1000),
    sessionId: `s${i % 200}`, task: "x", tokensIn: 1000, tokensOut: 500,
    cacheRead: 40000, cacheWrite: 3000, reasoningMin: 0.3,
  });
}
events.sort((a, b) => a.ts - b.ts);

for (const H of [1000, res.officialHistory.length]) {
  const hist = res.officialHistory.slice(-H);
  const t0 = performance.now();
  const out = samplesFromOfficialHistory(events, hist, []);
  const t1 = performance.now();
  console.log(`samplesFromOfficialHistory H=${H}: ${(t1 - t0).toFixed(0)} ms -> samples=${out.length}`);
}
