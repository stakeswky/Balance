"use strict";

const parentPid = Number.parseInt(
  process.env.BALANCE_PARENT_PID ?? process.env.SYNQ_PARENT_PID ?? "",
  10,
);
if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || process.ppid !== parentPid) {
  process.stderr.write("[balance-watchdog] invalid or mismatched BALANCE_PARENT_PID\n");
  process.exit(70);
}

const SHUTDOWN_SENTINEL = "BALANCE_SHUTDOWN";
const SHUTDOWN_TIMEOUT_MS = 15_000;
const testTimeout =
  process.env.NODE_ENV === "test"
    ? Number.parseInt(process.env.BALANCE_WATCHDOG_TEST_TIMEOUT_MS ?? "", 10)
    : Number.NaN;
const shutdownTimeoutMs =
  Number.isSafeInteger(testTimeout) && testTimeout > 0 && testTimeout <= SHUTDOWN_TIMEOUT_MS
    ? testTimeout
    : SHUTDOWN_TIMEOUT_MS;

let shutdownPromise;
let parentWatchdog;
const shutdown = () => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (parentWatchdog) clearInterval(parentWatchdog);
    const hook = globalThis[Symbol.for("balance.orchestrator.shutdown")];
    const boundedHook =
      typeof hook === "function" ? Promise.resolve().then(() => hook()) : Promise.resolve();
    await Promise.race([
      boundedHook.catch((error) => {
        process.stderr.write(`[balance-watchdog] shutdown hook failed: ${String(error)}\n`);
      }),
      new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
    ]);
    process.exit(0);
  })();
  return shutdownPromise;
};

// tauri-plugin-shell gives the child a dedicated stdin pipe. The kernel closes
// it even when the Tauri parent is killed and cannot run an exit callback.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split(/\r?\n/);
  input = lines.pop() ?? "";
  if (lines.some((line) => line === SHUTDOWN_SENTINEL)) shutdown();
});
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
process.stdin.once("error", shutdown);
process.stdin.resume();

process.once("SIGTERM", shutdown);

parentWatchdog = setInterval(() => {
  if (process.ppid !== parentPid) {
    shutdown();
    return;
  }
  try {
    process.kill(parentPid, 0);
  } catch {
    shutdown();
  }
}, 250);
parentWatchdog.unref();
