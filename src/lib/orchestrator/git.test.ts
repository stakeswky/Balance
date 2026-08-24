import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
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
import { createRunStore } from "./run-store.server.ts";
import type { OrchestratorRun, WorktreeRegistration } from "./types.ts";

const execFileAsync = promisify(execFile);
const RUN_ID = "run_20260824130000_a1b2c3d4e5f6";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Test User",
    "-c", "user.email=test@example.com",
    ...args,
  ], { cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd } });
  return stdout.trim();
}

async function temporaryDirectory(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `balance-git-${label}-`)));
}

async function createRepository(label: string): Promise<string> {
  const root = await temporaryDirectory(label);
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

test("inspects canonical repositories and rejects unsafe repository states", async () => {
  const nonRepository = await temporaryDirectory("non-repo");
  await assert.rejects(() => inspectRepository(nonRepository, "analyze"), /repository|work tree/i);

  const repository = await createRepository("inspect");
  const clean = await inspectRepository(repository, "analyze");
  assert.equal(clean.root, repository);
  assert.equal(clean.branch, "main");
  assert.equal(clean.dirty, false);
  assert.match(clean.head, /^[0-9a-f]{40}$/);
  assert.ok(clean.device > 0 && clean.inode > 0);
  await writeFile(join(repository, "dirty.txt"), "dirty\n");
  assert.equal((await inspectRepository(repository, "analyze")).dirty, true);
  await assert.rejects(() => inspectRepository(repository, "execute"), /dirty|clean/i);
  await rm(join(repository, "dirty.txt"));

  await git(repository, ["checkout", "--detach"]);
  await assert.rejects(() => inspectRepository(repository, "analyze"), /detached|branch/i);
  await git(repository, ["checkout", "main"]);
  await writeFile(join(repository, ".git", "MERGE_HEAD"), clean.head);
  await assert.rejects(() => inspectRepository(repository, "analyze"), /merge|operation/i);
  await rm(join(repository, ".git", "MERGE_HEAD"));
  await mkdir(join(repository, ".git", "rebase-merge"));
  await assert.rejects(() => inspectRepository(repository, "analyze"), /rebase|operation/i);
  await rm(join(repository, ".git", "rebase-merge"), { recursive: true });

  const noHead = await temporaryDirectory("no-head");
  await git(noHead, ["init", "-b", "main"]);
  await assert.rejects(() => inspectRepository(noHead, "analyze"), /HEAD|commit/i);
  const bare = await temporaryDirectory("bare");
  await git(bare, ["init", "--bare"]);
  await assert.rejects(() => inspectRepository(bare, "analyze"), /bare|work tree/i);
});

test("rejects symbolic-link repository entry and a draft analyzed while dirty", async () => {
  const repository = await createRepository("identity");
  const parent = dirname(repository);
  const link = join(parent, `${repository.split("/").at(-1)}-link`);
  await symlink(repository, link);
  await assert.rejects(() => inspectRepository(link, "analyze"), /symbolic|symlink/i);

  await writeFile(join(repository, "dirty.txt"), "dirty\n");
  const dirtySnapshot = await inspectRepository(repository, "analyze");
  await rm(join(repository, "dirty.txt"));
  const stateRoot = await temporaryDirectory("dirty-state");
  await mkdir(join(stateRoot, "runs", RUN_ID, "integration"), { recursive: true });
  await assert.rejects(
    () => createIntegrationWorktree({ repository: dirtySnapshot, runId: RUN_ID, stateRoot }),
    /reanaly|dirty|重新分析/i,
  );
});

test("isolates integration and task worktrees, bypasses hooks and preserves original HEAD", async () => {
  const repository = await createRepository("worktrees");
  const snapshot = await inspectRepository(repository, "execute");
  const stateRoot = await temporaryDirectory("state");
  await mkdir(join(stateRoot, "runs", RUN_ID, "integration"), { recursive: true });
  await mkdir(join(stateRoot, "runs", RUN_ID, "tasks"), { recursive: true });
  const hookMarker = join(repository, "hook-ran");
  for (const hook of ["post-checkout", "pre-commit"]) {
    const path = join(repository, ".git", "hooks", hook);
    await writeFile(path, `#!/bin/sh\nprintf ran > '${hookMarker}'\nexit 9\n`, { mode: 0o755 });
  }

  const integration = await createIntegrationWorktree({ repository: snapshot, runId: RUN_ID, stateRoot });
  const task = await createTaskWorktree({
    repository: snapshot, runId: RUN_ID, taskId: "task-api", stateRoot,
    baseSha: snapshot.head, integrationWorktree: integration,
  });
  assert.equal(integration.path, join(stateRoot, "runs", RUN_ID, "integration"));
  assert.equal(task.path, join(stateRoot, "runs", RUN_ID, "tasks", "task-api"));
  assert.equal(integration.branch, "balance/run-a1b2c3d4e5f6-result");
  assert.equal(task.branch, "balance/run-a1b2c3d4e5f6-task-api");
  await assert.rejects(() => readFile(hookMarker));

  await writeFile(join(task.path, "src.txt"), "task change\n");
  const taskCommit = await commitTaskWorktree(task.path, "balance(task-api): Add API");
  assert.match(taskCommit, /^[0-9a-f]{40}$/);
  assert.equal(await git(task.path, ["show", "-s", "--format=%an <%ae>", "HEAD"]), "Balance Orchestrator <balance@localhost>");
  await assert.rejects(() => commitTaskWorktree(task.path, "empty"), /no changes|nothing/i);
  await cherryPickTask(integration.path, taskCommit);
  assert.equal(await readFile(join(integration.path, "src.txt"), "utf8"), "task change\n");
  await assertOriginalHeadUnchanged(snapshot);
  assert.equal(await git(repository, ["branch", "--show-current"]), "main");
  assert.equal(await git(repository, ["rev-parse", "HEAD"]), snapshot.head);
});

test("aborts a conflicting cherry-pick back to a clean integration tree", async () => {
  const repository = await createRepository("conflict");
  const snapshot = await inspectRepository(repository, "execute");
  const stateRoot = await temporaryDirectory("conflict-state");
  await mkdir(join(stateRoot, "runs", RUN_ID, "integration"), { recursive: true });
  await mkdir(join(stateRoot, "runs", RUN_ID, "tasks"), { recursive: true });
  const integration = await createIntegrationWorktree({ repository: snapshot, runId: RUN_ID, stateRoot });
  const first = await createTaskWorktree({
    repository: snapshot, runId: RUN_ID, taskId: "first", stateRoot,
    baseSha: snapshot.head, integrationWorktree: integration,
  });
  const second = await createTaskWorktree({
    repository: snapshot, runId: RUN_ID, taskId: "second", stateRoot,
    baseSha: snapshot.head, integrationWorktree: integration,
  });
  await writeFile(join(first.path, "README.md"), "first\n");
  await writeFile(join(second.path, "README.md"), "second\n");
  const firstCommit = await commitTaskWorktree(first.path, "balance(first): first");
  const secondCommit = await commitTaskWorktree(second.path, "balance(second): second");
  await cherryPickTask(integration.path, firstCommit);
  await assert.rejects(() => cherryPickTask(integration.path, secondCommit), /cherry-pick|conflict|failed/i);
  await abortCherryPick(integration.path);
  assert.equal(await git(integration.path, ["status", "--porcelain"]), "");
  assert.equal(await readFile(join(integration.path, "README.md"), "utf8"), "first\n");
});

test("creates dependent task worktrees from the current trusted integration HEAD", async () => {
  const repository = await createRepository("dependency-baseline");
  const snapshot = await inspectRepository(repository, "execute");
  const stateRoot = await temporaryDirectory("dependency-baseline-state");
  await mkdir(join(stateRoot, "runs", RUN_ID, "integration"), { recursive: true });
  await mkdir(join(stateRoot, "runs", RUN_ID, "tasks"), { recursive: true });
  const integration = await createIntegrationWorktree({ repository: snapshot, runId: RUN_ID, stateRoot });

  const taskA = await createTaskWorktree({
    repository: snapshot, runId: RUN_ID, taskId: "task-a", stateRoot,
    baseSha: snapshot.head, integrationWorktree: integration,
  });
  await writeFile(join(taskA.path, "dependency.txt"), "exported by A\n");
  const taskACommit = await commitTaskWorktree(taskA.path, "balance(task-a): export dependency");
  await cherryPickTask(integration.path, taskACommit);
  const integratedHead = await readWorktreeHead(integration.path);
  assert.notEqual(integratedHead, snapshot.head);

  const taskB = await createTaskWorktree({
    repository: snapshot, runId: RUN_ID, taskId: "task-b", stateRoot,
    baseSha: integratedHead, integrationWorktree: integration,
  });
  assert.equal(await readFile(join(taskB.path, "dependency.txt"), "utf8"), "exported by A\n");
  assert.equal(await git(taskB.path, ["merge-base", "--is-ancestor", taskACommit, "HEAD"]), "");

  await assert.rejects(
    () => createTaskWorktree({
      repository: snapshot, runId: RUN_ID, taskId: "stale-task", stateRoot,
      baseSha: snapshot.head, integrationWorktree: integration,
    }),
    /current integration HEAD/i,
  );
  await assert.rejects(
    () => createTaskWorktree({
      repository: snapshot, runId: RUN_ID, taskId: "unknown-task", stateRoot,
      baseSha: "f".repeat(40), integrationWorktree: integration,
    }),
    /current integration HEAD|commit/i,
  );
});

test("fails closed for executable Git and Agent configuration", async () => {
  const configCases: Array<[string, string, string]> = [
    ["filter.evil.clean", "touch /tmp/evil", "filter"],
    ["diff.evil.command", "touch /tmp/evil", "diff"],
    ["merge.evil.driver", "touch /tmp/evil", "merge"],
    ["gpg.program", "/tmp/evil", "gpg"],
    ["credential.helper", "/tmp/evil", "credential"],
    ["core.fsmonitor", "/tmp/evil", "fsmonitor"],
    ["core.sshCommand", "/tmp/evil", "ssh"],
  ];
  for (const [index, [key, value, expected]] of configCases.entries()) {
    const repository = await createRepository(`config-${index}`);
    await git(repository, ["config", "--local", key, value]);
    await assert.rejects(() => inspectRepository(repository, "execute"), new RegExp(expected, "i"));
  }

  for (const [index, path] of [
    ".mcp.json", ".claude/settings.json", ".claude/settings.local.json",
    ".codex/config.toml", ".grok/config.toml",
  ].entries()) {
    const repository = await createRepository(`agent-config-${index}`);
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), "{}\n");
    await assert.rejects(() => inspectRepository(repository, "execute"), /agent|config|mcp|settings/i);
  }

  const trackedAttributes = await createRepository("tracked-attrs");
  await writeFile(join(trackedAttributes, ".gitattributes"), "*.txt filter=evil\n");
  await git(trackedAttributes, ["add", ".gitattributes"]);
  await git(trackedAttributes, ["commit", "-m", "attributes"]);
  await assert.rejects(() => inspectRepository(trackedAttributes, "execute"), /attribute|filter/i);

  const infoAttributes = await createRepository("info-attrs");
  await writeFile(join(infoAttributes, ".git", "info", "attributes"), "*.txt filter=evil\n");
  await assert.rejects(() => inspectRepository(infoAttributes, "execute"), /attribute|filter/i);
});

function runWithRegistrations(
  repository: string,
  snapshot: Awaited<ReturnType<typeof inspectRepository>>,
  integration: WorktreeRegistration,
  task: WorktreeRegistration,
): OrchestratorRun {
  const baseTask = {
    id: "task-api", title: "Add API", description: "Implement it.", size: "small" as const,
    preferredAgent: null, assignedAgent: "codex" as const, dependsOn: [], expectedFiles: ["src.txt"],
    acceptanceCriteria: ["works"], verificationCommands: [{ executable: "git" as const, args: ["diff", "--check"] }],
  };
  const now = Date.now();
  return {
    id: RUN_ID, status: "running", repositoryPath: repository, baseBranch: snapshot.branch, baseSha: snapshot.head,
    coordinator: "claude", resultBranch: integration.branch, integrationWorktree: integration,
    repositoryTrustedAt: now, error: null,
    draft: {
      runId: RUN_ID, repositoryPath: repository, repositoryDevice: snapshot.device, repositoryInode: snapshot.inode,
      repositoryDirtyAtAnalysis: false, baseBranch: snapshot.branch, baseSha: snapshot.head, coordinator: "claude",
      prompt: "work", plan: { title: "Plan", summary: "Summary", tasks: [{ ...baseTask, assignedAgent: undefined }].map(({ assignedAgent: _, ...item }) => item) },
      assignedTasks: [baseTask], fingerprint: "f".repeat(64), createdAt: now,
    },
    tasks: [{ ...baseTask, status: "running", worktree: task, commitSha: null, error: null, startedAt: now, finishedAt: null }],
    createdAt: now, updatedAt: now,
  };
}

test("removes only worktrees registered in the run store and retains only the result branch", async () => {
  const repository = await createRepository("cleanup");
  const snapshot = await inspectRepository(repository, "execute");
  const stateRoot = await temporaryDirectory("cleanup-state");
  const store = createRunStore(stateRoot);
  await store.initialize();
  const draftRun = runWithRegistrations(repository, snapshot,
    { path: "/placeholder/integration", device: 1, inode: 1, branch: "placeholder" },
    { path: "/placeholder/task", device: 1, inode: 1, branch: "placeholder" });
  draftRun.integrationWorktree = null;
  draftRun.tasks[0]!.worktree = null;
  draftRun.status = "draft";
  draftRun.tasks[0]!.status = "queued";
  await store.create(draftRun);
  const integration = await createIntegrationWorktree({ repository: snapshot, runId: RUN_ID, stateRoot });
  const task = await createTaskWorktree({
    repository: snapshot, runId: RUN_ID, taskId: "task-api", stateRoot,
    baseSha: snapshot.head, integrationWorktree: integration,
  });
  await store.update(RUN_ID, (run) => ({
    ...run, status: "ready", integrationWorktree: integration,
    tasks: run.tasks.map((item) => ({ ...item, worktree: task })), updatedAt: run.updatedAt + 1,
  }));

  await removeRegisteredWorktree({ store, repositoryRoot: repository, runId: RUN_ID, slot: { kind: "task", taskId: "task-api" }, stateRoot });
  await removeRegisteredWorktree({ store, repositoryRoot: repository, runId: RUN_ID, slot: { kind: "integration" }, stateRoot });
  const branches = await git(repository, ["branch", "--format=%(refname:short)"]);
  assert.equal(branches.includes("balance/run-a1b2c3d4e5f6-task-api"), false);
  assert.equal(branches.includes("balance/run-a1b2c3d4e5f6-result"), true);
  assert.equal((await store.get(RUN_ID))?.integrationWorktree, null);
  assert.equal((await store.get(RUN_ID))?.tasks[0]?.worktree, null);

  await assert.rejects(
    () => removeRegisteredWorktree({ store, repositoryRoot: repository, runId: RUN_ID, slot: { kind: "task", taskId: "task-api" }, stateRoot }),
    /registration|registered/i,
  );
});
