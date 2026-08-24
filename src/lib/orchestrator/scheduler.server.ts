import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildExecuteCommand, type AgentCommand } from "./adapters.ts";
import type { AgentLease, AgentLeaseManager } from "./agent-lease.server.ts";
import {
  CapacityReservationConflictError,
  type CapacityReservation,
  type CapacityReservationManager,
} from "./capacity-reservation.server.ts";
import { TASK_UNITS } from "./capacity.ts";
import type {
  RepositorySnapshot,
  abortCherryPick,
  assertOriginalHeadUnchanged,
  cherryPickTask,
  commitTaskWorktree,
  createIntegrationWorktree,
  createTaskWorktree,
  readWorktreeHead,
  removeRegisteredWorktree,
} from "./git.server.ts";
import { fingerprintPlan } from "./plan.ts";
import type {
  RunningProcess,
  ProcessRunResult,
  startAgentProcess,
} from "./process-runner.server.ts";
import type { RunStore } from "./run-store.server.ts";
import type {
  AgentRuntimeProbe,
  AgentRoleSnapshot,
  NativeAgentId,
  OrchestratorEvent,
  OrchestratorRun,
  QuotaSnapshot,
  ScheduleSelection,
  TaskRunState,
  VerificationCommand,
  WorktreeRegistration,
} from "./types.ts";

const NATIVE_AGENTS = ["claude", "codex", "grok"] as const;

export interface StartRunRequest {
  runId: string;
  fingerprint: string;
  trustedRepository: true;
  confirmedRepository: {
    path: string;
    device: number;
    inode: number;
    baseSha: string;
  };
}

export interface ScheduleHandle {
  completion: Promise<OrchestratorRun>;
  cancel(): Promise<void>;
  interrupt(): Promise<void>;
}

export interface SchedulerDependencies {
  store: RunStore;
  inspectRepository(path: string, mode: "execute"): Promise<RepositorySnapshot>;
  createIntegrationWorktree: typeof createIntegrationWorktree;
  createTaskWorktree: typeof createTaskWorktree;
  readWorktreeHead: typeof readWorktreeHead;
  commitTaskWorktree: typeof commitTaskWorktree;
  cherryPickTask: typeof cherryPickTask;
  abortCherryPick: typeof abortCherryPick;
  assertOriginalHeadUnchanged: typeof assertOriginalHeadUnchanged;
  removeRegisteredWorktree: typeof removeRegisteredWorktree;
  acquireAgentLease: AgentLeaseManager["acquire"];
  reserveWaveCapacity: CapacityReservationManager["reserveWave"];
  availableExecutionUnits(run: OrchestratorRun): Promise<Record<NativeAgentId, number>>;
  refreshSchedule(run: OrchestratorRun): Promise<{
    selection: ScheduleSelection;
    quotaSnapshot: QuotaSnapshot;
    agentProfiles: AgentRoleSnapshot[];
  }>;
  repairAgentFor(run: OrchestratorRun): Promise<NativeAgentId>;
  runtimeFor(agent: NativeAgentId): Promise<AgentRuntimeProbe>;
  startProcess(input: Parameters<typeof startAgentProcess>[0]): RunningProcess;
  runVerification(input: {
    command: VerificationCommand;
    cwd: string;
    signal: AbortSignal;
  }): Promise<ProcessRunResult>;
  now(): number;
  stateRoot: string;
  maxConcurrency?: 1 | 2 | 3;
  conflictedFiles?(integrationPath: string): Promise<string[]>;
  prepareAgentCommand(input: {
    command: AgentCommand;
    agent: NativeAgentId;
    runId: string;
    taskId: string;
  }): Promise<{ command: AgentCommand; secrets: readonly string[]; cleanup(): Promise<void> }>;
}

class CancelledError extends Error {
  constructor() {
    super("orchestrator run was cancelled");
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 20_000);
}

function startReservationHeartbeat(
  reservation: CapacityReservation,
  onFailure: (error: unknown) => void,
): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight
      .then(() => reservation.renew())
      .catch((error: unknown) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        onFailure(error);
      });
  }, reservation.renewalIntervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

function hasAssignedAgent(
  task: TaskRunState,
): task is TaskRunState & { assignedAgent: NativeAgentId } {
  return task.assignedAgent !== null;
}

function assignWaveForAvailableCapacity(
  tasks: readonly (TaskRunState & { assignedAgent: NativeAgentId })[],
  availableUnits: Readonly<Record<NativeAgentId, number>>,
): Map<string, NativeAgentId> | null {
  const remaining = new Map(NATIVE_AGENTS.map((agent) => [agent, availableUnits[agent]]));
  const used = new Set<NativeAgentId>();
  const assignments = new Map<string, NativeAgentId>();
  const ordered = tasks.map((task, index) => ({ task, index })).sort((left, right) => (
    TASK_UNITS[right.task.size] - TASK_UNITS[left.task.size] || left.index - right.index
  ));
  const visit = (index: number): boolean => {
    if (index === ordered.length) return true;
    const task = ordered[index]!.task;
    const requiredUnits = TASK_UNITS[task.size];
    const candidates = NATIVE_AGENTS
      .filter((agent) => !used.has(agent) && (remaining.get(agent) ?? 0) >= requiredUnits)
      .sort((left, right) => {
        if (left === task.assignedAgent && right !== task.assignedAgent) return -1;
        if (right === task.assignedAgent && left !== task.assignedAgent) return 1;
        return NATIVE_AGENTS.indexOf(left) - NATIVE_AGENTS.indexOf(right);
      });
    for (const agent of candidates) {
      used.add(agent);
      remaining.set(agent, (remaining.get(agent) ?? 0) - requiredUnits);
      assignments.set(task.id, agent);
      if (visit(index + 1)) return true;
      assignments.delete(task.id);
      remaining.set(agent, (remaining.get(agent) ?? 0) + requiredUnits);
      used.delete(agent);
    }
    return false;
  };
  return visit(0) ? assignments : null;
}

function summarizeAgentEvents(events: readonly OrchestratorEvent[]) {
  let sessionId: string | null = null;
  for (const event of events) {
    if (event.type === "session_started") sessionId = event.sessionId;
  }
  const usageEvents = events.filter((event) => event.type === "usage");
  const usage = usageEvents.length === 0 ? null : usageEvents.reduce((total, event) => ({
    inputTokens: total.inputTokens + event.inputTokens,
    outputTokens: total.outputTokens + event.outputTokens,
    cachedInputTokens: total.cachedInputTokens + event.cachedInputTokens,
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  return { sessionId, usage };
}

function assertStartRequest(request: StartRunRequest, run: OrchestratorRun): void {
  if (request.trustedRepository !== true)
    throw new Error("repository trust confirmation is required");
  if (request.runId !== run.id) throw new Error("run id does not match persisted run");
  const { fingerprint: _fingerprint, createdAt: _createdAt, ...fingerprintInput } = run.draft;
  const computed = fingerprintPlan(fingerprintInput);
  if (request.fingerprint !== run.draft.fingerprint || computed !== run.draft.fingerprint) {
    throw new Error("plan fingerprint changed after confirmation");
  }
  if (run.draft.repositoryDirtyAtAnalysis) {
    throw new Error("repository was dirty during analysis; reanalyze before starting");
  }
  const confirmed = request.confirmedRepository;
  if (
    confirmed.path !== run.draft.repositoryPath ||
    confirmed.device !== run.draft.repositoryDevice ||
    confirmed.inode !== run.draft.repositoryInode ||
    confirmed.baseSha !== run.draft.baseSha
  ) {
    throw new Error("confirmed repository identity does not match the analyzed repository");
  }
}

function assertCurrentRepository(run: OrchestratorRun, current: RepositorySnapshot): void {
  if (
    current.dirty ||
    current.root !== run.draft.repositoryPath ||
    current.device !== run.draft.repositoryDevice ||
    current.inode !== run.draft.repositoryInode ||
    current.branch !== run.draft.baseBranch ||
    current.head !== run.draft.baseSha
  ) {
    throw new Error("repository identity, branch, base SHA or clean state changed after analysis");
  }
}

function statusForSelection(run: OrchestratorRun, selection: ScheduleSelection): OrchestratorRun["status"] {
  const completedCount = run.tasks.filter((task) => task.status === "completed").length;
  const remainingCount = run.draft.plan.tasks.length - completedCount;
  if (remainingCount === 0) return "completed";
  if (selection.runnableTasks.length === 0) {
    return selection.deferredTasks.some((task) => task.reason === "task_too_large")
      ? "unschedulable"
      : "waiting_quota";
  }
  return selection.runnableTasks.length === remainingCount && completedCount === 0
    ? "draft"
    : "partial_ready";
}

function applyScheduleRefresh(
  run: OrchestratorRun,
  selection: ScheduleSelection,
  quotaSnapshot: QuotaSnapshot,
  agentProfiles: AgentRoleSnapshot[],
  now: number,
): OrchestratorRun {
  const assignments = new Map(selection.runnableTasks.map((task) => [task.id, task.assignedAgent]));
  const completed = new Set(run.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return {
    ...run,
    status: statusForSelection(run, selection),
    error: selection.deferredTasks.length > 0 ? selection.diagnostics.join("\n").slice(0, 20_000) : null,
    draft: {
      ...run.draft,
      assignedTasks: selection.runnableTasks,
      runnableTasks: selection.runnableTasks,
      deferredTasks: selection.deferredTasks,
      scheduleDiagnostics: selection.diagnostics,
      quotaSnapshot,
      agentProfiles,
    },
    tasks: run.tasks.map((task) => {
      if (completed.has(task.id)) return task;
      const assignedAgent = assignments.get(task.id) ?? null;
      return {
        ...task,
        assignedAgent,
        status: assignedAgent ? "queued" : "blocked",
        worktree: null,
        commitSha: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      };
    }),
    updatedAt: Math.max(now, run.updatedAt + 1),
  };
}

const execFileAsync = promisify(execFile);

async function defaultConflictedFiles(integrationPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-c",
      "core.attributesFile=/dev/null",
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ],
    {
      cwd: integrationPath,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/var/empty",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_EXTERNAL_DIFF: "",
        GIT_ATTR_NOSYSTEM: "1",
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );
  return stdout.split("\0").filter(Boolean);
}

export async function resolveIntegrationConflict(
  input: {
    run: OrchestratorRun;
    taskId: string;
    commitSha: string;
    integrationPath: string;
    conflictFiles: readonly string[];
    repairAgent: NativeAgentId;
    signal: AbortSignal;
  },
  dependencies: SchedulerDependencies,
): Promise<string> {
  const task = input.run.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task) throw new Error(`conflict task not found: ${input.taskId}`);
  if (input.signal.aborted) throw new CancelledError();
  const runtime = await dependencies.runtimeFor(input.repairAgent);
  if (!runtime.ok || !runtime.path)
    throw new Error("selected native CLI is unavailable for conflict repair");
  const conflictTask = {
    ...task,
    assignedAgent: input.repairAgent,
    description: [
      "Resolve exactly one integration conflict after the failed cherry-pick was aborted.",
      `Original task: ${task.title} — ${task.description}`,
      `Task commit: ${input.commitSha}`,
      `Conflicted files: ${input.conflictFiles.join(", ")}`,
      `Confirmed verification commands: ${JSON.stringify(task.verificationCommands)}`,
      "Apply only the changes needed to integrate that task. Do not commit.",
    ].join("\n"),
    expectedFiles: input.conflictFiles.length > 0 ? [...input.conflictFiles] : task.expectedFiles,
  };
  const baseCommand = buildExecuteCommand({
    agent: input.repairAgent,
    binaryPath: runtime.path,
    worktreePath: input.integrationPath,
    task: conflictTask,
  });
  const prepared = await dependencies.prepareAgentCommand({
    command: baseCommand,
    agent: input.repairAgent,
    runId: input.run.id,
    taskId: `conflict:${input.taskId}`,
  });
  let lease: AgentLease | null = null;
  let capacityReservation: CapacityReservation | null = null;
  let reservationHeartbeat: { stop(): Promise<void> } | null = null;
  let reservationFailure: unknown = null;
  let runningProcess: RunningProcess | null = null;
  const startedAt = dependencies.now();
  const activityEvents: OrchestratorEvent[] = [];
  let succeeded = false;
  try {
    capacityReservation = await dependencies.reserveWaveCapacity({
      runId: input.run.id,
      waveId: `repair-${input.taskId}`,
      requests: { [input.repairAgent]: 1 },
      availableUnits: await dependencies.availableExecutionUnits(input.run),
      signal: input.signal,
    });
    reservationHeartbeat = startReservationHeartbeat(capacityReservation, (error) => {
      reservationFailure ??= error;
      void runningProcess?.cancel().catch(() => undefined);
    });
    lease = await dependencies.acquireAgentLease({
      agent: input.repairAgent,
      runId: input.run.id,
      taskId: `conflict:${input.taskId}`,
      role: "repair",
      signal: input.signal,
    });
    const process = dependencies.startProcess({
      command: prepared.command,
      agent: input.repairAgent,
      signal: input.signal,
      secrets: prepared.secrets,
      async onEvent(event) {
        activityEvents.push(event);
        await dependencies.store.appendEvent({
          runId: input.run.id,
          taskId: input.taskId,
          agent: input.repairAgent,
          at: dependencies.now(),
          event,
        });
      },
    });
    runningProcess = process;
    const result = await process.completion;
    if (reservationFailure) {
      throw new Error(`repair capacity reservation renewal failed: ${errorMessage(reservationFailure)}`);
    }
    if (input.signal.aborted) throw new CancelledError();
    if (result.exitCode !== 0)
      throw new Error(`coordinator conflict repair exited with code ${result.exitCode}`);
    for (const verificationCommand of task.verificationCommands) {
      const verification = await dependencies.runVerification({
        command: verificationCommand,
        cwd: input.integrationPath,
        signal: input.signal,
      });
      if (reservationFailure) {
        throw new Error(`repair capacity reservation renewal failed: ${errorMessage(reservationFailure)}`);
      }
      if (verification.exitCode !== 0) throw new Error(`conflict verification failed for ${task.id}`);
    }
    const commitSha = await dependencies.commitTaskWorktree(
      input.integrationPath,
      `fix(orchestrator): resolve ${task.id} integration conflict`,
    );
    if (reservationFailure) {
      throw new Error(`repair capacity reservation renewal failed: ${errorMessage(reservationFailure)}`);
    }
    succeeded = true;
    return commitSha;
  } finally {
    try {
      await reservationHeartbeat?.stop();
    } finally {
      try {
        await prepared.cleanup();
      } finally {
        try {
          await lease?.release();
        } finally {
          try {
            await capacityReservation?.release();
          } finally {
            const { sessionId, usage } = summarizeAgentEvents(activityEvents);
            await dependencies.store.appendActivity({
              runId: input.run.id,
              taskId: input.taskId,
              agent: input.repairAgent,
              role: "repair",
              startedAt,
              finishedAt: Math.max(dependencies.now(), startedAt),
              success: succeeded,
              sessionId,
              usage,
              events: activityEvents,
            });
          }
        }
      }
    }
  }
}

export async function scheduleRun(
  request: StartRunRequest,
  dependencies: SchedulerDependencies,
): Promise<ScheduleHandle> {
  let initial = await dependencies.store.get(request.runId);
  if (!initial) throw new Error(`orchestrator run not found: ${request.runId}`);
  if (initial.status === "capacity_blocked") throw new Error("capacity_blocked plans cannot start");
  if (!["draft", "partial_ready", "waiting_quota", "partial_completed"].includes(initial.status)) {
    throw new Error(`run cannot start from ${initial.status}`);
  }
  assertStartRequest(request, initial);
  const repository = await dependencies.inspectRepository(initial.repositoryPath, "execute");
  assertCurrentRepository(initial, repository);
  const refreshed = await dependencies.refreshSchedule(initial);
  let scheduled = await dependencies.store.update(initial.id, (run) => applyScheduleRefresh(
    run,
    refreshed.selection,
    refreshed.quotaSnapshot,
    refreshed.agentProfiles,
    dependencies.now(),
  ));
  if (scheduled.status === "waiting_quota" || scheduled.status === "unschedulable") {
    return {
      completion: Promise.resolve(scheduled),
      cancel: async () => undefined,
      interrupt: async () => undefined,
    };
  }
  scheduled = await dependencies.store.update(initial.id, (run) => ({
    ...run,
    status: "ready",
    repositoryTrustedAt: dependencies.now(),
    updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
  }));
  initial = scheduled;

  let cancelRequested = false;
  let interruptRequested = false;
  let terminal = false;
  const taskControllers = new Map<string, AbortController>();
  const runningProcesses = new Map<string, RunningProcess>();
  const runController = new AbortController();

  const update = (mutate: (run: OrchestratorRun) => OrchestratorRun) =>
    dependencies.store.update(request.runId, mutate);

  const markTask = (
    taskId: string,
    mutate: (task: OrchestratorRun["tasks"][number]) => OrchestratorRun["tasks"][number],
  ) =>
    update((run) => ({
      ...run,
      tasks: run.tasks.map((task) => (task.id === taskId ? mutate(task) : task)),
      updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
    }));

  const cleanupTask = async (taskId: string): Promise<void> => {
    const current = await dependencies.store.get(request.runId);
    if (!current?.tasks.find((task) => task.id === taskId)?.worktree) return;
    await dependencies.removeRegisteredWorktree({
      store: dependencies.store,
      repositoryRoot: initial.repositoryPath,
      runId: request.runId,
      slot: { kind: "task", taskId },
      stateRoot: dependencies.stateRoot,
    });
  };

  const executeTask = async (
    taskId: string,
    baseSha: string,
    integrationWorktree: WorktreeRegistration,
  ): Promise<void> => {
    if (cancelRequested) throw new CancelledError();
    const activityTask = initial.tasks.find((candidate) => candidate.id === taskId);
    if (!activityTask || !hasAssignedAgent(activityTask)) {
      throw new Error(`task has no current Agent assignment: ${taskId}`);
    }
    const activityStartedAt = dependencies.now();
    const activityEvents: OrchestratorEvent[] = [];
    let activitySucceeded = false;
    let activityAgent = activityTask.assignedAgent;
    const controller = new AbortController();
    taskControllers.set(taskId, controller);
    let prepared: Awaited<ReturnType<SchedulerDependencies["prepareAgentCommand"]>> | null = null;
    let lease: AgentLease | null = null;
    try {
      const current = await dependencies.store.get(request.runId);
      const task = current?.tasks.find((candidate) => candidate.id === taskId);
      if (!current || !task || !hasAssignedAgent(task)) {
        throw new Error(`task disappeared or is unassigned: ${taskId}`);
      }
      activityAgent = task.assignedAgent;
      await markTask(taskId, (state) => ({
        ...state,
        status: "preparing",
        startedAt: dependencies.now(),
      }));
      const worktree = await dependencies.createTaskWorktree({
        repository,
        runId: request.runId,
        taskId,
        stateRoot: dependencies.stateRoot,
        baseSha,
        integrationWorktree,
      });
      await markTask(taskId, (state) => ({
        ...state,
        worktree,
      }));
      if (cancelRequested || controller.signal.aborted) throw new CancelledError();
      const runtime = await dependencies.runtimeFor(task.assignedAgent);
      if (!runtime.ok || !runtime.path)
        throw new Error(`${task.assignedAgent} native CLI is unavailable`);
      const baseCommand = buildExecuteCommand({
        agent: task.assignedAgent,
        binaryPath: runtime.path,
        worktreePath: worktree.path,
        task,
      });
      prepared = await dependencies.prepareAgentCommand({
        command: baseCommand,
        agent: task.assignedAgent,
        runId: request.runId,
        taskId,
      });
      lease = await dependencies.acquireAgentLease({
        agent: task.assignedAgent,
        runId: request.runId,
        taskId,
        role: "execution",
        signal: controller.signal,
      });
      if (cancelRequested || controller.signal.aborted) throw new CancelledError();
      await markTask(taskId, (state) => ({ ...state, status: "running" }));
      const process = dependencies.startProcess({
        command: prepared.command,
        agent: task.assignedAgent,
        signal: controller.signal,
        secrets: prepared.secrets,
        async onEvent(event) {
          activityEvents.push(event);
          await dependencies.store.appendEvent({
            runId: request.runId,
            taskId,
            agent: task.assignedAgent,
            at: dependencies.now(),
            event,
          });
        },
      });
      runningProcesses.set(taskId, process);
      const processResult = await process.completion;
      if (cancelRequested || controller.signal.aborted) throw new CancelledError();
      if (processResult.exitCode !== 0)
        throw new Error(`native Agent exited with code ${processResult.exitCode}`);
      await markTask(taskId, (state) => ({ ...state, status: "verifying" }));
      for (const verificationCommand of task.verificationCommands) {
        if (cancelRequested || controller.signal.aborted) throw new CancelledError();
        const result = await dependencies.runVerification({
          command: verificationCommand,
          cwd: worktree.path,
          signal: controller.signal,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `verification failed: ${verificationCommand.executable} ${verificationCommand.args.join(" ")}`,
          );
        }
      }
      const commitSha = await dependencies.commitTaskWorktree(
        worktree.path,
        `balance(${task.id}): ${task.title}`,
      );
      await markTask(taskId, (state) => ({ ...state, status: "integrating", commitSha }));
      activitySucceeded = true;
    } finally {
      runningProcesses.delete(taskId);
      taskControllers.delete(taskId);
      try {
        await prepared?.cleanup();
      } finally {
        try {
          await lease?.release();
        } finally {
          const { sessionId, usage } = summarizeAgentEvents(activityEvents);
          await dependencies.store.appendActivity({
            runId: request.runId,
            taskId,
            agent: activityAgent,
            role: "execution",
            startedAt: activityStartedAt,
            finishedAt: Math.max(dependencies.now(), activityStartedAt),
            success: activitySucceeded,
            sessionId,
            usage,
            events: activityEvents,
          });
        }
      }
    }
  };

  const failTask = async (taskId: string, error: unknown): Promise<void> => {
    const current = await dependencies.store.get(request.runId);
    const task = current?.tasks.find((candidate) => candidate.id === taskId);
    if (!task || ["completed", "failed", "cancelled", "interrupted"].includes(task.status)) return;
    await markTask(taskId, (state) => ({
      ...state,
      status:
        error instanceof CancelledError
          ? interruptRequested
            ? "interrupted"
            : "cancelled"
          : "failed",
      error: errorMessage(error),
      finishedAt: dependencies.now(),
    }));
  };

  const finishCancelled = async (): Promise<OrchestratorRun> => {
    const current = await dependencies.store.get(request.runId);
    if (!current) throw new Error("run disappeared during cancellation");
    const terminalStatus = interruptRequested ? "interrupted" : "cancelled";
    let cancelling = current;
    if (!interruptRequested && ["running", "integrating", "verifying"].includes(current.status)) {
      cancelling = await update((run) => ({
        ...run,
        status: "cancelling",
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      }));
    }
    if (cancelling.status === "ready") {
      return update((run) => ({
        ...run,
        status: terminalStatus,
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      }));
    }
    return update((run) => ({
      ...run,
      status: terminalStatus,
      tasks: run.tasks.map((task) =>
        ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ? task
          : { ...task, status: terminalStatus, finishedAt: dependencies.now() },
      ),
      updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
    }));
  };

  const execute = async (): Promise<OrchestratorRun> => {
    try {
      if (cancelRequested) return finishCancelled();
      await update((run) => ({
        ...run,
        status: "running",
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      }));
      const integration = initial.integrationWorktree ?? await dependencies.createIntegrationWorktree({
        repository,
        runId: request.runId,
        stateRoot: dependencies.stateRoot,
      });
      if (!initial.integrationWorktree) {
        await update((run) => ({
          ...run,
          integrationWorktree: integration,
          resultBranch: integration.branch,
          updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
        }));
      }
      const integrated = new Set(initial.tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.id));
      const pending = new Set(initial.tasks
        .filter(hasAssignedAgent)
        .filter((task) => task.status === "queued")
        .map((task) => task.id));
      const maxConcurrency = dependencies.maxConcurrency ?? 3;
      let waveNumber = 0;
      while (pending.size > 0) {
        if (cancelRequested) throw new CancelledError();
        const baseSha = await dependencies.readWorktreeHead(integration.path);
        const usedAgents = new Set<NativeAgentId>();
        const plannedWave = initial.tasks
          .filter(hasAssignedAgent)
          .filter(
            (task) =>
              pending.has(task.id) &&
              task.dependsOn.every((dependency) => integrated.has(dependency)) &&
              !usedAgents.has(task.assignedAgent) &&
              (usedAgents.add(task.assignedAgent), true),
          )
          .slice(0, maxConcurrency);
        if (plannedWave.length === 0) throw new Error("no runnable task remains in the dependency graph");
        waveNumber += 1;
        let currentBeforeWave = await dependencies.store.get(request.runId);
        if (!currentBeforeWave) throw new Error("run disappeared before wave reservation");
        const availableUnits = await dependencies.availableExecutionUnits(currentBeforeWave);
        const refreshedAssignments = assignWaveForAvailableCapacity(plannedWave, availableUnits);
        const wave = plannedWave.map((task) => ({
          ...task,
          assignedAgent: refreshedAssignments?.get(task.id) ?? task.assignedAgent,
        }));
        if (wave.some((task, index) => task.assignedAgent !== plannedWave[index]?.assignedAgent)) {
          const reassigned = new Map(wave.map((task) => [task.id, task.assignedAgent]));
          currentBeforeWave = await update((run) => ({
            ...run,
            draft: {
              ...run.draft,
              assignedTasks: run.draft.assignedTasks.map((task) => ({
                ...task,
                assignedAgent: reassigned.get(task.id) ?? task.assignedAgent,
              })),
              runnableTasks: run.draft.runnableTasks?.map((task) => ({
                ...task,
                assignedAgent: reassigned.get(task.id) ?? task.assignedAgent,
              })),
            },
            tasks: run.tasks.map((task) => ({
              ...task,
              assignedAgent: reassigned.get(task.id) ?? task.assignedAgent,
            })),
            updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
          }));
        }
        const requests = wave.reduce<Partial<Record<NativeAgentId, number>>>((totals, task) => {
          totals[task.assignedAgent] = (totals[task.assignedAgent] ?? 0) + TASK_UNITS[task.size];
          return totals;
        }, {});
        let reservation: CapacityReservation;
        try {
          reservation = await dependencies.reserveWaveCapacity({
            runId: request.runId,
            waveId: `wave-${waveNumber}`,
            requests,
            availableUnits,
            signal: runController.signal,
          });
        } catch (error) {
          if (!(error instanceof CapacityReservationConflictError)) throw error;
          const conflictAgents = error.conflicts.map((conflict) => conflict.agent);
          const hasOtherRunReservation = error.conflicts.some(
            (conflict) => conflict.reservedByOtherRuns > 0,
          );
          const waiting = await update((run) => {
            const completedIds = new Set(run.tasks
              .filter((task) => task.status === "completed")
              .map((task) => task.id));
            const deferredTasks = run.draft.plan.tasks
              .filter((task) => !completedIds.has(task.id))
              .map((task) => ({
                taskId: task.id,
                reason: hasOtherRunReservation ? "reservation_conflict" as const : "quota" as const,
                blockedBy: task.dependsOn.filter((dependency) => !completedIds.has(dependency)),
                requiredUnits: TASK_UNITS[task.size],
                eligibleAgents: conflictAgents,
                eligibleAfter: null,
              }));
            const diagnostics = [
              hasOtherRunReservation
                ? "其他运行正在使用本批所需的 Agent 软容量；没有启动新的原生 Agent。"
                : "本波启动前官方额度已下降；没有按旧快照启动原生 Agent。",
              ...error.conflicts.map((conflict) => (
                `${conflict.agent}: 需要 ${conflict.requestedUnits}，扣除其他运行预订后可用 ${conflict.availableUnits}。`
              )),
            ];
            return {
              ...run,
              status: "waiting_quota",
              error: diagnostics.join("\n"),
              draft: {
                ...run.draft,
                assignedTasks: [],
                runnableTasks: [],
                deferredTasks,
                scheduleDiagnostics: diagnostics,
              },
              tasks: run.tasks.map((task) => completedIds.has(task.id)
                ? task
                : { ...task, assignedAgent: null, status: "blocked" }),
              updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
            };
          });
          terminal = true;
          return waiting;
        }
        let reservationFailure: unknown = null;
        const reservationHeartbeat = startReservationHeartbeat(reservation, (error) => {
          reservationFailure ??= error;
          for (const controller of taskControllers.values()) controller.abort();
          void Promise.allSettled([...runningProcesses.values()].map((process) => process.cancel()));
        });
        const assertReservationHealthy = (): void => {
          if (reservationFailure) {
            throw new Error(
              `wave capacity reservation renewal failed: ${errorMessage(reservationFailure)}`,
            );
          }
        };
        const results = await Promise.allSettled(
          wave.map((task) => executeTask(task.id, baseSha, integration)),
        );
        try {
          assertReservationHealthy();
          let failure: unknown = null;
          for (let index = 0; index < wave.length; index += 1) {
            assertReservationHealthy();
            const task = wave[index]!;
            const result = results[index]!;
            pending.delete(task.id);
            if (result.status === "rejected") {
              failure ??= result.reason;
              await failTask(task.id, result.reason);
              continue;
            }
            if (cancelRequested) throw new CancelledError();
            const current = await dependencies.store.get(request.runId);
            const state = current?.tasks.find((candidate) => candidate.id === task.id);
            if (!state?.commitSha || !current?.integrationWorktree) {
              const error = new Error(`task ${task.id} has no commit to integrate`);
              failure ??= error;
              await failTask(task.id, error);
              continue;
            }
            try {
              await dependencies.assertOriginalHeadUnchanged(repository);
              try {
                await dependencies.cherryPickTask(current.integrationWorktree.path, state.commitSha);
              } catch (error) {
                const conflicts = await (dependencies.conflictedFiles ?? defaultConflictedFiles)(
                  current.integrationWorktree.path,
                );
                await dependencies.abortCherryPick(current.integrationWorktree.path);
                if (conflicts.length === 0) throw error;
                if (cancelRequested) throw new CancelledError();
                const conflictController = new AbortController();
                taskControllers.set(`conflict:${task.id}`, conflictController);
                try {
                  const repairAgent = await dependencies.repairAgentFor(current);
                  await resolveIntegrationConflict(
                    {
                      run: current,
                      taskId: task.id,
                      commitSha: state.commitSha,
                      integrationPath: current.integrationWorktree.path,
                      conflictFiles: conflicts,
                      repairAgent,
                      signal: conflictController.signal,
                    },
                    dependencies,
                  );
                } finally {
                  taskControllers.delete(`conflict:${task.id}`);
                }
              }
              await markTask(task.id, (taskState) => ({
                ...taskState,
                status: "completed",
                finishedAt: dependencies.now(),
              }));
              assertReservationHealthy();
              integrated.add(task.id);
              await cleanupTask(task.id);
            } catch (error) {
              failure ??= error;
              await failTask(task.id, error);
              break;
            }
          }
          if (failure) {
            if (failure instanceof CancelledError || cancelRequested) throw new CancelledError();
            await update((run) => ({
              ...run,
              status: integrated.size > 0 ? "partial_completed" : "failed",
              error: errorMessage(failure),
              tasks: run.tasks.map((task) => {
                if (pending.has(task.id) && ["queued", "blocked"].includes(task.status)) {
                  return { ...task, status: "blocked" };
                }
                if (task.status === "integrating") {
                  return {
                    ...task,
                    status: "failed",
                    error: "run failed before integration",
                    finishedAt: dependencies.now(),
                  };
                }
                return task;
              }),
              updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
            }));
            for (const task of initial.tasks) await cleanupTask(task.id).catch(() => undefined);
            return (await dependencies.store.get(request.runId))!;
          }
        } finally {
          try {
            await reservationHeartbeat.stop();
          } finally {
            await reservation.release();
          }
        }
      }
      await dependencies.assertOriginalHeadUnchanged(repository);
      await update((run) => ({
        ...run,
        status: "verifying",
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      }));
      const verifying = await dependencies.store.get(request.runId);
      if (!verifying?.integrationWorktree)
        throw new Error("integration worktree disappeared before final verification");
      for (const task of verifying.tasks.filter((task) => task.status === "completed")) {
        for (const verificationCommand of task.verificationCommands) {
          const result = await dependencies.runVerification({
            command: verificationCommand,
            cwd: verifying.integrationWorktree.path,
            signal: new AbortController().signal,
          });
          if (result.exitCode !== 0) throw new Error(`final verification failed for ${task.id}`);
        }
      }
      const hasDeferredTasks = verifying.tasks.some((task) => task.status === "blocked");
      const completed = await update((run) => ({
        ...run,
        status: hasDeferredTasks ? "partial_completed" : "completed",
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      }));
      terminal = true;
      return completed;
    } catch (error) {
      if (error instanceof CancelledError || cancelRequested) {
        const cancelled = await finishCancelled();
        terminal = true;
        return cancelled;
      }
      const current = await dependencies.store.get(request.runId);
      if (current && !["failed", "completed", "cancelled"].includes(current.status)) {
        const failed = await update((run) => ({
          ...run,
          status: "failed",
          error: errorMessage(error),
          updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
        }));
        terminal = true;
        return failed;
      }
      terminal = true;
      return current!;
    }
  };

  const completion = execute();
  const stop = async (interrupted: boolean): Promise<void> => {
    if (terminal || cancelRequested) return;
    cancelRequested = true;
    interruptRequested = interrupted;
    runController.abort();
    for (const controller of taskControllers.values()) controller.abort();
    await Promise.allSettled([...runningProcesses.values()].map((process) => process.cancel()));
    const current = await dependencies.store.get(request.runId);
    if (
      !interrupted &&
      current &&
      ["running", "integrating", "verifying"].includes(current.status)
    ) {
      await update((run) => ({
        ...run,
        status: "cancelling",
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      })).catch(() => undefined);
    }
  };
  return {
    completion,
    cancel: () => stop(false),
    interrupt: () => stop(true),
  };
}
