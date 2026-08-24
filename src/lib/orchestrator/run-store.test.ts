import assert from "node:assert/strict";
import { access, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createRunStore } from "./run-store.server.ts";
import type {
  OrchestratorRun,
  RunStatus,
  TaskStatus,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

async function temporaryDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `balance-run-store-${label}-`));
}

function fileMode(value: number): number {
  return value & 0o777;
}

function sampleRun(options: {
  id?: string;
  status?: RunStatus;
  taskStatus?: TaskStatus;
  updatedAt?: number;
} = {}): OrchestratorRun {
  const id = options.id ?? "run_20260824120000_a1b2c3d4e5f6";
  const now = options.updatedAt ?? Date.now();
  const task = {
    id: "task-api",
    title: "Add API",
    description: "Implement the endpoint.",
    size: "small" as const,
    preferredAgent: null,
    assignedAgent: "codex" as const,
    dependsOn: [],
    expectedFiles: ["src/api.ts"],
    acceptanceCriteria: ["Endpoint returns 200"],
    verificationCommands: [{ executable: "npm" as const, args: ["run", "test"] }],
  };
  return {
    id,
    status: options.status ?? "draft",
    repositoryPath: "/repo/project",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    coordinator: "claude",
    resultBranch: null,
    integrationWorktree: null,
    repositoryTrustedAt: null,
    error: null,
    draft: {
      runId: id,
      repositoryPath: "/repo/project",
      repositoryDevice: 123,
      repositoryInode: 456,
      repositoryDirtyAtAnalysis: false,
      baseBranch: "main",
      baseSha: "a".repeat(40),
      coordinator: "claude",
      prompt: "Build the API",
      plan: {
        title: "API plan",
        summary: "Implement and verify the endpoint.",
        tasks: [{ ...task, assignedAgent: undefined }].map(({ assignedAgent: _, ...planTask }) => planTask),
      },
      assignedTasks: [task],
      fingerprint: "b".repeat(64),
      createdAt: now,
    },
    tasks: [{
      ...task,
      status: options.taskStatus ?? "queued",
      worktree: null,
      commitSha: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    }],
    createdAt: now,
    updatedAt: now,
  };
}

test("creates a private run layout and atomically reads and lists draft runs", async () => {
  const root = await temporaryDirectory("create");
  const store = createRunStore(root);
  await store.initialize();
  const run = sampleRun();
  await store.create(run);

  assert.deepEqual(await store.get(run.id), run);
  assert.deepEqual(await store.list(), [run]);
  assert.equal(fileMode((await lstat(root)).mode), 0o700);
  const runRoot = join(root, "runs", run.id);
  for (const directory of [
    runRoot,
    join(runRoot, "stdout"),
    join(runRoot, "stderr"),
    join(runRoot, "integration"),
    join(runRoot, "tasks"),
  ]) {
    assert.equal(fileMode((await lstat(directory)).mode), 0o700);
  }
  assert.equal(fileMode((await lstat(join(runRoot, "run.json"))).mode), 0o600);
  await assert.rejects(() => store.create(run), /exist|duplicate/i);
  await assert.rejects(() => store.get("../../escape"), /run id/i);
});

test("enforces run and task state machines while allowing atomic metadata updates", async () => {
  const root = await temporaryDirectory("transitions");
  const store = createRunStore(root);
  await store.initialize();
  const run = sampleRun();
  await store.create(run);

  const ready = await store.update(run.id, (current) => ({
    ...current,
    status: "ready",
    updatedAt: current.updatedAt + 1,
  }));
  assert.equal(ready.status, "ready");
  const running = await store.update(run.id, (current) => ({
    ...current,
    status: "running",
    tasks: current.tasks.map((task) => ({ ...task, status: "preparing" })),
    updatedAt: current.updatedAt + 1,
  }));
  assert.equal(running.tasks[0]!.status, "preparing");
  await assert.rejects(
    () => store.update(run.id, (current) => ({ ...current, status: "completed" })),
    /transition/i,
  );
  await assert.rejects(
    () => store.update(run.id, (current) => ({
      ...current,
      tasks: current.tasks.map((task) => ({ ...task, status: "completed" })),
    })),
    /transition/i,
  );
});

test("serializes concurrent updates per run without losing mutations", async () => {
  const root = await temporaryDirectory("concurrent-update");
  const store = createRunStore(root);
  await store.initialize();
  const run = sampleRun();
  await store.create(run);
  await Promise.all(Array.from({ length: 25 }, () =>
    store.update(run.id, (current) => ({
      ...current,
      error: String(Number(current.error ?? "0") + 1),
      updatedAt: current.updatedAt + 1,
    })),
  ));
  const final = await store.get(run.id);
  assert.equal(final?.error, "25");
  assert.equal(final?.updatedAt, run.updatedAt + 25);
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, "runs", run.id, "run.json"), "utf8")));
});

test("appends redacted JSONL events with monotonic sequence and afterSeq reads", async () => {
  const root = await temporaryDirectory("events");
  const store = createRunStore(root);
  await store.initialize();
  const run = sampleRun();
  await store.create(run);

  const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    store.appendEvent({
      runId: run.id,
      taskId: "task-api",
      agent: "codex",
      at: run.createdAt + index,
      event: {
        type: "diagnostic",
        stream: "stderr",
        message: `event ${index} Authorization: Bearer secret-${index}`,
      },
    }),
  ));
  assert.deepEqual(records.map((record) => record.seq).sort((left, right) => left - right),
    Array.from({ length: 20 }, (_, index) => index + 1));
  const all = await store.events(run.id);
  assert.deepEqual(all.map((record) => record.seq), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual((await store.events(run.id, 17)).map((record) => record.seq), [18, 19, 20]);
  assert.equal(JSON.stringify(all).includes("secret-"), false);
  assert.equal(fileMode((await lstat(join(root, "runs", run.id, "events.jsonl"))).mode), 0o600);
});

test("persists redacted role activity and calculates no synthetic history", async () => {
  const root = await temporaryDirectory("activity");
  const store = createRunStore(root);
  await store.initialize();
  const run = sampleRun();
  await store.create(run);

  await store.appendActivity({
    runId: run.id,
    taskId: null,
    agent: "codex",
    role: "planning",
    startedAt: run.createdAt,
    finishedAt: run.createdAt + 25,
    success: true,
    sessionId: "session-1",
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 },
    events: [
      { type: "session_started", sessionId: "session-1" },
      { type: "usage", inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 },
      {
        type: "diagnostic",
        stream: "stderr",
        message: "Authorization: Bearer planning-secret",
      },
    ],
  });
  await store.appendActivity({
    runId: run.id,
    taskId: "task-api",
    agent: "codex",
    role: "execution",
    startedAt: run.createdAt + 30,
    finishedAt: run.createdAt + 50,
    success: false,
    sessionId: null,
    usage: null,
    events: [],
  });

  const records = await store.activities();
  assert.deepEqual(records.map((record) => record.seq), [1, 2]);
  assert.equal(records[0]?.role, "planning");
  assert.equal(records[0]?.usage?.inputTokens, 120);
  assert.equal(JSON.stringify(records).includes("planning-secret"), false);
  assert.deepEqual((await store.activities({ agent: "codex", role: "planning", limit: 20 }))
    .map((record) => record.success), [true]);
  assert.equal(fileMode((await lstat(join(root, "agent-activity.jsonl"))).mode), 0o600);
});

test("recovers only nonterminal runs and tasks as interrupted", async () => {
  const root = await temporaryDirectory("recovery");
  const store = createRunStore(root);
  await store.initialize();
  const running = sampleRun({
    id: "run_20260824120001_a1b2c3d4e5f7",
    status: "running",
    taskStatus: "running",
  });
  const blocked = sampleRun({
    id: "run_20260824120002_a1b2c3d4e5f8",
    status: "capacity_blocked",
    taskStatus: "queued",
  });
  blocked.draft.assignedTasks = [];
  blocked.tasks = [];
  const completed = sampleRun({
    id: "run_20260824120003_a1b2c3d4e5f9",
    status: "completed",
    taskStatus: "completed",
  });
  await store.create(running);
  await store.create(blocked);
  await store.create(completed);
  assert.deepEqual(await store.recoverInterrupted(), [running.id]);
  assert.equal((await store.get(running.id))?.status, "interrupted");
  assert.equal((await store.get(running.id))?.tasks[0]?.status, "interrupted");
  assert.deepEqual(await store.get(blocked.id), blocked);
  assert.deepEqual(await store.get(completed.id), completed);
});

test("quarantines corrupt run files and emits a private diagnostic", async () => {
  const root = await temporaryDirectory("corrupt");
  const store = createRunStore(root);
  await store.initialize();
  const corruptId = "run_20260824120004_a1b2c3d4e5fa";
  const corruptRoot = join(root, "runs", corruptId);
  await mkdir(corruptRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(corruptRoot, "run.json"), "{not-json", { mode: 0o600 });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => access(join(corruptRoot, "run.json"), constants.F_OK));
  const quarantine = JSON.parse(await readFile(join(corruptRoot, "run.corrupt.json"), "utf8")) as { diagnostic: string };
  assert.match(quarantine.diagnostic, /corrupt|invalid|读取|损坏/i);
  assert.equal(fileMode((await lstat(join(corruptRoot, "run.corrupt.json"))).mode), 0o600);
});

test("refuses a run directory swapped to a symbolic link", async () => {
  const root = await temporaryDirectory("run-symlink");
  const store = createRunStore(root);
  await store.initialize();
  const run = sampleRun({ id: "run_20260824120005_a1b2c3d4e5fb" });
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "run.json"), JSON.stringify(run), { mode: 0o600 });
  await symlink(outside, join(root, "runs", run.id));
  await assert.rejects(() => store.get(run.id), /symbolic|unsafe|symlink/i);
  assert.equal(JSON.parse(await readFile(join(outside, "run.json"), "utf8")).id, run.id);
});

test("holds one instance lock, rejects a live holder and reclaims a stale lock", async () => {
  const root = await temporaryDirectory("lock");
  const first = createRunStore(root);
  const second = createRunStore(root);
  await first.initialize();
  await second.initialize();
  const release = await first.acquireInstanceLock();
  await assert.rejects(() => second.acquireInstanceLock(), /already|instance|running|锁/i);
  await release();
  const secondRelease = await second.acquireInstanceLock();
  await secondRelease();

  await writeFile(join(root, "instance.lock"), JSON.stringify({
    pid: 2_147_483_647,
    nonce: "00000000-0000-4000-8000-000000000001",
    acquiredAt: 1,
  }), { mode: 0o600 });
  const staleRelease = await first.acquireInstanceLock();
  await staleRelease();
});

test("prunes terminal runs older than 30 days only when no worktree is registered", async () => {
  const root = await temporaryDirectory("prune");
  const store = createRunStore(root);
  await store.initialize();
  const now = Date.now();
  const old = sampleRun({
    id: "run_20260601120000_a1b2c3d4e501",
    status: "completed",
    taskStatus: "completed",
    updatedAt: now - 31 * DAY_MS,
  });
  const recent = sampleRun({
    id: "run_20260820120000_a1b2c3d4e502",
    status: "completed",
    taskStatus: "completed",
    updatedAt: now - 2 * DAY_MS,
  });
  const withWorktree = sampleRun({
    id: "run_20260601120000_a1b2c3d4e503",
    status: "failed",
    taskStatus: "failed",
    updatedAt: now - 31 * DAY_MS,
  });
  withWorktree.tasks[0]!.worktree = {
    path: join(root, "runs", withWorktree.id, "tasks", "task-api"),
    device: 1,
    inode: 2,
    branch: "balance/run-old-task-api",
  };
  await store.create(old);
  await store.create(recent);
  await store.create(withWorktree);
  assert.deepEqual(await store.pruneExpired(now), [old.id]);
  assert.equal(await store.get(old.id), null);
  assert.ok(await store.get(recent.id));
  assert.ok(await store.get(withWorktree.id));
});
