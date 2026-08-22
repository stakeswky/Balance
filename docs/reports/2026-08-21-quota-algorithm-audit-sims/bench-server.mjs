// Measure the per-2.5s server-side work with the machine's real logs (read-only).
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { scanClaudeUsage, createScanState } from "../../../src/lib/quota/claude-log.server.ts";
import { scanCodexUsage, createCodexScanState } from "../../../src/lib/quota/codex-log.server.ts";
import { scanGrokUsage, createGrokScanState } from "../../../src/lib/quota/grok-log.server.ts";
import { readCodexOfficialFromSessions } from "../../../src/lib/quota/official.server.ts";
import * as officialMod from "../../../src/lib/quota/official.ts";

const home = homedir();

function t(label, fn) {
  const t0 = performance.now();
  const r = fn();
  const t1 = performance.now();
  console.log(`${label}: ${(t1 - t0).toFixed(0)} ms`);
  return r;
}

// 1) cold scan (since=0, fresh state) — what happens on app start / demo-off resync
const st = createScanState();
const cold = t("scanClaudeUsage COLD (full read of active files)", () =>
  scanClaudeUsage(0, { state: st }),
);
console.log(`  filesRead=${cold.filesRead} events=${cold.events.length}`);
const payload = JSON.stringify(cold);
console.log(`  serverFn JSON payload: ${(payload.length / 1024 / 1024).toFixed(1)} MB`);

// 2) warm scan (nothing changed) — the steady-state per-2.5s cost
t("scanClaudeUsage WARM (walk+stat only)", () => scanClaudeUsage(Date.now(), { state: st }));
t("scanClaudeUsage WARM x2", () => scanClaudeUsage(Date.now(), { state: st }));

const cst = createCodexScanState();
const codexCold = t("scanCodexUsage COLD", () => scanCodexUsage(0, { state: cst }));
console.log(`  filesRead=${codexCold.filesRead} events=${codexCold.events.length} officialHistory=${codexCold.officialHistory.length}`);
t("scanCodexUsage WARM", () => scanCodexUsage(Date.now(), { state: cst }));

const gst = createGrokScanState();
const grokCold = t("scanGrokUsage COLD", () => scanGrokUsage(0, { state: gst }));
console.log(`  filesRead=${grokCold.filesRead} events=${grokCold.events.length}`);
t("scanGrokUsage WARM", () => scanGrokUsage(Date.now(), { state: gst }));

// 3) unconditional per-pullOfficial reads (every 2.5s regardless of 30s cache)
t("readCodexOfficialFromSessions (walk + 8 tails)", () =>
  readCodexOfficialFromSessions(join(home, ".codex")),
);
const grokLogPath = join(home, ".grok", "logs", "unified.jsonl");
t("readGrokLog equivalent (full read + parse unified.jsonl)", () => {
  const raw = readFileSync(grokLogPath, "utf8");
  return officialMod.parseGrokBillingLog(raw);
});
const planHistPath = join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
t("readClaudeOfficial equivalent (parse plan-usage-history.json)", () => {
  const raw = readFileSync(planHistPath, "utf8");
  return officialMod.parseClaudePlanHistory(JSON.parse(raw), Date.now());
});
// history slice count actually produced for the H in samplesFromOfficialHistory
const hist = officialMod.slicesFromClaudeHistory(
  officialMod.parseClaudeHistoryPoints(JSON.parse(readFileSync(planHistPath, "utf8"))),
);
console.log(`claude history slices (H for replay): ${hist.length}`);
const grokAll = officialMod.parseGrokBillingLogAll(readFileSync(grokLogPath, "utf8"));
console.log(`grok history slices: ${grokAll.length}`);
