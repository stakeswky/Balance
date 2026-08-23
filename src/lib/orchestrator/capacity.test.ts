import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TASK_UNITS,
  assignTasks,
  chooseCoordinator,
  scoreEligibleAgents,
} from "./capacity.ts";
import type {
  AgentCapacity,
  NativeAgentId,
  OrchestratorTaskPlan,
  TaskSize,
} from "./types.ts";

function capacity(agent: NativeAgentId, overrides: Partial<AgentCapacity> = {}): AgentCapacity {
  return {
    agent,
    enabled: true,
    installed: true,
    version: "1.0.0",
    binaryPath: `/usr/local/bin/${agent}`,
    remainingLowUsd: null,
    totalHighUsd: null,
    valueConfidence: "none",
    officialRemainingPct: 80,
    recentSuccessRate: null,
    allowUnknownQuota: false,
    ...overrides,
  };
}

function task(id: string, size: TaskSize, preferredAgent: NativeAgentId | null = null): OrchestratorTaskPlan {
  return {
    id,
    title: id,
    description: `完成 ${id}`,
    size,
    preferredAgent,
    dependsOn: [],
    expectedFiles: [`src/${id}.ts`],
    acceptanceCriteria: [`${id} 通过`],
    verificationCommands: [{ executable: "npm", args: ["run", "test"] }],
  };
}

test("maps task sizes to the fixed conservative units", () => {
  assert.deepEqual(TASK_UNITS, { small: 1, medium: 3, large: 6 });
});

test("excludes disabled, missing and unknown-quota agents by default", () => {
  const result = scoreEligibleAgents([
    capacity("claude", { enabled: false }),
    capacity("codex", { installed: false }),
    capacity("grok", { binaryPath: null }),
  ]);
  assert.deepEqual(result, []);
  assert.deepEqual(scoreEligibleAgents([capacity("claude", { officialRemainingPct: null })]), []);
});

test("uses a comparable L3 lower-bound percentage and falls back per agent", () => {
  const result = scoreEligibleAgents([
    capacity("claude", {
      remainingLowUsd: 30,
      totalHighUsd: 60,
      valueConfidence: "medium",
      officialRemainingPct: 90,
    }),
    capacity("codex", {
      remainingLowUsd: 50,
      totalHighUsd: 100,
      valueConfidence: "low",
      officialRemainingPct: 70,
    }),
    capacity("grok", {
      remainingLowUsd: Number.NaN,
      totalHighUsd: 100,
      valueConfidence: "high",
      officialRemainingPct: 40,
    }),
  ]);
  assert.deepEqual(
    result.map(({ agent, scoreSource, conservativeRemainingPct, capacityUnits }) => ({
      agent,
      scoreSource,
      conservativeRemainingPct,
      capacityUnits,
    })),
    [
      { agent: "claude", scoreSource: "l3", conservativeRemainingPct: 50, capacityUnits: 5 },
      { agent: "codex", scoreSource: "official", conservativeRemainingPct: 70, capacityUnits: 7 },
      { agent: "grok", scoreSource: "official", conservativeRemainingPct: 40, capacityUnits: 4 },
    ],
  );
});

test("allows explicitly opted-in unknown quota without fabricating a percentage", () => {
  const [result] = scoreEligibleAgents([
    capacity("grok", { officialRemainingPct: null, allowUnknownQuota: true }),
  ]);
  assert.equal(result?.scoreSource, "unknown-allowed");
  assert.equal(result?.conservativeRemainingPct, 0);
  assert.equal(result?.capacityUnits, 1);
});

test("chooses the coordinator by score, official remainder, success rate and stable order", () => {
  assert.equal(
    chooseCoordinator(
      [
        capacity("claude", { officialRemainingPct: 80, recentSuccessRate: 0.7 }),
        capacity("codex", { officialRemainingPct: 90, recentSuccessRate: 0.2 }),
      ],
      "auto",
    ),
    "codex",
  );
  assert.equal(
    chooseCoordinator(
      [
        capacity("claude", { officialRemainingPct: 80, recentSuccessRate: 0.7 }),
        capacity("codex", { officialRemainingPct: 80, recentSuccessRate: 0.9 }),
      ],
      "auto",
    ),
    "codex",
  );
  assert.equal(
    chooseCoordinator(
      [capacity("grok"), capacity("codex"), capacity("claude")],
      "auto",
    ),
    "claude",
  );
});

test("honors an eligible manual coordinator and rejects an ineligible one", () => {
  const capacities = [capacity("claude"), capacity("codex", { enabled: false })];
  assert.equal(chooseCoordinator(capacities, "claude"), "claude");
  assert.throws(() => chooseCoordinator(capacities, "codex"), /not eligible/i);
  assert.throws(() => chooseCoordinator([], "auto"), /no eligible/i);
});

test("reserves twenty percent of coordinator capacity", () => {
  const result = assignTasks(
    [task("large", "large"), task("medium", "medium")],
    [capacity("claude", { officialRemainingPct: 100 })],
    "claude",
  );
  assert.equal(result.status, "capacity_blocked");

  const fits = assignTasks(
    [task("large", "large"), task("small", "small")],
    [capacity("claude", { officialRemainingPct: 100 })],
    "claude",
  );
  assert.equal(fits.status, "ready");
});

test("assigns large tasks first by highest normalized remaining capacity", () => {
  const result = assignTasks(
    [task("small", "small"), task("large", "large"), task("medium", "medium")],
    [
      capacity("claude", { officialRemainingPct: 100 }),
      capacity("codex", { officialRemainingPct: 90 }),
      capacity("grok", { officialRemainingPct: 70 }),
    ],
    "claude",
  );
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(
    result.tasks.map(({ id, assignedAgent }) => ({ id, assignedAgent })),
    [
      { id: "small", assignedAgent: "grok" },
      { id: "large", assignedAgent: "codex" },
      { id: "medium", assignedAgent: "claude" },
    ],
  );
});

test("uses a preferred agent only when it remains within capacity", () => {
  const result = assignTasks(
    [task("preferred", "medium", "grok"), task("too-large", "large", "grok")],
    [
      capacity("claude", { officialRemainingPct: 100 }),
      capacity("codex", { officialRemainingPct: 100 }),
      capacity("grok", { officialRemainingPct: 50 }),
    ],
    "claude",
  );
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.tasks.find(({ id }) => id === "preferred")?.assignedAgent, "grok");
  assert.equal(result.tasks.find(({ id }) => id === "too-large")?.assignedAgent, "codex");
});

test("returns capacity_blocked for total or fragmented shortfall", () => {
  const total = assignTasks(
    [task("one", "large"), task("two", "large")],
    [capacity("claude", { officialRemainingPct: 60 }), capacity("codex", { officialRemainingPct: 60 })],
    "claude",
  );
  assert.equal(total.status, "capacity_blocked");
  assert.deepEqual(total.tasks, []);

  const fragmented = assignTasks(
    [task("large", "large")],
    [capacity("claude", { officialRemainingPct: 70 }), capacity("codex", { officialRemainingPct: 50 })],
    "claude",
  );
  assert.equal(fragmented.status, "capacity_blocked");
});

test("rejects duplicate capacity rows and an unavailable coordinator", () => {
  assert.throws(() => scoreEligibleAgents([capacity("claude"), capacity("claude")]));
  assert.throws(() => assignTasks([task("small", "small")], [capacity("claude")], "grok"));
});
