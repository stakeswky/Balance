import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  orchestratorStateDir,
} from "./paths.server.ts";
import {
  defaultOrchestratorSettings,
  loadOrchestratorSettings,
  saveOrchestratorSettings,
} from "./settings.server.ts";
import {
  candidateBinaryPaths,
  discoverNativeAgents,
  probeBinary,
  validateBinaryPath,
} from "./runtime.server.ts";
import type { NativeAgentId, OrchestratorSettings } from "./types.ts";

async function temporaryDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `balance-${label}-`));
}

async function executable(path: string, body = "printf 'fake 1.2.3\\n'"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
}

function fileMode(mode: number): number {
  return mode & 0o777;
}

test("resolves platform state directories and explicit overrides", () => {
  assert.equal(
    orchestratorStateDir({ HOME: "/Users/tester" }, "darwin"),
    "/Users/tester/Library/Application Support/Balance/orchestrator",
  );
  assert.equal(
    orchestratorStateDir({ HOME: "/home/tester" }, "linux"),
    "/home/tester/.local/share/Balance/orchestrator",
  );
  assert.equal(
    orchestratorStateDir({ HOME: "/home/tester", XDG_DATA_HOME: "/data" }, "linux"),
    "/data/Balance/orchestrator",
  );
  assert.equal(
    orchestratorStateDir({ BALANCE_STATE_DIR: "/private/state", HOME: "/ignored" }, "darwin"),
    "/private/state",
  );
  assert.throws(() => orchestratorStateDir({}, "darwin"), /HOME/);
  assert.throws(
    () => orchestratorStateDir({ BALANCE_STATE_DIR: "relative", HOME: "/Users/tester" }, "darwin"),
    /absolute/,
  );
});

test("creates private directories and rejects a symlink state root", async () => {
  const root = await temporaryDirectory("private-root");
  const state = join(root, "nested", "state");
  await ensurePrivateDirectory(state);
  assert.equal(fileMode((await lstat(state)).mode), 0o700);

  const target = join(root, "target");
  const link = join(root, "linked-state");
  await mkdir(target);
  await symlink(target, link);
  await assert.rejects(() => ensurePrivateDirectory(link), /symbolic link/i);
});

test("atomically writes private JSON without damaging an old file on serialization failure", async () => {
  const root = await temporaryDirectory("atomic-json");
  const path = join(root, "settings.json");
  await atomicWritePrivateJson(path, { version: 1 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1 });
  assert.equal(fileMode((await lstat(path)).mode), 0o600);
  assert.equal(fileMode((await lstat(root)).mode), 0o700);

  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(() => atomicWritePrivateJson(path, circular));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1 });
});

test("loads strict defaults, reports corrupt JSON and persists settings privately", async () => {
  const root = await temporaryDirectory("settings");
  const loadedDefault = await loadOrchestratorSettings({ root });
  assert.deepEqual(loadedDefault.settings, defaultOrchestratorSettings());
  assert.deepEqual(loadedDefault.diagnostics, []);

  await writeFile(join(root, "settings.json"), "{bad json", { mode: 0o600 });
  const corrupt = await loadOrchestratorSettings({ root });
  assert.deepEqual(corrupt.settings, defaultOrchestratorSettings());
  assert.equal(corrupt.diagnostics.length, 1);
  assert.match(corrupt.diagnostics[0]!, /无法读取/);

  const binary = join(root, "bin", "claude");
  await executable(binary);
  const settings = defaultOrchestratorSettings();
  settings.globalMaxConcurrency = 2;
  settings.agents.claude.binaryPath = binary;
  const saved = await saveOrchestratorSettings(settings, { root });
  assert.equal(saved.agents.claude.binaryPath, binary);
  assert.equal(fileMode((await lstat(join(root, "settings.json"))).mode), 0o600);
  const reloaded = await loadOrchestratorSettings({ root });
  assert.equal(reloaded.settings.globalMaxConcurrency, 2);
  assert.equal(reloaded.settings.agents.claude.binaryPath, binary);
});

test("rejects unknown settings fields and a binary that fails its version probe", async () => {
  const root = await temporaryDirectory("invalid-settings");
  const extra = {
    ...defaultOrchestratorSettings(),
    extra: true,
  } as unknown as OrchestratorSettings;
  await assert.rejects(() => saveOrchestratorSettings(extra, { root }));

  const failing = join(root, "bin", "claude");
  await executable(failing, "exit 9");
  const settings = defaultOrchestratorSettings();
  settings.agents.claude.binaryPath = failing;
  await assert.rejects(() => saveOrchestratorSettings(settings, { root }), /probe|version|退出/i);
  await assert.rejects(() => access(join(root, "settings.json"), constants.F_OK));
});

test("returns the documented candidate order for every native agent", () => {
  const env = {
    HOME: "/Users/tester",
    CODEX_HOME: "/Volumes/codex",
    GROK_HOME: "/Volumes/grok",
  };
  assert.deepEqual(candidateBinaryPaths("claude", env), [
    "/Users/tester/.local/bin/claude",
    "/Users/tester/.claude/local/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]);
  assert.deepEqual(candidateBinaryPaths("codex", env), [
    "/Volumes/codex/bin/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Users/tester/.local/bin/codex",
  ]);
  assert.deepEqual(candidateBinaryPaths("grok", env), [
    "/Volumes/grok/bin/grok",
    "/Users/tester/.grok/bin/grok",
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
  ]);
});

test("validates absolute executable files and canonicalizes symlinks", async () => {
  const root = await temporaryDirectory("binary-validation");
  const target = join(root, "real-cli");
  const link = join(root, "linked-cli");
  await executable(target);
  await symlink(target, link);
  assert.equal(await validateBinaryPath(link), await realpath(target));
  await assert.rejects(() => validateBinaryPath("relative-cli"), /absolute/);
  await assert.rejects(() => validateBinaryPath(root), /regular file/);

  const nonExecutable = join(root, "not-executable");
  await writeFile(nonExecutable, "plain");
  await assert.rejects(() => validateBinaryPath(nonExecutable), /executable/);
  await assert.rejects(() => validateBinaryPath(join(root, "missing-link")), /not found|ENOENT/i);
});

test("probes versions directly, reports nonzero exit and enforces the timeout", async () => {
  const root = await temporaryDirectory("probe");
  const good = join(root, "good cli");
  const bad = join(root, "bad-cli");
  const slow = join(root, "slow-cli");
  await executable(good, "printf 'agent version 9.4\\n'");
  await executable(bad, "printf 'bad version\\n' >&2; exit 7");
  await executable(slow, "sleep 5; printf 'late\\n'");

  assert.deepEqual(await probeBinary("claude", good), {
    agent: "claude",
    ok: true,
    path: good,
    version: "agent version 9.4",
    error: null,
  });
  const failed = await probeBinary("codex", bad);
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /7/);
  const startedAt = Date.now();
  const timedOut = await probeBinary("grok", slow);
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /timed out/i);
  assert.ok(Date.now() - startedAt >= 2_800 && Date.now() - startedAt < 4_500);
});

test("discovers the first working candidate and respects a configured path", async () => {
  const root = await temporaryDirectory("discovery");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const grokHome = join(root, "grok-home");
  const firstClaude = join(home, ".local", "bin", "claude");
  const secondClaude = join(home, ".claude", "local", "claude");
  const codex = join(codexHome, "bin", "codex");
  const grok = join(grokHome, "bin", "grok");
  await executable(firstClaude, "exit 4");
  await executable(secondClaude, "printf 'claude second\\n'");
  await executable(codex, "printf 'codex first\\n'");
  await executable(grok, "printf 'grok first\\n'");

  const settings = defaultOrchestratorSettings();
  const inventory = await discoverNativeAgents(settings, undefined, {
    HOME: home,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
  });
  assert.equal(inventory.claude.path, secondClaude);
  assert.equal(inventory.codex.path, codex);
  assert.equal(inventory.grok.path, grok);

  const configured = join(root, "configured-grok");
  await executable(configured, "printf 'configured grok\\n'");
  settings.agents.grok.binaryPath = configured;
  const withConfigured = await discoverNativeAgents(settings, undefined, {
    HOME: home,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
  });
  assert.equal(withConfigured.grok.path, configured);
  assert.equal(withConfigured.grok.version, "configured grok");
});

test("keeps the runtime inventory closed to the three supported agents", async () => {
  const root = await temporaryDirectory("inventory-shape");
  const settings = defaultOrchestratorSettings();
  const inventory = await discoverNativeAgents(settings, undefined, { HOME: root });
  assert.deepEqual(Object.keys(inventory).sort(), ["claude", "codex", "grok"]);
  for (const agent of Object.keys(inventory) as NativeAgentId[]) {
    assert.equal(inventory[agent].agent, agent);
  }
});
