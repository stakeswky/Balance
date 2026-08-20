import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
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

test("sidecar watchdog exits when the Tauri stdin pipe closes", async () => {
  const child = spawn(
    process.execPath,
    ["--require", watchdog, "--eval", "setInterval(() => {}, 1000)"],
    {
      env: { ...process.env, SYNQ_PARENT_PID: String(process.pid) },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  child.stdin.end();
  const [code, signal] = await waitForExit(child);
  assert.equal(signal, null);
  assert.equal(code, 0);
});

test("sidecar watchdog fails closed for a mismatched parent pid", async () => {
  const child = spawn(
    process.execPath,
    ["--require", watchdog, "--eval", "setInterval(() => {}, 1000)"],
    {
      env: { ...process.env, SYNQ_PARENT_PID: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  const [code, signal] = await waitForExit(child);
  assert.equal(signal, null);
  assert.equal(code, 70);
});
