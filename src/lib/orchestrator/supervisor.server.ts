import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  prepareAgentSessionEnvironment,
  verifyGrokIsolation,
  type AgentCommand,
} from "./adapters.ts";
import { createAgentLeaseManager } from "./agent-lease.server.ts";
import { createCapacityReservationManager } from "./capacity-reservation.server.ts";
import { selectScheduleBatch } from "./batch-selector.ts";
import { chooseRepairAgent } from "./capacity.ts";
import { readOfficialQuota } from "../quota/official.server.ts";
import {
  abortCherryPick,
  assertOriginalHeadUnchanged,
  cherryPickTask,
  commitTaskWorktree,
  createIntegrationWorktree,
  createTaskWorktree,
  inspectRepository,
  readWorktreeHead,
  removeRegisteredWorktree,
} from "./git.server.ts";
import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  orchestratorStateDir,
} from "./paths.server.ts";
import { analyzePlan, type AnalyzeRequest } from "./planner.server.ts";
import { buildTrustedQuotaSnapshot } from "./quota-policy.ts";
import { startAgentProcess, type ProcessRunResult } from "./process-runner.server.ts";
import { createRunStore, type RunStore } from "./run-store.server.ts";
import { scheduleRun, type ScheduleHandle, type StartRunRequest } from "./scheduler.server.ts";
import { loadOrchestratorSettings, saveOrchestratorSettings } from "./settings.server.ts";
import { discoverNativeAgents } from "./runtime.server.ts";
import type {
  AgentRuntimeProbe,
  ClientQuotaEvidence,
  NativeAgentId,
  OrchestratorRun,
  OrchestratorSettings,
  PlanDraft,
  RepositoryValidation,
  RoleSuccessRates,
  RunEventRecord,
  RunStatus,
  VerificationCommand,
} from "./types.ts";

export interface RunSnapshot {
  run: OrchestratorRun;
  events: RunEventRecord[];
  nextSeq: number;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  repositoryPath: string;
  coordinator: NativeAgentId;
  resultBranch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContinueRunRequest extends StartRunRequest {
  requestId: string;
  quotaEvidence: Record<NativeAgentId, ClientQuotaEvidence>;
}

export interface OrchestratorSupervisor {
  initialize(): Promise<void>;
  getSettings(): Promise<OrchestratorSettings>;
  saveSettings(settings: OrchestratorSettings): Promise<OrchestratorSettings>;
  detectRuntimes(): Promise<Record<NativeAgentId, AgentRuntimeProbe>>;
  validateRepository(repoPath: string): Promise<RepositoryValidation>;
  analyze(input: AnalyzeRequest): Promise<PlanDraft>;
  start(input: StartRunRequest): Promise<{ runId: string }>;
  continue(input: ContinueRunRequest): Promise<{ runId: string }>;
  get(runId: string, afterSeq?: number): Promise<RunSnapshot>;
  cancel(runId: string): Promise<OrchestratorRun>;
  list(): Promise<RunSummary[]>;
  shutdown(): Promise<void>;
}

function verificationExecutable(
  command: VerificationCommand,
  cwd: string,
): { executable: string; args: string[] } {
  if (command.executable === "git") {
    return {
      executable: "/usr/bin/git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "core.attributesFile=/dev/null",
        ...command.args,
      ],
    };
  }
  if (command.executable === "./gradlew") {
    return { executable: join(cwd, "gradlew"), args: command.args };
  }
  return { executable: "/usr/bin/env", args: [command.executable, ...command.args] };
}

async function runVerificationCommand(
  command: VerificationCommand,
  cwd: string,
  signal: AbortSignal,
): Promise<ProcessRunResult> {
  const runRoot = cwd.endsWith("/integration") ? dirname(cwd) : dirname(dirname(cwd));
  const verificationRoot = join(runRoot, "verification");
  const home = join(verificationRoot, "home");
  const temporary = join(verificationRoot, "tmp");
  await ensurePrivateDirectory(home);
  await ensurePrivateDirectory(temporary);
  const resolved = verificationExecutable(command, cwd);
  if (command.executable === "./gradlew") {
    const metadata = await lstat(resolved.executable);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error("./gradlew must be a non-symlink executable regular file");
    }
    const canonical = await realpath(resolved.executable);
    const canonicalCwd = await realpath(cwd);
    if (!canonical.startsWith(`${canonicalCwd}/`))
      throw new Error("./gradlew escaped the task worktree");
  }
  return new Promise((resolveResult) => {
    execFile(
      resolved.executable,
      resolved.args,
      {
        cwd,
        signal,
        timeout: 30 * 60 * 1_000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          HOME: home,
          TMPDIR: temporary,
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          CI: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_EXTERNAL_DIFF: "",
          GIT_DIFF_OPTS: "",
          GIT_ATTR_NOSYSTEM: "1",
        },
      },
      (error, stdout, stderr) => {
        const code =
          typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : error
              ? -1
              : 0;
        resolveResult({
          exitCode: code,
          signal: (error as { signal?: NodeJS.Signals } | null)?.signal ?? null,
          stdoutLines: String(stdout).split(/\r?\n/).filter(Boolean),
          stderrLines: String(stderr).split(/\r?\n/).filter(Boolean),
        });
      },
    );
  });
}

class LocalOrchestratorSupervisor implements OrchestratorSupervisor {
  readonly #stateRoot: string;
  readonly #store: RunStore;
  readonly #active = new Map<string, ScheduleHandle>();
  readonly #starting = new Map<string, Promise<ScheduleHandle>>();
  readonly #continueClaims = new Map<string, string>();
  readonly #planningControllers = new Set<AbortController>();
  readonly #planningOperations = new Set<Promise<unknown>>();
  readonly #agentLeases = createAgentLeaseManager({ globalMaxConcurrency: 3 });
  readonly #capacityReservations = createCapacityReservationManager();
  #releaseLock: (() => Promise<void>) | null = null;
  #initializing: Promise<void> | null = null;
  #shutdown = false;

  constructor(stateRoot = orchestratorStateDir()) {
    this.#stateRoot = stateRoot;
    this.#store = createRunStore(stateRoot);
  }

  initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      await this.#store.initialize();
      this.#releaseLock = await this.#store.acquireInstanceLock();
      await this.#store.recoverInterrupted();
      await this.#store.pruneExpired(Date.now());
    })().catch((error) => {
      this.#initializing = null;
      throw error;
    });
    return this.#initializing;
  }

  async getSettings(): Promise<OrchestratorSettings> {
    await this.initialize();
    const settings = (await loadOrchestratorSettings({ root: this.#stateRoot })).settings;
    this.#agentLeases.setGlobalMaxConcurrency(settings.globalMaxConcurrency);
    return settings;
  }

  async saveSettings(settings: OrchestratorSettings): Promise<OrchestratorSettings> {
    await this.initialize();
    const saved = await saveOrchestratorSettings(settings, { root: this.#stateRoot });
    this.#agentLeases.setGlobalMaxConcurrency(saved.globalMaxConcurrency);
    return saved;
  }

  async detectRuntimes(): Promise<Record<NativeAgentId, AgentRuntimeProbe>> {
    const settings = await this.getSettings();
    return discoverNativeAgents(settings);
  }

  async #recentSuccessRates(): Promise<Record<NativeAgentId, RoleSuccessRates>> {
    const result = Object.fromEntries(([
      "claude", "codex", "grok",
    ] as const).map((agent) => [agent, {
      planningSuccessRate: null,
      executionSuccessRate: null as number | null,
      repairSuccessRate: null,
    }])) as Record<NativeAgentId, RoleSuccessRates>;
    for (const agent of ["claude", "codex", "grok"] as const) {
      for (const role of ["planning", "execution", "repair"] as const) {
        const recent = await this.#store.activities({ agent, role, limit: 20 });
        const rate = recent.length
          ? recent.filter((activity) => activity.success).length / recent.length
          : null;
        if (role === "planning") result[agent].planningSuccessRate = rate;
        if (role === "execution") result[agent].executionSuccessRate = rate;
        if (role === "repair") result[agent].repairSuccessRate = rate;
      }
    }
    return result;
  }

  async #refreshQuotaForRun(
    run: OrchestratorRun,
    clientEvidenceOverride?: Record<NativeAgentId, ClientQuotaEvidence>,
  ) {
    const now = Date.now();
    const settings = await this.getSettings();
    const runtimes = await discoverNativeAgents(settings);
    const emptyEvidence: ClientQuotaEvidence = {
      officialRemainingPct: null,
      officialObservedAt: null,
      officialResetsAt: null,
      officialFresh: false,
      officialSource: null,
      l3RemainingPct: null,
      l3Confidence: "none",
      l3ObservedAt: null,
    };
    const prior = run.draft.quotaSnapshot?.evidence;
    const clientEvidence = clientEvidenceOverride ?? Object.fromEntries(([
      "claude", "codex", "grok",
    ] as const).map((agent) => {
      const evidence = prior?.[agent];
      return [agent, evidence ? {
        officialRemainingPct: evidence.officialRemainingPct,
        officialObservedAt: evidence.officialObservedAt,
        officialResetsAt: evidence.officialResetsAt,
        officialFresh: evidence.officialFresh,
        officialSource: evidence.officialSource,
        l3RemainingPct: evidence.l3RemainingPct,
        l3Confidence: evidence.l3Confidence,
        l3ObservedAt: evidence.l3ObservedAt,
      } : emptyEvidence];
    })) as Record<NativeAgentId, ClientQuotaEvidence>;
    return buildTrustedQuotaSnapshot({
      clientEvidence,
      officialQuota: await readOfficialQuota({ now }),
      runtimes,
      settings,
      roleSuccessRates: await this.#recentSuccessRates(),
      now,
    });
  }

  async validateRepository(repoPath: string): Promise<RepositoryValidation> {
    await this.initialize();
    try {
      const snapshot = await inspectRepository(repoPath, "analyze");
      return {
        valid: true,
        reasons: [],
        canonicalPath: snapshot.root,
        device: snapshot.device,
        inode: snapshot.inode,
        branch: snapshot.branch,
        baseSha: snapshot.head,
        dirty: snapshot.dirty,
      };
    } catch (error) {
      return {
        valid: false,
        reasons: [(error instanceof Error ? error.message : String(error)).slice(0, 2_000)],
        canonicalPath: null,
        device: null,
        inode: null,
        branch: null,
        baseSha: null,
        dirty: null,
      };
    }
  }

  async #runtimeFor(agent: NativeAgentId): Promise<AgentRuntimeProbe> {
    return (await this.detectRuntimes())[agent];
  }

  async #prepareCommand(command: AgentCommand, agent: NativeAgentId, runId: string) {
    const environment = await prepareAgentSessionEnvironment({
      agent,
      runRoot: join(this.#stateRoot, "runs", runId),
    });
    try {
      const prepared = { ...command, env: environment.env };
      if (agent === "grok") await verifyGrokIsolation(command.command, environment);
      return { command: prepared, secrets: environment.secrets, cleanup: environment.cleanup };
    } catch (error) {
      await environment.cleanup();
      throw error;
    }
  }

  async analyze(input: AnalyzeRequest): Promise<PlanDraft> {
    await this.initialize();
    if (this.#shutdown) throw new Error("orchestrator is shutting down");
    const runtimes = await this.detectRuntimes();
    const settings = await this.getSettings();
    const controller = new AbortController();
    this.#planningControllers.add(controller);
    const operation = analyzePlan(input, {
      inspectRepository,
      runtimeFor: (agent) => Promise.resolve(runtimes[agent]),
      runPlanCommand: async ({ command, agent, signal, runId, attempt }) => {
        const lease = await this.#agentLeases.acquire({
          agent,
          runId,
          taskId: `planning-${attempt + 1}`,
          role: "planning",
          signal,
        });
        let environment: Awaited<ReturnType<typeof prepareAgentSessionEnvironment>> | null = null;
        try {
          environment = await prepareAgentSessionEnvironment({
            agent,
            runRoot: join(this.#stateRoot, "planning", randomBytes(12).toString("hex")),
          });
          if (agent === "grok") await verifyGrokIsolation(command.command, environment);
          const events: import("./types.ts").OrchestratorEvent[] = [];
          const process = startAgentProcess({
            command: { ...command, env: environment.env },
            agent,
            signal,
            secrets: environment.secrets,
            onEvent(event) {
              events.push(event);
            },
          });
          const result = await process.completion;
          return { exitCode: result.exitCode, stdoutLines: result.stdoutLines, events };
        } finally {
          try {
            await environment?.cleanup();
          } finally {
            await lease.release();
          }
        }
      },
      createSchemaFile: async (runId, schema) => {
        const path = join(this.#stateRoot, "planning", runId, "plan-schema.json");
        await atomicWritePrivateJson(path, schema);
        return path;
      },
      recentSuccessRates: () => this.#recentSuccessRates(),
      refreshQuotaSnapshot: async ({ clientEvidence, runtimes: currentRuntimes, settings: currentSettings, roleSuccessRates, now }) =>
        buildTrustedQuotaSnapshot({
          clientEvidence,
          officialQuota: await readOfficialQuota({ now }),
          runtimes: currentRuntimes,
          settings: currentSettings,
          roleSuccessRates,
          now,
        }),
      loadSettings: () => Promise.resolve(settings),
      detectRuntimes: () => Promise.resolve(runtimes),
      store: this.#store,
      now: Date.now,
      randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    }, controller.signal);
    this.#planningOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.#planningOperations.delete(operation);
      this.#planningControllers.delete(controller);
    }
  }

  async start(input: StartRunRequest): Promise<{ runId: string }> {
    return this.#launch(input, null, false);
  }

  async continue(input: ContinueRunRequest): Promise<{ runId: string }> {
    return this.#launch(input, input.quotaEvidence, true);
  }

  async #launch(
    input: StartRunRequest,
    clientEvidence: Record<NativeAgentId, ClientQuotaEvidence> | null,
    idempotent: boolean,
  ): Promise<{ runId: string }> {
    await this.initialize();
    if (this.#shutdown) throw new Error("orchestrator is shutting down");
    const requestId = idempotent ? (input as ContinueRunRequest).requestId : null;
    if (this.#active.has(input.runId) || this.#starting.has(input.runId)) {
      if (requestId) {
        const existing = await this.#store.get(input.runId);
        if (existing?.draft.continueRequestIds?.includes(requestId)) return { runId: input.runId };
      }
      throw new Error("orchestrator run is already active");
    }
    if (requestId) {
      const inFlightRequestId = this.#continueClaims.get(input.runId);
      if (inFlightRequestId) {
        if (inFlightRequestId === requestId) return { runId: input.runId };
        throw new Error("orchestrator run already has a continuation request in progress");
      }
      this.#continueClaims.set(input.runId, requestId);
    }
    if (idempotent) {
      const existing = await this.#store.get(input.runId);
      if (!existing) {
        this.#continueClaims.delete(input.runId);
        throw new Error(`orchestrator run not found: ${input.runId}`);
      }
      if (existing.status === "completed") {
        this.#continueClaims.delete(input.runId);
        return { runId: input.runId };
      }
      if (existing.status === "interrupted") {
        this.#continueClaims.delete(input.runId);
        throw new Error("interrupted runs are read-only and cannot continue automatically");
      }
      if (!await this.#store.claimContinueRequest(input.runId, requestId!)) {
        this.#continueClaims.delete(input.runId);
        return { runId: input.runId };
      }
    }
    let settings: OrchestratorSettings;
    try {
      settings = await this.getSettings();
    } catch (error) {
      this.#continueClaims.delete(input.runId);
      throw error;
    }
    if (this.#shutdown) {
      this.#continueClaims.delete(input.runId);
      throw new Error("orchestrator is shutting down");
    }
    const starting = scheduleRun(input, {
      store: this.#store,
      inspectRepository,
      createIntegrationWorktree,
      createTaskWorktree,
      readWorktreeHead,
      commitTaskWorktree,
      cherryPickTask,
      abortCherryPick,
      assertOriginalHeadUnchanged,
      removeRegisteredWorktree,
      acquireAgentLease: this.#agentLeases.acquire,
      reserveWaveCapacity: this.#capacityReservations.reserveWave,
      availableExecutionUnits: async (run) => {
        const refreshed = await this.#refreshQuotaForRun(run, clientEvidence ?? undefined);
        return Object.fromEntries(refreshed.profiles.map((profile) => [
          profile.agent,
          profile.executionUnits,
        ])) as Record<NativeAgentId, number>;
      },
      refreshSchedule: async (run) => {
        const refreshed = await this.#refreshQuotaForRun(run, clientEvidence ?? undefined);
        const reservations = this.#capacityReservations.snapshot().reservations;
        return {
          selection: selectScheduleBatch({
            tasks: run.draft.plan.tasks,
            profiles: refreshed.profiles,
            completedTaskIds: new Set(run.tasks
              .filter((task) => task.status === "completed")
              .map((task) => task.id)),
            globalMaxConcurrency: settings.globalMaxConcurrency,
          }),
          quotaSnapshot: refreshed.snapshot,
          agentProfiles: refreshed.profiles.map((profile) => ({
            agent: profile.agent,
            enabled: profile.enabled,
            installed: profile.installed,
            version: profile.version,
            canPlan: profile.canPlan,
            canExecute: profile.canExecute,
            canRepair: profile.canRepair,
            executionUnits: profile.executionUnits,
            admissionSource: profile.admissionSource,
            planningSuccessRate: profile.planningSuccessRate,
            executionSuccessRate: profile.executionSuccessRate,
            repairSuccessRate: profile.repairSuccessRate,
            planningRisk: profile.planningRisk,
            repairRisk: profile.repairRisk,
            exclusionReasons: profile.exclusionReasons,
            diagnostics: profile.diagnostics,
            reservedUnitsByOtherRuns: reservations
              .filter((reservation) => reservation.runId !== run.id)
              .reduce((sum, reservation) => sum + (reservation.requests[profile.agent] ?? 0), 0),
          })),
        };
      },
      repairAgentFor: async (run) => {
        const refreshed = await this.#refreshQuotaForRun(run, clientEvidence ?? undefined);
        return chooseRepairAgent(refreshed.profiles, run.coordinator);
      },
      runtimeFor: (agent) => this.#runtimeFor(agent),
      startProcess: startAgentProcess,
      runVerification: ({ command, cwd, signal }) => runVerificationCommand(command, cwd, signal),
      now: Date.now,
      stateRoot: this.#stateRoot,
      maxConcurrency: settings.globalMaxConcurrency,
      prepareAgentCommand: ({ command, agent, runId }) =>
        this.#prepareCommand(command, agent, runId),
    });
    this.#starting.set(input.runId, starting);
    let handle: ScheduleHandle;
    try {
      handle = await starting;
    } finally {
      this.#starting.delete(input.runId);
      this.#continueClaims.delete(input.runId);
    }
    if (this.#shutdown) {
      await handle.interrupt();
      await handle.completion;
      throw new Error("orchestrator is shutting down");
    }
    this.#active.set(input.runId, handle);
    void handle.completion.then(
      () => this.#active.delete(input.runId),
      () => this.#active.delete(input.runId),
    );
    return { runId: input.runId };
  }

  async get(runId: string, afterSeq = 0): Promise<RunSnapshot> {
    await this.initialize();
    const run = await this.#store.get(runId);
    if (!run) throw new Error(`orchestrator run not found: ${runId}`);
    const events = await this.#store.events(runId, afterSeq);
    return { run, events, nextSeq: events.at(-1)?.seq ?? afterSeq };
  }

  async cancel(runId: string): Promise<OrchestratorRun> {
    await this.initialize();
    const handle = this.#active.get(runId);
    if (handle) {
      await handle.cancel();
      return handle.completion;
    }
    const run = await this.#store.get(runId);
    if (!run) throw new Error(`orchestrator run not found: ${runId}`);
    return run;
  }

  async list(): Promise<RunSummary[]> {
    await this.initialize();
    return (await this.#store.list()).map((run) => ({
      id: run.id,
      status: run.status,
      repositoryPath: run.repositoryPath,
      coordinator: run.coordinator,
      resultBranch: run.resultBranch,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    for (const controller of this.#planningControllers) controller.abort();
    const starting = await Promise.allSettled([...this.#starting.values()]);
    const handles = [
      ...this.#active.values(),
      ...starting.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    ];
    await Promise.allSettled(handles.map((handle) => handle.interrupt()));
    await Promise.allSettled(handles.map((handle) => handle.completion));
    await Promise.allSettled([...this.#planningOperations]);
    await this.#capacityReservations.shutdown();
    await this.#agentLeases.shutdown();
    await this.#store.recoverInterrupted();
    if (this.#releaseLock) await this.#releaseLock();
    this.#releaseLock = null;
  }
}

declare global {
  var __balanceOrchestratorSupervisorPromise__: Promise<OrchestratorSupervisor> | undefined;
  var __balanceOrchestratorShutdownHook__: (() => Promise<void>) | undefined;
}

export function getOrchestratorSupervisor(): Promise<OrchestratorSupervisor> {
  globalThis.__balanceOrchestratorSupervisorPromise__ ??= (async () => {
    const supervisor = new LocalOrchestratorSupervisor();
    await supervisor.initialize();
    return supervisor;
  })().catch((error) => {
    globalThis.__balanceOrchestratorSupervisorPromise__ = undefined;
    throw error;
  });
  globalThis.__balanceOrchestratorShutdownHook__ ??= async () => {
    const supervisor = await globalThis.__balanceOrchestratorSupervisorPromise__;
    await supervisor?.shutdown();
  };
  Reflect.set(
    globalThis,
    Symbol.for("balance.orchestrator.shutdown"),
    globalThis.__balanceOrchestratorShutdownHook__,
  );
  return globalThis.__balanceOrchestratorSupervisorPromise__;
}
