import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const fixture = resolve("scripts/fixtures/fake-agent-cli.mjs");
const prompt = [
  "Task alpha: Create alpha fixture",
  "Create the alpha fixture file.",
  "Expected files: balance-alpha.txt",
  "Acceptance criteria:\n- balance-alpha.txt exists",
  'Verification commands:\n- ["test","-f","balance-alpha.txt"]',
  "Implement only this task in the current worktree. Do not commit changes.",
].join("\n\n");

async function run(args, options = {}) {
  return execute(fixture, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    maxBuffer: 2 * 1024 * 1024,
  });
}

test("fake native CLI exposes a stable version and empty Grok isolation report", async () => {
  assert.equal((await run(["--version"])).stdout.trim(), "balance-fake-agent 1.0.0");
  assert.deepEqual(JSON.parse((await run(["inspect", "--json"])).stdout), {
    hooks: [],
    plugins: [],
    mcpServers: [],
    configSources: { layers: [] },
  });
});

test("fake native CLI emits the same two-task plan in each vendor protocol", async () => {
  const claude = (
    await run([
      "-p",
      "plan",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--json-schema",
      "{}",
    ])
  ).stdout
    .trim()
    .split("\n")
    .map(JSON.parse);
  const codex = (
    await run([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--output-schema",
      "/tmp/schema",
      "plan",
    ])
  ).stdout
    .trim()
    .split("\n")
    .map(JSON.parse);
  const grok = (
    await run([
      "-p",
      "plan",
      "--output-format",
      "json",
      "--no-auto-update",
      "--sandbox",
      "read-only",
    ])
  ).stdout
    .trim()
    .split("\n")
    .map(JSON.parse);
  const plans = [
    claude.at(-1)?.structured_output,
    JSON.parse(codex.at(-1)?.item?.text),
    grok.at(-1),
  ];
  assert.deepEqual(plans[0], plans[1]);
  assert.deepEqual(plans[1], plans[2]);
  assert.deepEqual(
    plans[0].tasks.map((task) => task.id),
    ["alpha", "beta"],
  );
});

test("fake execution writes only declared files and emits session, message and usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "balance-fake-execute-"));
  const result = await run(["exec", "--json", "--sandbox", "workspace-write", prompt], { cwd });
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(await readFile(join(cwd, "balance-alpha.txt"), "utf8"), "Balance fake task alpha\n");
  assert.deepEqual(
    events.map((event) => event.type),
    ["thread.started", "item.completed", "turn.completed"],
  );
});

test("fake execution fault modes cover nonzero, broken JSON, long lines and conflicts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "balance-fake-fault-"));
  await assert.rejects(
    () =>
      run(["exec", "--json", "--sandbox", "workspace-write", prompt], {
        cwd,
        env: { BALANCE_FAKE_AGENT_MODE: "nonzero" },
      }),
    (error) => error.code === 23,
  );
  const broken = await run(["exec", "--json", "--sandbox", "workspace-write", prompt], {
    cwd,
    env: { BALANCE_FAKE_AGENT_MODE: "broken-json" },
  });
  assert.equal(broken.stdout.trim(), "{broken-json");
  const long = await run(["exec", "--json", "--sandbox", "workspace-write", prompt], {
    cwd,
    env: { BALANCE_FAKE_AGENT_MODE: "long-line" },
  });
  assert.ok(Buffer.byteLength(long.stdout) > 1024 * 1024);
  await run(["exec", "--json", "--sandbox", "workspace-write", prompt], {
    cwd,
    env: { BALANCE_FAKE_AGENT_MODE: "conflict" },
  });
  assert.equal(await readFile(join(cwd, "balance-shared.txt"), "utf8"), "alpha\n");
});
