import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfficialQuota, OfficialSlice } from "../quota/official.ts";
import { buildTrustedQuotaSnapshot, quotaSnapshotIsFresh } from "./quota-policy.ts";
import { defaultOrchestratorSettings } from "./settings.server.ts";
import type { AgentRuntimeProbe, ClientQuotaEvidence, NativeAgentId } from "./types.ts";

const NOW = Date.UTC(2026, 7, 24, 17, 0, 0);

function client(overrides: Partial<ClientQuotaEvidence> = {}): ClientQuotaEvidence {
  return {
    officialRemainingPct: 99,
    officialObservedAt: NOW,
    officialResetsAt: NOW + 60_000,
    officialFresh: true,
    officialSource: "client-claim",
    l3RemainingPct: 50,
    l3Confidence: "high",
    l3ObservedAt: NOW,
    ...overrides,
  };
}

function slice(agent: NativeAgentId, remainingPct: number, overrides: Partial<OfficialSlice> = {}): OfficialSlice {
  return {
    agent, windowPct: 100 - remainingPct, weekPct: null,
    windowResetsAt: NOW + 60_000, weekResetsAt: null, weekStartedAt: null,
    windowDurationMs: 5 * 60 * 60 * 1_000, weekDurationMs: null, burnPctPerHour: 0,
    planLabel: null, products: [], prepaidBalance: null, onDemandUsed: null, onDemandCap: null,
    source: `${agent}-server`, fetchedAt: NOW, windowKind: "five_hour", ...overrides,
  };
}

function runtimes(): Record<NativeAgentId, AgentRuntimeProbe> {
  return Object.fromEntries((["claude", "codex", "grok"] as const).map((agent) => [agent, {
    agent, ok: true, path: `/native/${agent}`, version: "1", error: null,
  }])) as Record<NativeAgentId, AgentRuntimeProbe>;
}

function build(officialQuota: OfficialQuota, options: {
  trustedL3?: Parameters<typeof buildTrustedQuotaSnapshot>[0]["trustedL3"];
} = {}) {
  return buildTrustedQuotaSnapshot({
    clientEvidence: { claude: client(), codex: client(), grok: client() },
    officialQuota,
    runtimes: runtimes(),
    settings: defaultOrchestratorSettings(),
    trustedL3: options.trustedL3,
    now: NOW,
  });
}

test("server official quota overrides forged client admission while preserving L3 risk", () => {
  const result = build({ claude: slice("claude", 0), codex: slice("codex", 76), grok: slice("grok", 5) });
  const codex = result.profiles.find(({ agent }) => agent === "codex")!;
  assert.equal(codex.officialRemainingPct, 76);
  assert.equal(codex.executionUnits, 7);
  assert.equal(codex.admissionSource, "official");
  assert.equal(codex.l3Trusted, false);
  assert.match(codex.diagnostics.join("\n"), /L3.*50|50.*L3/i);
  assert.equal(result.snapshot.evidence.claude.computedExecutionUnits, 0);
  assert.equal(result.snapshot.evidence.grok.admissionSource, "official");
});

test("stale official data cannot use client L3 as a fallback", () => {
  const stale = slice("codex", 90, { windowStale: true, fetchedAt: NOW - 10 * 60 * 1_000 });
  const result = build({ claude: null, codex: stale, grok: null });
  const codex = result.profiles.find(({ agent }) => agent === "codex")!;
  assert.equal(codex.canPlan, false);
  assert.equal(codex.admissionSource, "excluded");
});

test("server-trusted L3 is a conservative fallback only when official data is stale", () => {
  const result = build(
    { claude: null, codex: null, grok: null },
    { trustedL3: { codex: { remainingPct: 64, confidence: "medium", observedAt: NOW } } },
  );
  const codex = result.profiles.find(({ agent }) => agent === "codex")!;
  assert.equal(codex.admissionSource, "l3-fallback");
  assert.equal(codex.executionUnits, 6);
});

test("snapshot freshness rejects stale and future captures", () => {
  const result = build({ claude: slice("claude", 80), codex: slice("codex", 80), grok: slice("grok", 80) });
  assert.equal(quotaSnapshotIsFresh(result.snapshot, NOW), true);
  assert.equal(quotaSnapshotIsFresh(result.snapshot, NOW + 6 * 60 * 1_000), false);
  assert.equal(quotaSnapshotIsFresh({ ...result.snapshot, capturedAt: NOW + 60_000 }, NOW), false);
});
