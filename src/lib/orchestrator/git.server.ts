import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { ensurePrivateDirectory } from "./paths.server.ts";
import type { RunStore } from "./run-store.server.ts";
import type { WorktreeRegistration } from "./types.ts";

const GIT = "/usr/bin/git";
const RUN_ID = /^run_\d{14}_[0-9a-f]{12}$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT = 10 * 1024 * 1024;
const GIT_PREFIX = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
] as const;
const AGENT_CONFIG_PATHS = [
  ".mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml",
  ".grok/config.toml",
] as const;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_DIFF_OPTS: "",
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      GIT,
      [...GIT_PREFIX, ...args],
      {
        cwd,
        env: gitEnvironment(),
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_OUTPUT_LIMIT,
      },
      (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : error
            ? -1
            : 0;
        if (error && !allowedExitCodes.includes(code)) {
          const detail = String(stderr || error.message).trim().slice(0, 2_000);
          rejectResult(new Error(`git command failed${detail ? `: ${detail}` : ""}`));
          return;
        }
        resolveResult({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

function pathPrefixes(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const prefixes: string[] = [];
  let current = root;
  for (const segment of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}

async function canonicalPathWithoutSymlinks(path: string, label: string): Promise<string> {
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path without NUL`);
  }
  for (const prefix of pathPrefixes(path)) {
    const metadata = await lstat(prefix);
    const trustedDarwinAlias =
      process.platform === "darwin" &&
      ["/etc", "/tmp", "/var"].includes(prefix) &&
      metadata.uid === 0 &&
      (await realpath(prefix)) === `/private${prefix}`;
    if (metadata.isSymbolicLink() && !trustedDarwinAlias) {
      throw new Error(`${label} contains a symbolic link: ${prefix}`);
    }
  }
  return realpath(path);
}

function containsFilterAttribute(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return trimmed.split(/\s+/).slice(1).some((attribute) =>
      attribute === "filter" ||
      attribute === "-filter" ||
      attribute === "!filter" ||
      attribute.startsWith("filter="));
  });
}

function forbiddenConfigReason(key: string): string | null {
  const normalized = key.toLowerCase();
  if (normalized.startsWith("filter.")) return "filter configuration";
  if (/^diff\..*\.command$/.test(normalized)) return "diff command configuration";
  if (/^merge\..*\.driver$/.test(normalized)) return "merge driver configuration";
  if (normalized.startsWith("gpg.")) return "gpg program configuration";
  if (normalized.startsWith("credential.")) return "credential helper configuration";
  if (normalized === "core.fsmonitor") return "fsmonitor configuration";
  if (normalized === "core.sshcommand") return "SSH command configuration";
  return null;
}

async function assertSafeLocalConfiguration(root: string): Promise<void> {
  const config = await runGit(root, ["config", "--local", "--no-includes", "--name-only", "--null", "--list"]);
  for (const key of config.stdout.split("\0").filter(Boolean)) {
    const reason = forbiddenConfigReason(key);
    if (reason) throw new Error(`repository contains unsafe ${reason}: ${key}`);
  }
}

async function assertNoAgentConfiguration(root: string): Promise<void> {
  for (const relativePath of AGENT_CONFIG_PATHS) {
    try {
      await lstat(join(root, relativePath));
      throw new Error(`repository contains executable Agent configuration: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function assertNoFilterAttributes(root: string, head: string): Promise<void> {
  const tree = await runGit(root, ["ls-tree", "-r", "-z", "--name-only", head]);
  for (const path of tree.stdout.split("\0").filter((entry) => entry.endsWith(".gitattributes"))) {
    const attributes = await runGit(root, ["show", `${head}:${path}`]);
    if (containsFilterAttribute(attributes.stdout)) {
      throw new Error(`repository attribute file declares an unsafe filter: ${path}`);
    }
  }
  const workingTreeFiles = await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  for (const path of workingTreeFiles.stdout.split("\0").filter((entry) => entry.endsWith(".gitattributes"))) {
    try {
      if (containsFilterAttribute(await readFile(join(root, path), "utf8"))) {
        throw new Error(`working tree attribute file declares an unsafe filter: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const infoPathResult = await runGit(root, ["rev-parse", "--git-path", "info/attributes"]);
  const infoPath = isAbsolute(infoPathResult.stdout.trim())
    ? infoPathResult.stdout.trim()
    : resolve(root, infoPathResult.stdout.trim());
  try {
    const metadata = await stat(infoPath);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) {
      throw new Error("repository info/attributes is not a safe regular file");
    }
    if (containsFilterAttribute(await readFile(infoPath, "utf8"))) {
      throw new Error("repository info/attributes declares an unsafe filter");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertNoOperationInProgress(root: string): Promise<void> {
  const gitDirectoryResult = await runGit(root, ["rev-parse", "--absolute-git-dir"]);
  const gitDirectory = gitDirectoryResult.stdout.trim();
  for (const [name, label] of [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ] as const) {
    try {
      await lstat(join(gitDirectory, name));
      throw new Error(`repository has a ${label} operation in progress`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface RepositorySnapshot {
  root: string;
  device: number;
  inode: number;
  branch: string;
  head: string;
  dirty: boolean;
}

export async function inspectRepository(
  path: string,
  mode: "analyze" | "execute",
): Promise<RepositorySnapshot> {
  const inputRoot = await canonicalPathWithoutSymlinks(path, "repository path");
  const metadata = await stat(inputRoot);
  if (!metadata.isDirectory()) throw new Error("repository path is not a directory");
  let inside: GitResult;
  try {
    inside = await runGit(inputRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("path is not a Git work tree repository");
  }
  if (inside.stdout.trim() !== "true") throw new Error("bare repositories are not supported");
  const topLevel = await runGit(inputRoot, ["rev-parse", "--show-toplevel"]);
  const root = await realpath(topLevel.stdout.trim());
  if (root !== inputRoot) throw new Error("repository path must identify the work tree root");
  const headResult = await runGit(root, ["rev-parse", "--verify", "HEAD"], [0, 128]);
  const head = headResult.stdout.trim();
  if (headResult.code !== 0 || !SHA.test(head)) throw new Error("repository has no valid HEAD commit");
  const branchResult = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]);
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || !branch) throw new Error("detached HEAD repositories are not supported");
  await assertNoOperationInProgress(root);
  await assertSafeLocalConfiguration(root);
  await assertNoAgentConfiguration(root);
  await assertNoFilterAttributes(root, head);
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirty = status.stdout.length > 0;
  if (mode === "execute" && dirty) throw new Error("repository must be clean before execution");
  return {
    root,
    device: metadata.dev,
    inode: metadata.ino,
    branch,
    head,
    dirty,
  };
}

function assertRunAndTask(runId: string, taskId?: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  if (taskId !== undefined && !TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
}

async function assertSnapshotCurrent(repository: RepositorySnapshot): Promise<void> {
  if (repository.dirty) throw new Error("repository was dirty during analysis; clean it and reanalyze before execution");
  const current = await inspectRepository(repository.root, "execute");
  if (
    current.root !== repository.root ||
    current.device !== repository.device ||
    current.inode !== repository.inode ||
    current.branch !== repository.branch ||
    current.head !== repository.head
  ) {
    throw new Error("repository identity, branch or HEAD changed after analysis");
  }
}

async function preparedTarget(stateRoot: string, relative: string[]): Promise<string> {
  const canonicalStateRoot = await canonicalPathWithoutSymlinks(stateRoot, "state root");
  const target = join(canonicalStateRoot, ...relative);
  await ensurePrivateDirectory(target);
  if ((await readdir(target)).length > 0) throw new Error(`worktree target is not empty: ${target}`);
  return target;
}

async function registerWorktree(path: string): Promise<WorktreeRegistration> {
  const canonical = await canonicalPathWithoutSymlinks(path, "worktree path");
  const metadata = await stat(canonical);
  const branch = (await runGit(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch) throw new Error("created worktree has no branch");
  return { path: canonical, device: metadata.dev, inode: metadata.ino, branch };
}

function shortRunId(runId: string): string {
  return runId.slice(-12);
}

export async function createIntegrationWorktree(input: {
  repository: RepositorySnapshot;
  runId: string;
  stateRoot: string;
}): Promise<WorktreeRegistration> {
  assertRunAndTask(input.runId);
  await assertSnapshotCurrent(input.repository);
  const target = await preparedTarget(input.stateRoot, ["runs", input.runId, "integration"]);
  const branch = `balance/run-${shortRunId(input.runId)}-result`;
  await runGit(input.repository.root, ["worktree", "add", "-b", branch, target, input.repository.head]);
  return registerWorktree(target);
}

export async function createTaskWorktree(input: {
  repository: RepositorySnapshot;
  runId: string;
  taskId: string;
  stateRoot: string;
}): Promise<WorktreeRegistration> {
  assertRunAndTask(input.runId, input.taskId);
  await assertSnapshotCurrent(input.repository);
  const target = await preparedTarget(input.stateRoot, ["runs", input.runId, "tasks", input.taskId]);
  const branch = `balance/run-${shortRunId(input.runId)}-${input.taskId}`;
  await runGit(input.repository.root, ["worktree", "add", "-b", branch, target, input.repository.head]);
  return registerWorktree(target);
}

export async function commitTaskWorktree(path: string, message: string): Promise<string> {
  if (!message.trim() || message.includes("\0") || message.length > 500) {
    throw new Error("task commit message must be 1-500 characters without NUL");
  }
  const root = (await inspectRepository(path, "analyze")).root;
  await runGit(root, ["add", "-A"]);
  const changed = await runGit(root, ["diff", "--cached", "--quiet", "--exit-code"], [0, 1]);
  if (changed.code === 0) throw new Error("task worktree has no changes to commit");
  await runGit(root, [
    "-c", "user.name=Balance Orchestrator",
    "-c", "user.email=balance@localhost",
    "commit", "-m", message,
  ]);
  const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  if (!SHA.test(head)) throw new Error("task commit did not produce a valid commit SHA");
  return head;
}

export async function cherryPickTask(integrationPath: string, commitSha: string): Promise<void> {
  if (!SHA.test(commitSha)) throw new Error("invalid task commit SHA");
  const root = (await inspectRepository(integrationPath, "execute")).root;
  await runGit(root, [
    "-c", "user.name=Balance Orchestrator",
    "-c", "user.email=balance@localhost",
    "cherry-pick", commitSha,
  ]);
}

export async function abortCherryPick(integrationPath: string): Promise<void> {
  const root = await canonicalPathWithoutSymlinks(integrationPath, "integration worktree");
  const gitDirectory = (await runGit(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  try {
    await lstat(join(gitDirectory, "CHERRY_PICK_HEAD"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await runGit(root, ["cherry-pick", "--abort"]);
}

export async function assertOriginalHeadUnchanged(repository: RepositorySnapshot): Promise<void> {
  const current = await inspectRepository(repository.root, "analyze");
  if (
    current.root !== repository.root ||
    current.device !== repository.device ||
    current.inode !== repository.inode ||
    current.branch !== repository.branch ||
    current.head !== repository.head
  ) {
    throw new Error("original repository HEAD, branch or identity changed during orchestration");
  }
}

export async function removeRegisteredWorktree(input: {
  store: RunStore;
  repositoryRoot: string;
  runId: string;
  slot: { kind: "integration" } | { kind: "task"; taskId: string };
  stateRoot: string;
}): Promise<void> {
  const taskId = input.slot.kind === "task" ? input.slot.taskId : null;
  assertRunAndTask(input.runId, taskId ?? undefined);
  const run = await input.store.get(input.runId);
  if (!run) throw new Error(`run registration not found: ${input.runId}`);
  const registration = input.slot.kind === "integration"
    ? run.integrationWorktree
    : run.tasks.find((task) => task.id === taskId)?.worktree ?? null;
  if (!registration) throw new Error("worktree registration is missing");
  const expectedBranch = input.slot.kind === "integration"
    ? `balance/run-${shortRunId(input.runId)}-result`
    : `balance/run-${shortRunId(input.runId)}-${taskId!}`;
  if (registration.branch !== expectedBranch) {
    throw new Error("registered worktree branch is outside the generated branch namespace");
  }
  const canonicalStateRoot = await canonicalPathWithoutSymlinks(input.stateRoot, "state root");
  const expectedPath = input.slot.kind === "integration"
    ? join(canonicalStateRoot, "runs", input.runId, "integration")
    : join(canonicalStateRoot, "runs", input.runId, "tasks", taskId!);
  const canonicalPath = await canonicalPathWithoutSymlinks(registration.path, "registered worktree");
  if (canonicalPath !== expectedPath) throw new Error("registered worktree path is outside its fixed run slot");
  const metadata = await stat(canonicalPath);
  if (metadata.dev !== registration.device || metadata.ino !== registration.inode) {
    throw new Error("registered worktree identity changed");
  }
  const branch = (await runGit(canonicalPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (branch !== registration.branch) throw new Error("registered worktree branch changed");
  const repositoryRoot = await canonicalPathWithoutSymlinks(input.repositoryRoot, "repository root");
  await assertSafeLocalConfiguration(repositoryRoot);
  await runGit(repositoryRoot, ["worktree", "remove", "--force", canonicalPath]);
  if (input.slot.kind === "task") {
    await runGit(repositoryRoot, ["branch", "-D", registration.branch]);
  }
  await input.store.update(input.runId, (current) => ({
    ...current,
    integrationWorktree: input.slot.kind === "integration" ? null : current.integrationWorktree,
    tasks: input.slot.kind === "task"
      ? current.tasks.map((task) => task.id === taskId ? { ...task, worktree: null } : task)
      : current.tasks,
    updatedAt: Math.max(Date.now(), current.updatedAt + 1),
  }));
}
