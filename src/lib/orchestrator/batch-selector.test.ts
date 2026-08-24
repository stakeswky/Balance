import assert from "node:assert/strict";
import { test } from "node:test";
import { selectScheduleBatch } from "./batch-selector.ts";
import { buildAgentSchedulingProfiles } from "./capacity.ts";
import type {
  AgentCapacity,
  AgentSchedulingProfile,
  NativeAgentId,
  OrchestratorTaskPlan,
  TaskPriority,
  TaskSize,
} from "./types.ts";

const NOW = Date.UTC(2026, 7, 25, 1, 0, 0);

function profile(agent: NativeAgentId, remaining: number): AgentSchedulingProfile {
  const capacity: AgentCapacity = {
    agent, enabled: true, installed: true, version: "1", binaryPath: `/native/${agent}`,
    officialRemainingPct: remaining, officialObservedAt: NOW, officialResetsAt: NOW + 60_000,
    officialFresh: true, officialSource: "test", l3RemainingPct: null, l3Confidence: "none",
    l3ObservedAt: null, l3Trusted: false, planningSuccessRate: null,
    executionSuccessRate: null, repairSuccessRate: null, allowUnknownQuota: false,
  };
  return buildAgentSchedulingProfiles({ capacities: [capacity], now: NOW })[0]!;
}

function task(
  id: string,
  size: TaskSize,
  priority: TaskPriority = "normal",
  dependsOn: string[] = [],
  splittable = false,
): OrchestratorTaskPlan {
  return {
    id, title: id, description: `Implement ${id}.`, size, priority, splittable,
    preferredAgent: null, dependsOn, expectedFiles: [`src/${id}.ts`],
    acceptanceCriteria: [`${id} works`],
    verificationCommands: [{ executable: "npm", args: ["run", "test"] }],
  };
}

test("keeps a 39-unit roadmap while selecting a deterministic 6-unit batch", () => {
  const tasks = [
    task("normal-first", "large"),
    task("critical", "large", "critical"),
    task("large-3", "large"),
    task("large-4", "large"),
    task("large-5", "large"),
    task("large-6", "large"),
    task("medium", "medium"),
  ];
  const selected = selectScheduleBatch({
    tasks,
    profiles: [profile("codex", 60), profile("claude", 0), profile("grok", 5)],
    completedTaskIds: new Set(),
    globalMaxConcurrency: 3,
  });

  assert.deepEqual(selected.runnableTasks.map((item) => item.id), ["critical"]);
  assert.equal(selected.runnableTasks[0]?.assignedAgent, "codex");
  assert.equal(selected.deferredTasks.length, 6);
  assert.equal(tasks.reduce((sum, item) => sum + ({ small: 1, medium: 3, large: 6 })[item.size], 0), 39);
});

test("selects only dependency-closed work and prefers a critical closure", () => {
  const selected = selectScheduleBatch({
    tasks: [
      task("foundation", "small", "normal"),
      task("critical-feature", "medium", "critical", ["foundation"]),
      task("independent-high", "medium", "high"),
    ],
    profiles: [profile("codex", 40)],
    completedTaskIds: new Set(),
    globalMaxConcurrency: 1,
  });
  assert.deepEqual(selected.runnableTasks.map((item) => item.id), ["foundation", "critical-feature"]);
  assert.equal(selected.deferredTasks.find((item) => item.taskId === "independent-high")?.reason, "quota");
});

test("does not rerun completed dependencies and produces stable assignments", () => {
  const input = {
    tasks: [task("foundation", "small"), task("feature", "medium", "high", ["foundation"])],
    profiles: [profile("claude", 40), profile("codex", 40)],
    completedTaskIds: new Set(["foundation"]),
    globalMaxConcurrency: 2,
  };
  const first = selectScheduleBatch(input);
  const second = selectScheduleBatch(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.runnableTasks.map((item) => item.id), ["feature"]);
  assert.equal(first.runnableTasks[0]?.assignedAgent, "claude");
});

test("distinguishes planning-only, unavailable and structurally oversized tasks", () => {
  const planningOnly = profile("grok", 5);
  const noCapacity = selectScheduleBatch({
    tasks: [task("small", "small")], profiles: [planningOnly],
    completedTaskIds: new Set(), globalMaxConcurrency: 1,
  });
  assert.equal(noCapacity.runnableTasks.length, 0);
  assert.equal(noCapacity.deferredTasks[0]?.reason, "quota");

  const oversized = selectScheduleBatch({
    tasks: [task("atomic-large", "large", "critical", [], false)],
    profiles: [profile("codex", 50)], completedTaskIds: new Set(), globalMaxConcurrency: 1,
    maximumAgentUnits: { claude: 0, codex: 5, grok: 0 },
  });
  assert.equal(oversized.runnableTasks.length, 0);
  assert.equal(oversized.deferredTasks[0]?.reason, "task_too_large");
  assert.equal(oversized.deferredTasks[0]?.eligibleAfter, null);
});
