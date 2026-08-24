import type {
  AgentCapacity,
  AgentSchedulingProfile,
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

export type AssignmentResult =
  | { status: "ready"; tasks: AssignedTask[]; diagnostics: string[] }
  | { status: "capacity_blocked"; tasks: []; diagnostics: string[] };

function finitePercentage(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function optionalScore(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : -1;
}

function l3CanFallback(capacity: AgentCapacity): boolean {
  const remainingPct = capacity.l3RemainingPct;
  return (
    (capacity.l3Confidence === "medium" || capacity.l3Confidence === "high")
    && capacity.l3Trusted
    && finitePercentage(remainingPct)
    && capacity.l3ObservedAt !== null
    && Number.isSafeInteger(capacity.l3ObservedAt)
  );
}

export function buildAgentSchedulingProfiles(input: {
  capacities: readonly AgentCapacity[];
  now: number;
}): AgentSchedulingProfile[] {
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("profile time is invalid");
  const seen = new Set<NativeAgentId>();
  return input.capacities.map((capacity) => {
    if (seen.has(capacity.agent)) throw new Error(`duplicate capacity row for ${capacity.agent}`);
    seen.add(capacity.agent);
    const exclusionReasons: string[] = [];
    const diagnostics: string[] = [];
    if (!capacity.enabled) exclusionReasons.push("Agent is disabled in server settings");
    if (!capacity.installed || !capacity.binaryPath) exclusionReasons.push("native CLI is unavailable");
    if (capacity.officialFresh && !finitePercentage(capacity.officialRemainingPct)) {
      exclusionReasons.push("fresh official quota is invalid");
    }

    let admissionSource: AgentSchedulingProfile["admissionSource"] = "excluded";
    let admissionRemainingPct: number | null = null;
    let executionUnits = 0;
    if (exclusionReasons.length === 0) {
      if (capacity.officialFresh && finitePercentage(capacity.officialRemainingPct)) {
        admissionSource = "official";
        admissionRemainingPct = capacity.officialRemainingPct;
        executionUnits = Math.floor(capacity.officialRemainingPct / 10);
      } else if (l3CanFallback(capacity)) {
        const l3RemainingPct = capacity.l3RemainingPct!;
        admissionSource = "l3-fallback";
        admissionRemainingPct = l3RemainingPct;
        executionUnits = Math.floor(l3RemainingPct / 10);
        diagnostics.push("官方额度缺失或过期，执行容量使用服务器可信 L3 保守 fallback。");
      } else if (capacity.allowUnknownQuota) {
        admissionSource = "unknown-allowed";
        executionUnits = 1;
        diagnostics.push("额度未知；按已保存的用户策略仅开放 1 个保底执行单位。");
      } else {
        exclusionReasons.push("no fresh official quota or trusted fallback is available");
      }
    }

    if (
      admissionSource === "official"
      && finitePercentage(capacity.l3RemainingPct)
      && capacity.l3Confidence !== "none"
    ) {
      diagnostics.push(
        `L3 风险估值为 ${capacity.l3RemainingPct.toFixed(1)}%，仅作风险提示，不覆盖官方硬准入。`,
      );
    }
    const hasPositiveAdmission = admissionSource === "unknown-allowed"
      || (admissionRemainingPct !== null && admissionRemainingPct > 0);
    const canPlan = exclusionReasons.length === 0 && hasPositiveAdmission;
    const canExecute = canPlan && executionUnits > 0;
    const canRepair = canExecute;
    const planningRisk = canPlan && !canExecute
      ? `官方余额仅 ${admissionRemainingPct?.toFixed(1) ?? "未知"}%，仅允许 planning-only。`
      : admissionSource === "unknown-allowed"
        ? "规划依赖未知额度保底策略。"
        : null;
    const repairRisk = admissionSource === "unknown-allowed" && canRepair
      ? "冲突修复使用未知额度保底策略。"
      : null;
    if (admissionRemainingPct === 0) exclusionReasons.push("official quota is exhausted");
    return {
      ...capacity,
      canPlan,
      canExecute,
      canRepair,
      executionUnits,
      admissionSource,
      admissionRemainingPct,
      planningRisk,
      repairRisk,
      exclusionReasons,
      diagnostics,
    };
  });
}

function comparePlanner(left: AgentSchedulingProfile, right: AgentSchedulingProfile): number {
  return (
    right.executionUnits - left.executionUnits
    || optionalScore(right.admissionRemainingPct) - optionalScore(left.admissionRemainingPct)
    || optionalScore(right.planningSuccessRate) - optionalScore(left.planningSuccessRate)
    || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
  );
}

export function chooseCoordinator(
  profiles: readonly AgentSchedulingProfile[],
  choice: CoordinatorChoice,
): NativeAgentId {
  const eligible = profiles.filter(({ canPlan }) => canPlan);
  if (choice !== "auto") {
    if (eligible.some(({ agent }) => agent === choice)) return choice;
    throw new Error(`requested coordinator ${choice} is not eligible to plan`);
  }
  const selected = [...eligible].sort(comparePlanner)[0];
  if (!selected) throw new Error("no eligible native agent is available for planning");
  return selected.agent;
}

export function chooseRepairAgent(
  profiles: readonly AgentSchedulingProfile[],
  preferred: NativeAgentId | null = null,
): NativeAgentId {
  const eligible = profiles.filter(({ canRepair }) => canRepair);
  if (preferred && eligible.some(({ agent }) => agent === preferred)) return preferred;
  const selected = [...eligible].sort((left, right) => (
    optionalScore(right.repairSuccessRate) - optionalScore(left.repairSuccessRate)
    || right.executionUnits - left.executionUnits
    || optionalScore(right.admissionRemainingPct) - optionalScore(left.admissionRemainingPct)
    || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
  ))[0];
  if (!selected) throw new Error("no eligible native agent is available for repair");
  return selected.agent;
}

function compareTask(
  left: { task: OrchestratorTaskPlan; index: number },
  right: { task: OrchestratorTaskPlan; index: number },
): number {
  return TASK_UNITS[right.task.size] - TASK_UNITS[left.task.size] || left.index - right.index;
}

function compareAssignmentCandidate(
  left: AgentSchedulingProfile,
  right: AgentSchedulingProfile,
  units: number,
  remaining: ReadonlyMap<NativeAgentId, number>,
): number {
  const leftRatio = ((remaining.get(left.agent) ?? 0) - units) / left.executionUnits;
  const rightRatio = ((remaining.get(right.agent) ?? 0) - units) / right.executionUnits;
  return (
    rightRatio - leftRatio
    || optionalScore(right.executionSuccessRate) - optionalScore(left.executionSuccessRate)
    || optionalScore(right.admissionRemainingPct) - optionalScore(left.admissionRemainingPct)
    || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
  );
}

export function assignTasks(
  tasks: readonly OrchestratorTaskPlan[],
  profiles: readonly AgentSchedulingProfile[],
): AssignmentResult {
  const seenAgents = new Set<NativeAgentId>();
  for (const profile of profiles) {
    if (seenAgents.has(profile.agent)) throw new Error(`duplicate scheduling profile for ${profile.agent}`);
    seenAgents.add(profile.agent);
  }
  const eligible = profiles.filter(({ canExecute, executionUnits }) => canExecute && executionUnits > 0);
  const taskIds = new Set<string>();
  for (const item of tasks) {
    if (taskIds.has(item.id)) throw new Error(`duplicate task id: ${item.id}`);
    taskIds.add(item.id);
  }
  const diagnostics = profiles.flatMap((profile) => [
    ...profile.diagnostics.map((message) => `${profile.agent}: ${message}`),
    ...profile.exclusionReasons.map((message) => `${profile.agent}: ${message}`),
  ]);
  const remaining = new Map(eligible.map((profile) => [profile.agent, profile.executionUnits]));
  const totalUnits = tasks.reduce((sum, item) => sum + TASK_UNITS[item.size], 0);
  const availableUnits = [...remaining.values()].reduce((sum, value) => sum + value, 0);
  if (totalUnits > availableUnits) {
    return {
      status: "capacity_blocked",
      tasks: [],
      diagnostics: [...diagnostics, `任务需要 ${totalUnits} 单位，当前可执行容量为 ${availableUnits} 单位。`],
    };
  }
  const assignment = new Map<string, NativeAgentId>();
  const orderedTasks = tasks.map((item, index) => ({ task: item, index })).sort(compareTask);
  for (const { task } of orderedTasks) {
    const units = TASK_UNITS[task.size];
    const candidates = eligible.filter(({ agent }) => (remaining.get(agent) ?? 0) >= units);
    if (candidates.length === 0) {
      return {
        status: "capacity_blocked",
        tasks: [],
        diagnostics: [...diagnostics, `任务 ${task.id} 需要单个 Agent 连续提供 ${units} 单位。`],
      };
    }
    const preferred = task.preferredAgent
      ? candidates.find(({ agent }) => agent === task.preferredAgent)
      : undefined;
    const selected = preferred ?? [...candidates].sort((left, right) => (
      compareAssignmentCandidate(left, right, units, remaining)
    ))[0]!;
    assignment.set(task.id, selected.agent);
    remaining.set(selected.agent, (remaining.get(selected.agent) ?? 0) - units);
  }
  return {
    status: "ready",
    tasks: tasks.map((item) => ({ ...item, assignedAgent: assignment.get(item.id)! })),
    diagnostics,
  };
}
