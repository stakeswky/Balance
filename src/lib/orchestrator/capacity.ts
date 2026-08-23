import type {
  AgentCapacity,
  AssignedTask,
  CoordinatorChoice,
  NativeAgentId,
  OrchestratorTaskPlan,
  TaskSize,
} from "./types.ts";

export const TASK_UNITS: Readonly<Record<TaskSize, number>> = Object.freeze({
  small: 1,
  medium: 3,
  large: 6,
});

const AGENT_ORDER: Readonly<Record<NativeAgentId, number>> = Object.freeze({
  claude: 0,
  codex: 1,
  grok: 2,
});

export interface ScoredAgent extends AgentCapacity {
  scoreSource: "l3" | "official" | "unknown-allowed";
  conservativeRemainingPct: number;
  capacityUnits: number;
}

export type AssignmentResult =
  | { status: "ready"; tasks: AssignedTask[]; diagnostics: string[] }
  | { status: "capacity_blocked"; tasks: []; diagnostics: string[] };

function finiteBetween(value: number | null, minimum: number, maximum: number): value is number {
  return value !== null && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function l3RemainingPercent(capacity: AgentCapacity): number | null {
  if (capacity.valueConfidence !== "medium" && capacity.valueConfidence !== "high") return null;
  if (!finiteBetween(capacity.remainingLowUsd, 0, Number.MAX_VALUE)) return null;
  if (!finiteBetween(capacity.totalHighUsd, Number.MIN_VALUE, Number.MAX_VALUE)) return null;
  return Math.max(0, Math.min(100, (capacity.remainingLowUsd / capacity.totalHighUsd) * 100));
}

function scoreAgent(capacity: AgentCapacity): ScoredAgent | null {
  if (!capacity.enabled || !capacity.installed || !capacity.binaryPath) return null;
  const l3Percent = l3RemainingPercent(capacity);
  if (l3Percent !== null) {
    return {
      ...capacity,
      scoreSource: "l3",
      conservativeRemainingPct: l3Percent,
      capacityUnits: Math.floor(l3Percent / 10),
    };
  }
  if (finiteBetween(capacity.officialRemainingPct, 0, 100)) {
    return {
      ...capacity,
      scoreSource: "official",
      conservativeRemainingPct: capacity.officialRemainingPct,
      capacityUnits: Math.floor(capacity.officialRemainingPct / 10),
    };
  }
  if (!capacity.allowUnknownQuota) return null;
  return {
    ...capacity,
    scoreSource: "unknown-allowed",
    conservativeRemainingPct: 0,
    capacityUnits: 1,
  };
}

export function scoreEligibleAgents(capacities: readonly AgentCapacity[]): ScoredAgent[] {
  const seen = new Set<NativeAgentId>();
  const scored: ScoredAgent[] = [];
  for (const capacity of capacities) {
    if (seen.has(capacity.agent)) throw new Error(`duplicate capacity row for ${capacity.agent}`);
    seen.add(capacity.agent);
    const item = scoreAgent(capacity);
    if (item) scored.push(item);
  }
  return scored;
}

function optionalScore(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : -1;
}

function compareCoordinator(left: ScoredAgent, right: ScoredAgent): number {
  return (
    right.conservativeRemainingPct - left.conservativeRemainingPct
    || optionalScore(right.officialRemainingPct) - optionalScore(left.officialRemainingPct)
    || optionalScore(right.recentSuccessRate) - optionalScore(left.recentSuccessRate)
    || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
  );
}

export function chooseCoordinator(
  capacities: readonly AgentCapacity[],
  choice: CoordinatorChoice,
): NativeAgentId {
  const eligible = scoreEligibleAgents(capacities);
  if (choice !== "auto") {
    if (eligible.some(({ agent }) => agent === choice)) return choice;
    throw new Error(`requested coordinator ${choice} is not eligible`);
  }
  const selected = [...eligible].sort(compareCoordinator)[0];
  if (!selected) throw new Error("no eligible native agent is available");
  return selected.agent;
}

function compareTask(
  left: { task: OrchestratorTaskPlan; index: number },
  right: { task: OrchestratorTaskPlan; index: number },
): number {
  return TASK_UNITS[right.task.size] - TASK_UNITS[left.task.size] || left.index - right.index;
}

function compareAssignmentCandidate(
  left: ScoredAgent,
  right: ScoredAgent,
  units: number,
  remaining: ReadonlyMap<NativeAgentId, number>,
  workerCapacity: ReadonlyMap<NativeAgentId, number>,
): number {
  const leftTotal = workerCapacity.get(left.agent) ?? 0;
  const rightTotal = workerCapacity.get(right.agent) ?? 0;
  const leftRatio = ((remaining.get(left.agent) ?? 0) - units) / leftTotal;
  const rightRatio = ((remaining.get(right.agent) ?? 0) - units) / rightTotal;
  return (
    rightRatio - leftRatio
    || right.conservativeRemainingPct - left.conservativeRemainingPct
    || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
  );
}

export function assignTasks(
  tasks: readonly OrchestratorTaskPlan[],
  capacities: readonly AgentCapacity[],
  coordinator: NativeAgentId,
): AssignmentResult {
  const scored = scoreEligibleAgents(capacities);
  if (!scored.some(({ agent }) => agent === coordinator)) {
    throw new Error(`coordinator ${coordinator} is not eligible`);
  }
  const taskIds = new Set<string>();
  for (const item of tasks) {
    if (taskIds.has(item.id)) throw new Error(`duplicate task id: ${item.id}`);
    taskIds.add(item.id);
  }

  const diagnostics = scored
    .filter(({ scoreSource }) => scoreSource === "unknown-allowed")
    .map(({ agent }) => `${agent} 的额度未知，按用户允许仅提供 1 个保底容量单位。`);
  const workerCapacity = new Map<NativeAgentId, number>();
  for (const agent of scored) {
    workerCapacity.set(
      agent.agent,
      agent.agent === coordinator ? Math.floor(agent.capacityUnits * 0.8) : agent.capacityUnits,
    );
  }
  const totalUnits = tasks.reduce((sum, item) => sum + TASK_UNITS[item.size], 0);
  const availableUnits = [...workerCapacity.values()].reduce((sum, value) => sum + value, 0);
  if (totalUnits > availableUnits) {
    return {
      status: "capacity_blocked",
      tasks: [],
      diagnostics: [...diagnostics, `任务需要 ${totalUnits} 单位，负责人预留后只有 ${availableUnits} 单位。`],
    };
  }

  const remaining = new Map(workerCapacity);
  const assignment = new Map<string, NativeAgentId>();
  const orderedTasks = tasks.map((item, index) => ({ task: item, index })).sort(compareTask);
  for (const { task: item } of orderedTasks) {
    const units = TASK_UNITS[item.size];
    const candidates = scored.filter(({ agent }) => (remaining.get(agent) ?? 0) >= units);
    if (candidates.length === 0) {
      return {
        status: "capacity_blocked",
        tasks: [],
        diagnostics: [...diagnostics, `任务 ${item.id} 需要连续 ${units} 单位，没有单个 Agent 可以容纳。`],
      };
    }
    const preferred = item.preferredAgent
      ? candidates.find(({ agent }) => agent === item.preferredAgent)
      : undefined;
    const selected = preferred
      ?? [...candidates].sort((left, right) =>
        compareAssignmentCandidate(left, right, units, remaining, workerCapacity),
      )[0]!;
    assignment.set(item.id, selected.agent);
    remaining.set(selected.agent, (remaining.get(selected.agent) ?? 0) - units);
  }

  return {
    status: "ready",
    tasks: tasks.map((item) => ({ ...item, assignedAgent: assignment.get(item.id)! })),
    diagnostics,
  };
}
