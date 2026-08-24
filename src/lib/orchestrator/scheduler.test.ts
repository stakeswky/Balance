import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprintPlan } from "./plan.ts";
import { createRunStore } from "./run-store.server.ts";
import {
  scheduleRun,
  type SchedulerDependencies,
  type StartRunRequest,
} from "./scheduler.server.ts";
import type { OrchestratorRun, PlanDraft, TaskRunState, WorktreeRegistration } from "./types.ts";

const RUN_ID = "run_20260824140000_a1b2c3d4e5f6";

function draft(): PlanDraft {
  const tasks = [
    {
      id: "core",
      title: "Core",
      description: "Implement core.",
      size: "small" as const,
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
        "balance/run-a1b2c3d4e5f6-result",
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
        assert.equal((await store.get(RUN_ID))?.tasks.find((task) => task.id === taskId)?.status, "integrating");
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
    runId: RUN_ID,
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
});

test("a nonzero native process fails its task and blocks dependents without commit", async () => {
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
  assert.equal(result.status, "failed");
  assert.equal(result.tasks.find((task) => task.id === "core")?.status, "failed");
  assert.equal(result.tasks.find((task) => task.id === "finish")?.status, "blocked");
  assert.equal(
    h.calls.some((call) => call === "commit:balance(core): Core"),
    false,
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

test("aborts a cherry-pick conflict and gives the coordinator one verified repair attempt", async () => {
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
});
