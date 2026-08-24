import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentLeaseManager } from "./agent-lease.server.ts";
import {
  CapacityReservationConflictError,
  createCapacityReservationManager,
} from "./capacity-reservation.server.ts";
import { fingerprintPlan } from "./plan.ts";
import { createRunStore } from "./run-store.server.ts";
import {
  scheduleRun,
  type SchedulerDependencies,
  type StartRunRequest,
} from "./scheduler.server.ts";
import type {
  NativeAgentId,
  OrchestratorRun,
  PlanDraft,
  QuotaCapacityEvidence,
  TaskRunState,
  WorktreeRegistration,
} from "./types.ts";

const RUN_ID = "run_20260824140000_a1b2c3d4e5f6";

function quotaEvidence(agent: NativeAgentId): QuotaCapacityEvidence {
  return {
    officialRemainingPct: 100,
    officialObservedAt: 1_777_000_000_000,
    officialResetsAt: 1_777_000_060_000,
    officialFresh: true,
    officialSource: `${agent}-test`,
    l3RemainingPct: null,
    l3Confidence: "none",
    l3ObservedAt: null,
    l3Trusted: false,
    computedExecutionUnits: 10,
    admissionSource: "official",
    diagnostics: [],
  };
}

function agentProfiles() {
  return (["claude", "codex", "grok"] as const).map((agent) => ({
    agent,
    enabled: true,
    installed: true,
    version: "1",
    canPlan: true,
    canExecute: true,
    canRepair: true,
    executionUnits: 10,
    admissionSource: "official" as const,
    planningSuccessRate: null,
    executionSuccessRate: null,
    repairSuccessRate: null,
    planningRisk: null,
    repairRisk: null,
    exclusionReasons: [],
    diagnostics: [],
    reservedUnitsByOtherRuns: 0,
  }));
}

function draft(): PlanDraft {
  const tasks = [
    {
      id: "core",
      title: "Core",
      description: "Implement core.",
      size: "small" as const,
      priority: "critical" as const,
      splittable: false,
      preferredAgent: null,
      assignedAgent: "claude" as const,
      dependsOn: [],
      expectedFiles: ["core.ts"],
      acceptanceCriteria: ["core works"],
      verificationCommands: [{ executable: "npm" as const, args: ["run", "test:core"] }],
    },
    {
      id: "ui",
      title: "UI",
      description: "Implement UI.",
      size: "small" as const,
      priority: "high" as const,
      splittable: true,
      preferredAgent: null,
      assignedAgent: "codex" as const,
      dependsOn: [],
      expectedFiles: ["ui.ts"],
      acceptanceCriteria: ["ui works"],
      verificationCommands: [{ executable: "git" as const, args: ["diff", "--check"] }],
    },
    {
      id: "finish",
      title: "Finish",
      description: "Finish core.",
      size: "small" as const,
      priority: "normal" as const,
      splittable: false,
      preferredAgent: null,
      assignedAgent: "claude" as const,
      dependsOn: ["core"],
      expectedFiles: ["finish.ts"],
      acceptanceCriteria: ["finish works"],
      verificationCommands: [{ executable: "npm" as const, args: ["run", "test:finish"] }],
    },
  ];
  const base = {
    runId: RUN_ID,
    repositoryPath: "/repo",
    repositoryDevice: 11,
    repositoryInode: 22,
    repositoryDirtyAtAnalysis: false,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    coordinator: "claude" as const,
    prompt: "build",
    plan: {
      title: "Plan",
      summary: "Summary",
      tasks: tasks.map(({ assignedAgent: _, ...task }) => task),
    },
    assignedTasks: tasks,
  };
  return { ...base, fingerprint: fingerprintPlan(base), createdAt: 1_777_000_000_000 };
}

function run(status: OrchestratorRun["status"] = "draft"): OrchestratorRun {
  const plan = draft();
  const tasks: TaskRunState[] = plan.assignedTasks.map((task) => ({
    ...task,
    status: "queued",
    worktree: null,
    commitSha: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }));
  return {
    schemaVersion: 2,
    id: RUN_ID,
    status,
    repositoryPath: "/repo",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    coordinator: "claude",
    resultBranch: null,
    integrationWorktree: null,
    repositoryTrustedAt: null,
    error: null,
    draft: plan,
    tasks,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
  };
}

async function harness(initial = run()) {
  const runId = initial.id;
  const root = await mkdtemp(join(tmpdir(), "balance-scheduler-"));
  const store = createRunStore(root);
  await store.initialize();
  await store.create(initial);
  const calls: string[] = [];
  const controllers = new Map<string, { resolve: () => void; cancelled: boolean }>();
  const commitOwners = new Map<string, string>();
  let integrationHead = "a".repeat(40);
  let active = 0;
  let maxActive = 0;
  const leaseManager = createAgentLeaseManager({ globalMaxConcurrency: 3 });
  const reservationManager = createCapacityReservationManager();
  const registration = (path: string, branch: string): WorktreeRegistration => ({
    path,
    branch,
    device: 1,
    inode: 2,
  });
  const dependencies: SchedulerDependencies = {
    store,
    async inspectRepository() {
      calls.push("inspect");
      return {
        root: "/repo",
        device: 11,
        inode: 22,
        branch: "main",
        head: "a".repeat(40),
        dirty: false,
      };
    },
    async createIntegrationWorktree(input) {
      calls.push("create:integration");
      return registration(
        join(root, "runs", input.runId, "integration"),
        `balance/run-${input.runId.slice(-12)}-result`,
      );
    },
    async createTaskWorktree(input) {
      calls.push(`create:${input.taskId}`);
      calls.push(`base:${input.taskId}:${input.baseSha}`);
      return registration(
        join(root, "runs", input.runId, "tasks", input.taskId),
        `balance/run-a1b2c3d4e5f6-${input.taskId}`,
      );
    },
    async commitTaskWorktree(_path, message) {
      calls.push(`commit:${message}`);
      const sha = `${calls.filter((call) => call.startsWith("commit:")).length.toString(16)}`.padStart(
        40,
        "0",
      );
      const taskId = /^balance\(([^)]+)\):/.exec(message)?.[1];
      if (taskId) commitOwners.set(sha, taskId);
      return sha;
    },
    async cherryPickTask(_path, sha) {
      calls.push(`pick:${sha}`);
      const taskId = commitOwners.get(sha);
      if (taskId) {
        calls.push(`pick-task:${taskId}`);
        assert.equal((await store.get(runId))?.tasks.find((task) => task.id === taskId)?.status, "integrating");
      }
      integrationHead = `${(Number.parseInt(integrationHead[0]!, 16) + 1).toString(16)}`.repeat(40);
    },
    async readWorktreeHead() {
      calls.push(`head:integration:${integrationHead}`);
      return integrationHead;
    },
    async abortCherryPick() {
      calls.push("abort");
    },
    async assertOriginalHeadUnchanged() {
      calls.push("head:ok");
    },
    async removeRegisteredWorktree(input) {
      const taskId = input.slot.kind === "task" ? input.slot.taskId : null;
      calls.push(`remove:${taskId ?? "integration"}`);
      await store.update(input.runId, (current) => ({
        ...current,
        tasks: taskId
          ? current.tasks.map((task) => (task.id === taskId ? { ...task, worktree: null } : task))
          : current.tasks,
        integrationWorktree: input.slot.kind === "integration" ? null : current.integrationWorktree,
        updatedAt: current.updatedAt + 1,
      }));
    },
    async runtimeFor(agent) {
      return { agent, ok: true, path: `/native/${agent}`, version: "1", error: null };
    },
    async acquireAgentLease(input) {
      calls.push(`lease:wait:${input.role}:${input.agent}:${input.taskId}`);
      const lease = await leaseManager.acquire(input);
      calls.push(`lease:got:${input.role}:${input.agent}:${input.taskId}`);
      return {
        ...lease,
        async release() {
          await lease.release();
          calls.push(`lease:released:${input.role}:${input.agent}:${input.taskId}`);
        },
      };
    },
    reserveWaveCapacity: reservationManager.reserveWave,
    async availableExecutionUnits() {
      return { claude: 10, codex: 10, grok: 10 };
    },
    async refreshSchedule(current) {
      return {
        selection: {
          runnableTasks: current.draft.runnableTasks ?? current.draft.assignedTasks,
          deferredTasks: current.draft.deferredTasks ?? [],
          diagnostics: current.draft.scheduleDiagnostics ?? [],
        },
        quotaSnapshot: current.draft.quotaSnapshot ?? {
          capturedAt: 1_777_000_000_000,
          evidence: {
            claude: quotaEvidence("claude"),
            codex: quotaEvidence("codex"),
            grok: quotaEvidence("grok"),
          },
        },
        agentProfiles: agentProfiles(),
      };
    },
    async repairAgentFor(current) {
      return current.coordinator;
    },
    async prepareAgentCommand(input) {
      return { command: input.command, secrets: [], cleanup: async () => undefined };
    },
    startProcess(input) {
      const taskId = input.command.cwd.split("/").at(-1)!;
      calls.push(`start:${taskId}:${input.agent}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      let resolve!: () => void;
      const completion = new Promise<{
        exitCode: number;
        signal: null;
        stdoutLines: string[];
        stderrLines: string[];
      }>((done) => {
        resolve = () => {
          active -= 1;
          done({ exitCode: 0, signal: null, stdoutLines: [], stderrLines: [] });
        };
      });
      controllers.set(taskId, { resolve, cancelled: false });
      if (taskId === "finish") queueMicrotask(resolve);
      if (
        (taskId === "core" || taskId === "ui") &&
        controllers.has("core") &&
        controllers.has("ui")
      ) {
        queueMicrotask(() => {
          controllers.get("core")!.resolve();
          controllers.get("ui")!.resolve();
        });
      }
      return {
        pid: 100 + controllers.size,
        completion,
        async cancel() {
          controllers.get(taskId)!.cancelled = true;
          resolve();
        },
      };
    },
    async runVerification(input) {
      calls.push(
        `verify:${input.cwd.split("/").at(-1)}:${input.command.executable} ${input.command.args.join(" ")}`,
      );
      return { exitCode: 0, signal: null, stdoutLines: [], stderrLines: [] };
    },
    now: () => 1_777_000_001_000 + calls.length,
    stateRoot: root,
    maxConcurrency: 3,
  };
  const request: StartRunRequest = {
    runId,
    fingerprint: initial.draft.fingerprint,
    trustedRepository: true,
    confirmedRepository: { path: "/repo", device: 11, inode: 22, baseSha: "a".repeat(40) },
  };
  return {
    root,
    store,
    calls,
    controllers,
    dependencies,
    request,
    leaseManager,
    reservationManager,
    get maxActive() {
      return maxActive;
    },
  };
}

test("rejects untrusted, stale, dirty-analysis and capacity-blocked starts before mutation", async () => {
  const h = await harness();
  await assert.rejects(
    () => scheduleRun({ ...h.request, trustedRepository: false as true }, h.dependencies),
    /trust/i,
  );
  await assert.rejects(
    () => scheduleRun({ ...h.request, fingerprint: "f".repeat(64) }, h.dependencies),
    /fingerprint/i,
  );
  await assert.rejects(
    () =>
      scheduleRun(
        { ...h.request, confirmedRepository: { ...h.request.confirmedRepository, inode: 99 } },
        h.dependencies,
      ),
    /repository|identity|confirm/i,
  );
  assert.equal((await h.store.get(RUN_ID))?.status, "draft");

  const dirtyRun = run();
  dirtyRun.id = "run_20260824140001_a1b2c3d4e5f7";
  dirtyRun.draft.runId = dirtyRun.id;
  dirtyRun.draft.repositoryDirtyAtAnalysis = true;
  const {
    fingerprint: _dirtyFingerprint,
    createdAt: _dirtyCreatedAt,
    ...dirtyFingerprintInput
  } = dirtyRun.draft;
  dirtyRun.draft.fingerprint = fingerprintPlan(dirtyFingerprintInput);
  const dirtyRoot = await mkdtemp(join(tmpdir(), "balance-scheduler-dirty-"));
  const dirtyStore = createRunStore(dirtyRoot);
  await dirtyStore.initialize();
  await dirtyStore.create(dirtyRun);
  await assert.rejects(
    () =>
      scheduleRun(
        { ...h.request, runId: dirtyRun.id, fingerprint: dirtyRun.draft.fingerprint },
        { ...h.dependencies, store: dirtyStore },
      ),
    /reanaly|dirty/i,
  );

  const blocked = run("capacity_blocked");
  blocked.draft.assignedTasks = [];
  blocked.tasks = [];
  const blockedHarness = await harness(blocked);
  await assert.rejects(
    () => scheduleRun(blockedHarness.request, blockedHarness.dependencies),
    /capacity/i,
  );
});

test("serializes the same Agent across two concurrently running schedules", async () => {
  const first = await harness();
  const secondRun = run();
  secondRun.id = "run_20260824140001_a1b2c3d4e5f7";
  secondRun.draft.runId = secondRun.id;
  const { fingerprint: _fingerprint, createdAt: _createdAt, ...fingerprintInput } = secondRun.draft;
  secondRun.draft.fingerprint = fingerprintPlan(fingerprintInput);
  const second = await harness(secondRun);
  const leases = createAgentLeaseManager({ globalMaxConcurrency: 3 });
  first.dependencies.acquireAgentLease = leases.acquire;
  second.dependencies.acquireAgentLease = leases.acquire;
  const active = { claude: 0, codex: 0, grok: 0 };
  const maximum = { ...active };
  for (const dependencies of [first.dependencies, second.dependencies]) {
    dependencies.startProcess = (input) => {
      active[input.agent] += 1;
      maximum[input.agent] = Math.max(maximum[input.agent], active[input.agent]);
      return {
        pid: 500,
        completion: delay(10).then(() => ({
          exitCode: 0,
          signal: null,
          stdoutLines: [],
          stderrLines: [],
        })).finally(() => { active[input.agent] -= 1; }),
        async cancel() {},
      };
    };
  }
  const [firstResult, secondResult] = await Promise.all([
    scheduleRun(first.request, first.dependencies).then((handle) => handle.completion),
    scheduleRun(second.request, second.dependencies).then((handle) => handle.completion),
  ]);
  assert.equal(firstResult.status, "completed");
  assert.equal(secondResult.status, "completed");
  assert.deepEqual(maximum, { claude: 1, codex: 1, grok: 0 });
  assert.deepEqual(leases.snapshot(), { active: 0, waiting: 0 });
});

test("cancelling while waiting for an Agent lease never starts that task", async () => {
  const single = run();
  single.draft.plan.tasks = single.draft.plan.tasks.filter((task) => task.id === "ui");
  single.draft.assignedTasks = single.draft.assignedTasks.filter((task) => task.id === "ui");
  single.tasks = single.tasks.filter((task) => task.id === "ui");
  const { fingerprint: _fingerprint, createdAt: _createdAt, ...fingerprintInput } = single.draft;
  single.draft.fingerprint = fingerprintPlan(fingerprintInput);
  const h = await harness(single);
  const leases = createAgentLeaseManager({ globalMaxConcurrency: 3 });
  h.dependencies.acquireAgentLease = leases.acquire;
  const held = await leases.acquire({
    agent: "codex", runId: "outside", taskId: "held", role: "planning",
    signal: new AbortController().signal,
  });
  const handle = await scheduleRun(h.request, h.dependencies);
  for (let attempt = 0; attempt < 100 && leases.snapshot().waiting === 0; attempt += 1) {
    await delay(5);
  }
  assert.equal(
    leases.snapshot().waiting,
    1,
    JSON.stringify({ calls: h.calls, run: await h.store.get(single.id) }),
  );
  assert.equal(h.calls.some((call) => call === "start:ui:codex"), false);
  await handle.cancel();
  const result = await handle.completion;
  assert.equal(result.status, "cancelled");
  await held.release();
  await nextTurn();
  assert.equal(h.calls.some((call) => call === "start:ui:codex"), false);
  assert.deepEqual(leases.snapshot(), { active: 0, waiting: 0 });
});

test("runs dependency waves with per-agent isolation, verifies, commits, integrates and completes", async () => {
  const h = await harness();
  const handle = await scheduleRun(h.request, h.dependencies);
  const completed = await handle.completion;
  assert.equal(completed.status, "completed");
  assert.equal(completed.resultBranch, "balance/run-a1b2c3d4e5f6-result");
  assert.equal(
    completed.tasks.every((task) => task.status === "completed" && task.commitSha),
    true,
  );
  assert.equal(h.maxActive, 2);
  assert.ok(h.calls.indexOf("start:finish:claude") > h.calls.indexOf("pick-task:ui"));
  assert.deepEqual(h.calls.filter((call) => call.startsWith("pick-task:")), [
    "pick-task:core", "pick-task:ui", "pick-task:finish",
  ]);
  const taskBases = new Map(
    h.calls.filter((call) => call.startsWith("base:")).map((call) => {
      const [, taskId, baseSha] = call.split(":");
      return [taskId!, baseSha!] as const;
    }),
  );
  assert.equal(taskBases.get("core"), "a".repeat(40));
  assert.equal(taskBases.get("ui"), "a".repeat(40));
  assert.equal(taskBases.get("finish"), "c".repeat(40));
  assert.deepEqual(
    h.calls.filter((call) => call.startsWith("commit:")),
    ["commit:balance(core): Core", "commit:balance(ui): UI", "commit:balance(finish): Finish"],
  );
  assert.equal(h.calls.filter((call) => call.startsWith("pick:")).length, 3);
  assert.equal(
    h.calls
      .filter((call) => call.startsWith("remove:"))
      .sort()
      .join(","),
    "remove:core,remove:finish,remove:ui",
  );
  assert.equal(h.calls.includes("remove:integration"), false);
  assert.equal(h.reservationManager.snapshot().active, 0);
  const executionActivity = await h.store.activities({ role: "execution", limit: 20 });
  assert.equal(executionActivity.length, 3);
  assert.equal(executionActivity.every((record) => record.success), true);
});

test("integrates a partial batch without discarding deferred plan tasks", async () => {
  const partial = run("partial_ready");
  const runnable = partial.draft.assignedTasks.filter((task) => task.id === "core");
  partial.draft.assignedTasks = runnable;
  partial.draft.runnableTasks = runnable;
  partial.draft.deferredTasks = [
    {
      taskId: "ui", reason: "quota", blockedBy: [], requiredUnits: 1,
      eligibleAgents: ["codex"], eligibleAfter: partial.createdAt + 60_000,
    },
    {
      taskId: "finish", reason: "dependency", blockedBy: ["core"], requiredUnits: 1,
      eligibleAgents: ["claude"], eligibleAfter: partial.createdAt + 60_000,
    },
  ];
  partial.draft.scheduleDiagnostics = ["本批 1 项，延后 2 项。"];
  partial.tasks = partial.tasks.map((task) => task.id === "core"
    ? task
    : { ...task, assignedAgent: null, status: "blocked" });
  const h = await harness(partial);
  h.dependencies.startProcess = () => ({
    pid: 700,
    completion: Promise.resolve({
      exitCode: 0, signal: null, stdoutLines: [], stderrLines: [],
    }),
    async cancel() {},
  });

  const completed = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(completed.status, "partial_completed");
  assert.equal(completed.tasks.find((task) => task.id === "core")?.status, "completed");
  assert.equal(completed.tasks.find((task) => task.id === "ui")?.status, "blocked");
  assert.equal(completed.draft.plan.tasks.length, 3);
  assert.deepEqual(h.calls.filter((call) => call.startsWith("pick-task:")), ["pick-task:core"]);

  h.dependencies.refreshSchedule = async (current) => {
    const ui = current.draft.plan.tasks.find((task) => task.id === "ui")!;
    return {
      selection: {
        runnableTasks: [{ ...ui, assignedAgent: "codex" }],
        deferredTasks: [{
          taskId: "finish", reason: "quota", blockedBy: [], requiredUnits: 1,
          eligibleAgents: ["claude"], eligibleAfter: current.updatedAt + 60_000,
        }],
        diagnostics: ["继续执行 UI，延后 finish。"],
      },
      quotaSnapshot: current.draft.quotaSnapshot!,
      agentProfiles: agentProfiles(),
    };
  };
  const continued = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(continued.status, "partial_completed", JSON.stringify({
    error: continued.error,
    tasks: continued.tasks.map((task) => ({ id: task.id, status: task.status, error: task.error })),
    calls: h.calls,
  }));
  assert.equal(continued.tasks.find((task) => task.id === "core")?.status, "completed");
  assert.equal(continued.tasks.find((task) => task.id === "ui")?.status, "completed");
  assert.equal(h.calls.filter((call) => call === "create:integration").length, 1);
  assert.equal(h.calls.filter((call) => call === "create:core").length, 1);
  assert.equal(h.calls.filter((call) => call === "create:ui").length, 1);
});

test("revalidates a dropped quota at start and waits without launching an Agent", async () => {
  const h = await harness();
  h.dependencies.refreshSchedule = async (current) => ({
    selection: {
      runnableTasks: [],
      deferredTasks: current.draft.plan.tasks.map((task) => ({
        taskId: task.id,
        reason: "quota" as const,
        blockedBy: [],
        requiredUnits: 1,
        eligibleAgents: ["codex" as const],
        eligibleAfter: current.createdAt + 60_000,
      })),
      diagnostics: ["开始前官方额度下降，等待刷新。"],
    },
    quotaSnapshot: {
      capturedAt: current.createdAt + 1,
      evidence: {
        claude: { ...quotaEvidence("claude"), officialRemainingPct: 0, computedExecutionUnits: 0 },
        codex: { ...quotaEvidence("codex"), officialRemainingPct: 0, computedExecutionUnits: 0 },
        grok: { ...quotaEvidence("grok"), officialRemainingPct: 0, computedExecutionUnits: 0 },
      },
    },
    agentProfiles: agentProfiles().map((profile) => ({
      ...profile, canExecute: false, canRepair: false, executionUnits: 0,
    })),
  });

  const waiting = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(waiting.status, "waiting_quota");
  assert.equal(waiting.draft.plan.tasks.length, 3);
  assert.equal(waiting.draft.runnableTasks?.length, 0);
  assert.equal(waiting.tasks.every((task) => task.status === "blocked"), true);
  assert.equal(h.calls.some((call) => call === "create:integration"), false);
  assert.equal(h.calls.some((call) => call.startsWith("start:")), false);
  assert.equal(h.reservationManager.snapshot().active, 0);
});

test("turns a cross-run reservation conflict into a resumable wait", async () => {
  const h = await harness();
  const held = await h.reservationManager.reserveWave({
    runId: "another-run",
    waveId: "wave-1",
    requests: { codex: 10 },
    availableUnits: { claude: 10, codex: 10, grok: 10 },
    signal: new AbortController().signal,
  });

  const waiting = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(waiting.status, "waiting_quota");
  assert.equal(waiting.draft.plan.tasks.length, 3);
  assert.equal(waiting.draft.deferredTasks?.every(
    (task) => task.reason === "reservation_conflict",
  ), true);
  assert.equal(h.calls.some((call) => call.startsWith("start:")), false);
  assert.equal(h.reservationManager.snapshot().active, 1);
  await held.release();
  assert.equal(h.reservationManager.snapshot().active, 0);
});

test("renews a wave reservation until execution and integration finish", async () => {
  const h = await harness();
  const reservations = createCapacityReservationManager({ ttlMs: 30 });
  h.dependencies.reserveWaveCapacity = reservations.reserveWave;
  h.dependencies.startProcess = () => ({
    pid: 812,
    completion: delay(100).then(() => ({
      exitCode: 0,
      signal: null,
      stdoutLines: [],
      stderrLines: [],
    })),
    async cancel() {},
  });

  const completion = scheduleRun(h.request, h.dependencies).then((handle) => handle.completion);
  for (let attempt = 0; attempt < 100 && reservations.snapshot().active === 0; attempt += 1) {
    await delay(2);
  }
  assert.equal(reservations.snapshot().active, 1);
  await delay(60);
  await assert.rejects(
    () => reservations.reserveWave({
      runId: "another-run",
      waveId: "wave-1",
      requests: { codex: 10 },
      availableUnits: { claude: 10, codex: 10, grok: 10 },
      signal: new AbortController().signal,
    }),
    CapacityReservationConflictError,
  );
  assert.equal((await completion).status, "completed");
  assert.equal(reservations.snapshot().active, 0);
});

test("rechecks quota before every dependency wave and deterministically reassigns remaining work", async () => {
  const h = await harness();
  let checks = 0;
  h.dependencies.availableExecutionUnits = async () => {
    checks += 1;
    return checks === 1
      ? { claude: 10, codex: 10, grok: 10 }
      : { claude: 0, codex: 10, grok: 10 };
  };

  const completed = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.find((task) => task.id === "core")?.status, "completed");
  assert.equal(completed.tasks.find((task) => task.id === "ui")?.status, "completed");
  assert.equal(completed.tasks.find((task) => task.id === "finish")?.status, "completed");
  assert.equal(h.calls.some((call) => call === "start:finish:claude"), false);
  assert.equal(h.calls.some((call) => call === "start:finish:codex"), true);
});

test("holds the wave capacity reservation until every successful commit is integrated", async () => {
  const h = await harness();
  const cherryPickTask = h.dependencies.cherryPickTask;
  h.dependencies.cherryPickTask = async (...args) => {
    assert.equal(h.reservationManager.snapshot().active, 1);
    await cherryPickTask(...args);
  };

  const result = await (await scheduleRun(h.request, h.dependencies)).completion;

  assert.equal(result.status, "completed");
  assert.equal(h.reservationManager.snapshot().active, 0);
});

test("a nonzero native process preserves independently integrated work as partial success", async () => {
  const h = await harness();
  h.dependencies.startProcess = (input) => {
    const taskId = input.command.cwd.split("/").at(-1)!;
    const exitCode = taskId === "core" ? 9 : 0;
    return {
      pid: 1,
      completion: Promise.resolve({ exitCode, signal: null, stdoutLines: [], stderrLines: [] }),
      async cancel() {},
    };
  };
  const result = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(result.status, "partial_completed");
  assert.equal(result.tasks.find((task) => task.id === "core")?.status, "failed");
  assert.equal(result.tasks.find((task) => task.id === "ui")?.status, "completed");
  assert.equal(result.tasks.find((task) => task.id === "finish")?.status, "blocked");
  assert.equal(
    h.calls.some((call) => call === "commit:balance(core): Core"),
    false,
  );
  assert.equal(
    (await h.store.activities({ agent: "claude", role: "execution", limit: 20 }))
      .some((record) => record.taskId === "core" && !record.success),
    true,
  );
});

test("cancel moves through cancelling, stops in-flight processes and starts no later dependency", async () => {
  const h = await harness();
  h.dependencies.startProcess = (input) => {
    const taskId = input.command.cwd.split("/").at(-1)!;
    let resolve!: () => void;
    const completion = new Promise<{
      exitCode: number;
      signal: null;
      stdoutLines: string[];
      stderrLines: string[];
    }>((done) => {
      resolve = () => done({ exitCode: -1, signal: null, stdoutLines: [], stderrLines: [] });
    });
    h.controllers.set(taskId, { resolve, cancelled: false });
    return {
      pid: 1,
      completion,
      async cancel() {
        h.controllers.get(taskId)!.cancelled = true;
        resolve();
      },
    };
  };
  const handle = await scheduleRun(h.request, h.dependencies);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.cancel();
  const result = await handle.completion;
  assert.equal(result.status, "cancelled");
  assert.equal(
    [...h.controllers.values()].every((item) => item.cancelled),
    true,
  );
  assert.equal([...h.controllers.keys()].includes("finish"), false);
});

test("interrupt stops in-flight processes but persists an interrupted read-only run", async () => {
  const h = await harness();
  h.dependencies.startProcess = (input) => {
    const taskId = input.command.cwd.split("/").at(-1)!;
    let resolve!: () => void;
    const completion = new Promise<{
      exitCode: number;
      signal: null;
      stdoutLines: string[];
      stderrLines: string[];
    }>((done) => {
      resolve = () => done({ exitCode: -1, signal: null, stdoutLines: [], stderrLines: [] });
    });
    h.controllers.set(taskId, { resolve, cancelled: false });
    return {
      pid: 1,
      completion,
      async cancel() {
        h.controllers.get(taskId)!.cancelled = true;
        resolve();
      },
    };
  };
  const handle = await scheduleRun(h.request, h.dependencies);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.interrupt();
  const result = await handle.completion;
  assert.equal(result.status, "interrupted");
  assert.equal(
    result.tasks.every((task) => ["completed", "failed", "interrupted"].includes(task.status)),
    true,
  );
  assert.equal(
    [...h.controllers.values()].every((item) => item.cancelled),
    true,
  );
  assert.equal([...h.controllers.keys()].includes("finish"), false);
});

test("aborts a cherry-pick conflict and gives an eligible repair Agent one verified attempt", async () => {
  const h = await harness();
  let pickCount = 0;
  let conflictStarts = 0;
  let conflictPrompt = "";
  const originalStart = h.dependencies.startProcess;
  h.dependencies.cherryPickTask = async () => {
    pickCount += 1;
    h.calls.push(`pick:${pickCount}`);
    if (pickCount === 2) throw new Error("CONFLICT");
  };
  h.dependencies.conflictedFiles = async () => ["ui.ts", "shared.ts"];
  h.dependencies.repairAgentFor = async () => "codex";
  h.dependencies.startProcess = (input) => {
    if (input.command.cwd.endsWith("/integration")) {
      conflictStarts += 1;
      conflictPrompt = input.command.args.join(" ");
      h.calls.push("start:conflict");
      return {
        pid: 999,
        completion: Promise.resolve({
          exitCode: 0,
          signal: null,
          stdoutLines: [],
          stderrLines: [],
        }),
        async cancel() {},
      };
    }
    return originalStart(input);
  };
  const result = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(result.status, "completed");
  assert.equal(conflictStarts, 1);
  assert.equal(
    h.calls.filter((call) => call === "lease:got:repair:codex:conflict:ui").length,
    1,
  );
  assert.match(conflictPrompt, /ui\.ts/);
  assert.match(conflictPrompt, /shared\.ts/);
  assert.match(conflictPrompt, /UI|Implement UI/);
  assert.ok(h.calls.indexOf("abort") < h.calls.indexOf("start:conflict"));
  assert.equal(
    h.calls.filter((call) => call === "commit:fix(orchestrator): resolve ui integration conflict")
      .length,
    1,
  );
  assert.equal(
    h.calls.some((call) => call.startsWith("verify:integration:git diff --check")),
    true,
  );
  assert.deepEqual(
    (await h.store.activities({ role: "repair", limit: 20 }))
      .map((record) => ({ taskId: record.taskId, success: record.success })),
    [{ taskId: "ui", success: true }],
  );
});

test("does not retry a failed coordinator conflict repair", async () => {
  const h = await harness();
  let conflictStarts = 0;
  const originalStart = h.dependencies.startProcess;
  h.dependencies.cherryPickTask = async () => {
    throw new Error("CONFLICT");
  };
  h.dependencies.conflictedFiles = async () => ["core.ts"];
  h.dependencies.startProcess = (input) => {
    if (input.command.cwd.endsWith("/integration")) {
      conflictStarts += 1;
      return {
        pid: 999,
        completion: Promise.resolve({
          exitCode: 7,
          signal: null,
          stdoutLines: [],
          stderrLines: [],
        }),
        async cancel() {},
      };
    }
    return originalStart(input);
  };
  const result = await (await scheduleRun(h.request, h.dependencies)).completion;
  assert.equal(result.status, "failed");
  assert.equal(conflictStarts, 1);
  assert.deepEqual(
    (await h.store.activities({ role: "repair", limit: 20 }))
      .map((record) => ({ taskId: record.taskId, success: record.success })),
    [{ taskId: "core", success: false }],
  );
});
