import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_UNITS, assignTasks, buildAgentSchedulingProfiles, chooseCoordinator, chooseRepairAgent } from "./capacity.ts";
import type { AgentCapacity, NativeAgentId, OrchestratorTaskPlan, TaskSize } from "./types.ts";

const NOW = Date.UTC(2026, 7, 24, 16, 0, 0);

function capacity(agent: NativeAgentId, overrides: Partial<AgentCapacity> = {}): AgentCapacity {
  return {
    agent, enabled: true, installed: true, version: "1.0.0", binaryPath: `/usr/local/bin/${agent}`,
    officialRemainingPct: 80, officialObservedAt: NOW - 1_000, officialResetsAt: NOW + 60_000,
    officialFresh: true, officialSource: `${agent}-official`, l3RemainingPct: null,
    l3Confidence: "none", l3ObservedAt: null, l3Trusted: false, planningSuccessRate: null,
    executionSuccessRate: null, repairSuccessRate: null, allowUnknownQuota: false, ...overrides,
  };
}

function task(id: string, size: TaskSize, preferredAgent: NativeAgentId | null = null): OrchestratorTaskPlan {
  return {
    id, title: id, description: `完成 ${id}`, size, priority: "normal", splittable: false,
    preferredAgent, dependsOn: [],
    expectedFiles: [`src/${id}.ts`], acceptanceCriteria: [`${id} 通过`],
    verificationCommands: [{ executable: "npm", args: ["run", "test"] }],
  };
}

test("maps task sizes to the fixed conservative units", () => {
  assert.deepEqual(TASK_UNITS, { small: 1, medium: 3, large: 6 });
});

test("fresh official quota controls admission while L3 remains a risk diagnostic", () => {
  const [profile] = buildAgentSchedulingProfiles({ capacities: [capacity("codex", {
    officialRemainingPct: 76, l3RemainingPct: 50, l3Confidence: "high", l3ObservedAt: NOW - 2_000,
  })], now: NOW });
  assert.equal(profile?.executionUnits, 7);
  assert.equal(profile?.admissionSource, "official");
  assert.equal(profile?.canPlan, true);
  assert.equal(profile?.canExecute, true);
  assert.equal(profile?.canRepair, true);
  assert.match(profile?.diagnostics.join("\n") ?? "", /L3.*50|50.*L3/i);
});

test("official zero excludes every role and five percent becomes planning-only", () => {
  const [exhausted, planningOnly] = buildAgentSchedulingProfiles({ capacities: [
    capacity("claude", { officialRemainingPct: 0 }), capacity("grok", { officialRemainingPct: 5 }),
  ], now: NOW });
  assert.deepEqual(
    { plan: exhausted?.canPlan, execute: exhausted?.canExecute, repair: exhausted?.canRepair, units: exhausted?.executionUnits },
    { plan: false, execute: false, repair: false, units: 0 },
  );
  assert.deepEqual(
    { plan: planningOnly?.canPlan, execute: planningOnly?.canExecute, repair: planningOnly?.canRepair, units: planningOnly?.executionUnits },
    { plan: true, execute: false, repair: false, units: 0 },
  );
  assert.match(planningOnly?.planningRisk ?? "", /低|5%|planning/i);
});

test("uses trusted L3 only as fallback when official data is unavailable or stale", () => {
  const [profile] = buildAgentSchedulingProfiles({ capacities: [capacity("claude", {
      officialRemainingPct: 90, officialFresh: false, l3RemainingPct: 64,
      l3Confidence: "medium", l3ObservedAt: NOW - 2_000, l3Trusted: true,
  })], now: NOW });
  assert.equal(profile?.admissionSource, "l3-fallback");
  assert.equal(profile?.executionUnits, 6);
});

test("unknown quota requires explicit opt-in and never fabricates a percentage", () => {
  const profiles = buildAgentSchedulingProfiles({ capacities: [
    capacity("claude", { officialRemainingPct: null, officialFresh: false }),
    capacity("grok", { officialRemainingPct: null, officialFresh: false, allowUnknownQuota: true }),
  ], now: NOW });
  assert.equal(profiles[0]?.canPlan, false);
  assert.equal(profiles[1]?.admissionSource, "unknown-allowed");
  assert.equal(profiles[1]?.admissionRemainingPct, null);
  assert.equal(profiles[1]?.executionUnits, 1);
});

test("disabled or missing runtimes are excluded regardless of submitted quota", () => {
  const profiles = buildAgentSchedulingProfiles({ capacities: [
    capacity("claude", { enabled: false }), capacity("codex", { installed: false }),
    capacity("grok", { binaryPath: null }),
  ], now: NOW });
  assert.equal(profiles.every((profile) => !profile.canPlan && !profile.canExecute), true);
});

test("chooses planner and repairer from their independent role eligibility", () => {
  const profiles = buildAgentSchedulingProfiles({ capacities: [
    capacity("claude", { officialRemainingPct: 5, planningSuccessRate: 0.9 }),
    capacity("codex", { officialRemainingPct: 76, planningSuccessRate: 0.8, repairSuccessRate: 0.7 }),
    capacity("grok", { officialRemainingPct: 0 }),
  ], now: NOW });
  assert.equal(chooseCoordinator(profiles, "auto"), "codex");
  assert.equal(chooseCoordinator(profiles, "claude"), "claude");
  assert.throws(() => chooseCoordinator(profiles, "grok"), /not eligible/i);
  assert.equal(chooseRepairAgent(profiles, "claude"), "codex");
});

test("does not deduct coordinator execution capacity and schedules the 76/0/5 large case", () => {
  const profiles = buildAgentSchedulingProfiles({ capacities: [
    capacity("codex", { officialRemainingPct: 76 }), capacity("claude", { officialRemainingPct: 0 }),
    capacity("grok", { officialRemainingPct: 5 }),
  ], now: NOW });
  const result = assignTasks([task("large", "large")], profiles);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.tasks[0]?.assignedAgent, "codex");
});

test("assigns by execution role, preferred fit and stable normalized capacity", () => {
  const profiles = buildAgentSchedulingProfiles({ capacities: [
    capacity("claude", { officialRemainingPct: 100 }), capacity("codex", { officialRemainingPct: 90 }),
    capacity("grok", { officialRemainingPct: 50 }),
  ], now: NOW });
  const result = assignTasks([
    task("small", "small", "grok"), task("large", "large"), task("medium", "medium"),
  ], profiles);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.tasks.find(({ id }) => id === "small")?.assignedAgent, "grok");
  assert.equal(result.tasks.find(({ id }) => id === "large")?.assignedAgent, "claude");
});

test("returns capacity_blocked for total or atomic fragmentation without clearing diagnostics", () => {
  const profiles = buildAgentSchedulingProfiles({ capacities: [
    capacity("claude", { officialRemainingPct: 50 }), capacity("codex", { officialRemainingPct: 50 }),
  ], now: NOW });
  const total = assignTasks([task("one", "large"), task("two", "large")], profiles);
  assert.equal(total.status, "capacity_blocked");
  assert.ok(total.diagnostics.length > 0);
  assert.equal(assignTasks([task("large", "large")], profiles).status, "capacity_blocked");
});

test("rejects duplicate profile rows", () => {
  assert.throws(() => buildAgentSchedulingProfiles({
    capacities: [capacity("claude"), capacity("claude")], now: NOW,
  }), /duplicate/i);
});
