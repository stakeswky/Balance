import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildExecuteCommand, type AgentCommand } from "./adapters.ts";
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
  NativeAgentId,
  OrchestratorRun,
  VerificationCommand,
  WorktreeRegistration,
} from "./types.ts";

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
  prepareAgentCommand?(input: {
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
    signal: AbortSignal;
  },
  dependencies: SchedulerDependencies,
): Promise<string> {
  const task = input.run.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task) throw new Error(`conflict task not found: ${input.taskId}`);
  if (input.signal.aborted) throw new CancelledError();
  const runtime = await dependencies.runtimeFor(input.run.coordinator);
  if (!runtime.ok || !runtime.path)
    throw new Error("coordinator native CLI is unavailable for conflict repair");
  const conflictTask = {
    ...task,
    assignedAgent: input.run.coordinator,
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
    agent: input.run.coordinator,
    binaryPath: runtime.path,
    worktreePath: input.integrationPath,
    task: conflictTask,
  });
  const prepared = dependencies.prepareAgentCommand
    ? await dependencies.prepareAgentCommand({
        command: baseCommand,
        agent: input.run.coordinator,
        runId: input.run.id,
        taskId: `conflict:${input.taskId}`,
      })
    : { command: baseCommand, secrets: [], cleanup: async () => undefined };
  let process: RunningProcess;
  try {
    process = dependencies.startProcess({
      command: prepared.command,
      agent: input.run.coordinator,
      signal: input.signal,
      secrets: prepared.secrets,
      async onEvent(event) {
        await dependencies.store.appendEvent({
          runId: input.run.id,
          taskId: input.taskId,
          agent: input.run.coordinator,
          at: dependencies.now(),
          event,
        });
      },
    });
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
  const result = await process.completion.finally(() => prepared.cleanup());
  if (input.signal.aborted) throw new CancelledError();
  if (result.exitCode !== 0)
    throw new Error(`coordinator conflict repair exited with code ${result.exitCode}`);
  for (const verificationCommand of task.verificationCommands) {
    const verification = await dependencies.runVerification({
      command: verificationCommand,
      cwd: input.integrationPath,
      signal: input.signal,
    });
    if (verification.exitCode !== 0) throw new Error(`conflict verification failed for ${task.id}`);
  }
  return dependencies.commitTaskWorktree(
    input.integrationPath,
    `fix(orchestrator): resolve ${task.id} integration conflict`,
  );
}

export async function scheduleRun(
  request: StartRunRequest,
  dependencies: SchedulerDependencies,
): Promise<ScheduleHandle> {
  const initial = await dependencies.store.get(request.runId);
  if (!initial) throw new Error(`orchestrator run not found: ${request.runId}`);
  if (initial.status === "capacity_blocked") throw new Error("capacity_blocked plans cannot start");
  if (initial.status !== "draft") throw new Error(`run cannot start from ${initial.status}`);
  assertStartRequest(request, initial);
  const repository = await dependencies.inspectRepository(initial.repositoryPath, "execute");
  assertCurrentRepository(initial, repository);
  await dependencies.store.update(initial.id, (run) => ({
    ...run,
    status: "ready",
    repositoryTrustedAt: dependencies.now(),
    updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
  }));

  let cancelRequested = false;
  let interruptRequested = false;
  let terminal = false;
  const taskControllers = new Map<string, AbortController>();
  const runningProcesses = new Map<string, RunningProcess>();

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
    const current = await dependencies.store.get(request.runId);
    const task = current?.tasks.find((candidate) => candidate.id === taskId);
    if (!current || !task) throw new Error(`task disappeared: ${taskId}`);
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
    if (cancelRequested) throw new CancelledError();
    const runtime = await dependencies.runtimeFor(task.assignedAgent);
    if (!runtime.ok || !runtime.path)
      throw new Error(`${task.assignedAgent} native CLI is unavailable`);
    const controller = new AbortController();
    taskControllers.set(taskId, controller);
    const baseCommand = buildExecuteCommand({
      agent: task.assignedAgent,
      binaryPath: runtime.path,
      worktreePath: worktree.path,
      task,
    });
    const prepared = dependencies.prepareAgentCommand
      ? await dependencies.prepareAgentCommand({
          command: baseCommand,
          agent: task.assignedAgent,
          runId: request.runId,
          taskId,
        })
      : { command: baseCommand, secrets: [], cleanup: async () => undefined };
    await markTask(taskId, (state) => ({ ...state, status: "running" }));
    let process: RunningProcess;
    try {
      process = dependencies.startProcess({
        command: prepared.command,
        agent: task.assignedAgent,
        signal: controller.signal,
        secrets: prepared.secrets,
        async onEvent(event) {
          await dependencies.store.appendEvent({
            runId: request.runId,
            taskId,
            agent: task.assignedAgent,
            at: dependencies.now(),
            event,
          });
        },
      });
    } catch (error) {
      taskControllers.delete(taskId);
      await prepared.cleanup();
      throw error;
    }
    runningProcesses.set(taskId, process);
    const processResult = await process.completion.finally(() => prepared.cleanup());
    runningProcesses.delete(taskId);
    taskControllers.delete(taskId);
    if (cancelRequested) throw new CancelledError();
    if (processResult.exitCode !== 0)
      throw new Error(`native Agent exited with code ${processResult.exitCode}`);
    await markTask(taskId, (state) => ({ ...state, status: "verifying" }));
    for (const verificationCommand of task.verificationCommands) {
      if (cancelRequested) throw new CancelledError();
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
      const integration = await dependencies.createIntegrationWorktree({
        repository,
        runId: request.runId,
        stateRoot: dependencies.stateRoot,
      });
      await update((run) => ({
        ...run,
        integrationWorktree: integration,
        resultBranch: integration.branch,
        updatedAt: Math.max(dependencies.now(), run.updatedAt + 1),
      }));
      const integrated = new Set<string>();
      const pending = new Set(initial.tasks.map((task) => task.id));
      const maxConcurrency = dependencies.maxConcurrency ?? 3;
      while (pending.size > 0) {
        if (cancelRequested) throw new CancelledError();
        const baseSha = await dependencies.readWorktreeHead(integration.path);
        const usedAgents = new Set<NativeAgentId>();
        const wave = initial.tasks
          .filter(
            (task) =>
              pending.has(task.id) &&
              task.dependsOn.every((dependency) => integrated.has(dependency)) &&
              !usedAgents.has(task.assignedAgent) &&
              (usedAgents.add(task.assignedAgent), true),
          )
          .slice(0, maxConcurrency);
        if (wave.length === 0) throw new Error("no runnable task remains in the dependency graph");
        const results = await Promise.allSettled(
          wave.map((task) => executeTask(task.id, baseSha, integration)),
        );
        let failure: unknown = null;
        for (let index = 0; index < wave.length; index += 1) {
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
                await resolveIntegrationConflict(
                  {
                    run: current,
                    taskId: task.id,
                    commitSha: state.commitSha,
                    integrationPath: current.integrationWorktree.path,
                    conflictFiles: conflicts,
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
            status: "failed",
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
      for (const task of verifying.tasks) {
        for (const verificationCommand of task.verificationCommands) {
          const result = await dependencies.runVerification({
            command: verificationCommand,
            cwd: verifying.integrationWorktree.path,
            signal: new AbortController().signal,
          });
          if (result.exitCode !== 0) throw new Error(`final verification failed for ${task.id}`);
        }
      }
      const completed = await update((run) => ({
        ...run,
        status: "completed",
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
