import { TASK_UNITS } from "./capacity.ts";
import type {
  AgentSchedulingProfile,
  AssignedTask,
  DeferredReason,
  DeferredTask,
  NativeAgentId,
  OrchestratorTaskPlan,
  ScheduleSelection,
} from "./types.ts";

const AGENTS = ["claude", "codex", "grok"] as const;
const PRIORITY_SCORE = { critical: 2, high: 1, normal: 0 } as const;

interface SelectionCandidate {
  tasks: OrchestratorTaskPlan[];
  assignments: Map<string, NativeAgentId>;
  score: readonly number[];
  stableBits: string;
}

function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assignmentFor(
  tasks: readonly OrchestratorTaskPlan[],
  profiles: readonly AgentSchedulingProfile[],
): Map<string, NativeAgentId> | null {
  const eligible = profiles
    .filter((profile) => profile.canExecute && profile.executionUnits > 0)
    .sort((left, right) => AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent));
  const remaining = new Map(eligible.map((profile) => [profile.agent, profile.executionUnits]));
  const assignments = new Map<string, NativeAgentId>();
  const ordered = tasks.map((task, index) => ({ task, index })).sort((left, right) => (
    TASK_UNITS[right.task.size] - TASK_UNITS[left.task.size]
    || PRIORITY_SCORE[right.task.priority] - PRIORITY_SCORE[left.task.priority]
    || left.index - right.index
  ));

  const visit = (index: number): boolean => {
    if (index === ordered.length) return true;
    const task = ordered[index]!.task;
    const units = TASK_UNITS[task.size];
    const candidates = eligible
      .filter((profile) => (remaining.get(profile.agent) ?? 0) >= units)
      .sort((left, right) => {
        if (task.preferredAgent === left.agent && task.preferredAgent !== right.agent) return -1;
        if (task.preferredAgent === right.agent && task.preferredAgent !== left.agent) return 1;
        return (
          (remaining.get(right.agent) ?? 0) - (remaining.get(left.agent) ?? 0)
          || AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent)
        );
      });
    for (const profile of candidates) {
      remaining.set(profile.agent, (remaining.get(profile.agent) ?? 0) - units);
      assignments.set(task.id, profile.agent);
      if (visit(index + 1)) return true;
      assignments.delete(task.id);
      remaining.set(profile.agent, (remaining.get(profile.agent) ?? 0) + units);
    }
    return false;
  };
  return visit(0) ? assignments : null;
}

function eligibleAfter(
  profiles: readonly AgentSchedulingProfile[],
  agents: readonly NativeAgentId[],
): number | null {
  const resets = profiles
    .filter((profile) => agents.includes(profile.agent))
    .map((profile) => profile.officialResetsAt)
    .filter((value): value is number => value !== null && Number.isSafeInteger(value));
  return resets.length > 0 ? Math.min(...resets) : null;
}

export function selectScheduleBatch(input: {
  tasks: readonly OrchestratorTaskPlan[];
  profiles: readonly AgentSchedulingProfile[];
  completedTaskIds: ReadonlySet<string>;
  globalMaxConcurrency: number;
  maximumAgentUnits?: Record<NativeAgentId, number>;
}): ScheduleSelection {
  if (!Number.isSafeInteger(input.globalMaxConcurrency) || input.globalMaxConcurrency < 1) {
    throw new Error("globalMaxConcurrency must be a positive safe integer");
  }
  if (input.tasks.length > 12) throw new Error("batch selection supports at most 12 tasks");
  const planIds = new Set(input.tasks.map((task) => task.id));
  if (planIds.size !== input.tasks.length) throw new Error("batch selection requires unique task ids");
  const remainingTasks = input.tasks.filter((task) => !input.completedTaskIds.has(task.id));
  const remainingIds = new Set(remainingTasks.map((task) => task.id));
  let best: SelectionCandidate | null = null;

  const subsetCount = 1 << remainingTasks.length;
  for (let mask = 1; mask < subsetCount; mask += 1) {
    const selected = remainingTasks.filter((_, index) => (mask & (1 << index)) !== 0);
    const selectedIds = new Set(selected.map((task) => task.id));
    const dependencyClosed = selected.every((task) => task.dependsOn.every((dependency) => (
      input.completedTaskIds.has(dependency) || selectedIds.has(dependency)
    )));
    if (!dependencyClosed) continue;
    const assignments = assignmentFor(selected, input.profiles);
    if (!assignments) continue;
    const score = [
      selected.filter((task) => task.priority === "critical").length,
      selected.filter((task) => task.priority === "high").length,
      selected.reduce((sum, task) => sum + TASK_UNITS[task.size], 0),
      -selected.length,
    ] as const;
    const stableBits = remainingTasks.map((_, index) => (mask & (1 << index)) !== 0 ? "1" : "0").join("");
    if (
      !best
      || compareNumbers(score, best.score) > 0
      || (compareNumbers(score, best.score) === 0 && stableBits > best.stableBits)
    ) {
      best = { tasks: selected, assignments, score, stableBits };
    }
  }

  const selectedIds = new Set(best?.tasks.map((task) => task.id) ?? []);
  const maximumAgentUnits = input.maximumAgentUnits ?? Object.fromEntries(AGENTS.map((agent) => {
    const profile = input.profiles.find((candidate) => candidate.agent === agent);
    return [agent, profile?.enabled && profile.installed ? 10 : 0];
  })) as Record<NativeAgentId, number>;
  const deferredTasks: DeferredTask[] = remainingTasks
    .filter((task) => !selectedIds.has(task.id))
    .map((task) => {
      const requiredUnits = TASK_UNITS[task.size];
      const potentialAgents = AGENTS.filter((agent) => maximumAgentUnits[agent] >= requiredUnits);
      const currentAgents = input.profiles
        .filter((profile) => profile.canExecute && profile.executionUnits >= requiredUnits)
        .map((profile) => profile.agent);
      const blockedBy = task.dependsOn.filter((dependency) => (
        remainingIds.has(dependency)
        && !input.completedTaskIds.has(dependency)
        && !selectedIds.has(dependency)
      ));
      let reason: DeferredReason;
      if (!task.splittable && potentialAgents.length === 0) {
        reason = "task_too_large";
      } else if (blockedBy.length > 0) {
        reason = "dependency";
      } else if (potentialAgents.length === 0) {
        reason = "agent_unavailable";
      } else if (
        currentAgents.length === 0
        && input.profiles.filter((profile) => potentialAgents.includes(profile.agent))
          .every((profile) => !profile.officialFresh && profile.admissionSource === "excluded")
      ) {
        reason = "stale_quota";
      } else {
        reason = "quota";
      }
      return {
        taskId: task.id,
        reason,
        blockedBy,
        requiredUnits,
        eligibleAgents: potentialAgents,
        eligibleAfter: reason === "task_too_large" || reason === "agent_unavailable"
          ? null
          : eligibleAfter(input.profiles, potentialAgents),
      };
    });
  const runnableTasks: AssignedTask[] = input.tasks
    .filter((task) => selectedIds.has(task.id))
    .map((task) => ({ ...task, assignedAgent: best!.assignments.get(task.id)! }));
  const totalUnits = remainingTasks.reduce((sum, task) => sum + TASK_UNITS[task.size], 0);
  const runnableUnits = runnableTasks.reduce((sum, task) => sum + TASK_UNITS[task.size], 0);
  return {
    runnableTasks,
    deferredTasks,
    diagnostics: [
      `完整剩余计划 ${remainingTasks.length} 项，共 ${totalUnits} 单位。`,
      `当前批次 ${runnableTasks.length} 项，共 ${runnableUnits} 单位；延后 ${deferredTasks.length} 项。`,
      `全局最大并发 ${input.globalMaxConcurrency}，每 Agent 最大并发 1。`,
    ],
  };
}
