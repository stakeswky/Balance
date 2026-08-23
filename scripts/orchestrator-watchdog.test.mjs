import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const watchdog = resolve("src-tauri/resources/sidecar-watchdog.cjs");

async function waitForExit(child, timeoutMs = 5_000) {
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    return await once(child, "exit");
  } finally {
    clearTimeout(timer);
  }
}

async function spawnHookedChild({ hook = "resolved" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "balance-watchdog-"));
  const marker = join(directory, "shutdown.log");
  const hookBody =
    hook === "pending"
      ? "() => new Promise(() => {})"
      : `() => { require("node:fs").appendFileSync(${JSON.stringify(marker)}, "shutdown\\n"); }`;
  const child = spawn(
    process.execPath,
    [
      "--require",
      watchdog,
      "--eval",
      `globalThis[Symbol.for("balance.orchestrator.shutdown")] = ${hookBody}; setInterval(() => {}, 1000);`,
    ],
    {
      env: {
        ...process.env,
        BALANCE_PARENT_PID: String(process.pid),
        BALANCE_WATCHDOG_TEST_TIMEOUT_MS: "100",
        NODE_ENV: "test",
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  await new Promise((resolveReady) => setTimeout(resolveReady, 100));
  return { child, marker };
}

test("shutdown sentinel invokes the orchestrator hook exactly once", async () => {
  const { child, marker } = await spawnHookedChild();
  child.stdin.write("ignored\nBALANCE_SHUTDOWN\nBALANCE_SHUTDOWN\n");
  child.stdin.end();
  const [code, signal] = await waitForExit(child);
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(await readFile(marker, "utf8"), "shutdown\n");
});

test("stdin close invokes the orchestrator shutdown hook", async () => {
  const { child, marker } = await spawnHookedChild();
  child.stdin.end();
  const [code, signal] = await waitForExit(child);
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(await readFile(marker, "utf8"), "shutdown\n");
});

test("SIGTERM invokes the orchestrator shutdown hook", async () => {
  const { child, marker } = await spawnHookedChild();
  child.kill("SIGTERM");
  const [code, signal] = await waitForExit(child);
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(await readFile(marker, "utf8"), "shutdown\n");
});

test("watchdog exits after the bounded timeout when the hook never settles", async () => {
  const { child } = await spawnHookedChild({ hook: "pending" });
  const startedAt = Date.now();
  child.stdin.write("BALANCE_SHUTDOWN\n");
  const [code, signal] = await waitForExit(child);
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.ok(Date.now() - startedAt < 2_000);
});
