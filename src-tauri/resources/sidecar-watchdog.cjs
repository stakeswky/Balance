"use strict";

const parentPid = Number.parseInt(
  process.env.BALANCE_PARENT_PID ?? process.env.SYNQ_PARENT_PID ?? "",
  10,
);
if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || process.ppid !== parentPid) {
  process.stderr.write("[balance-watchdog] invalid or mismatched BALANCE_PARENT_PID\n");
  process.exit(70);
}

let exiting = false;
const exitWithParent = () => {
  if (exiting) return;
  exiting = true;
  process.exit(0);
};

// tauri-plugin-shell gives the child a dedicated stdin pipe. The kernel closes
// it even when the Tauri parent is killed and cannot run an exit callback.
process.stdin.once("end", exitWithParent);
process.stdin.once("close", exitWithParent);
process.stdin.once("error", exitWithParent);
process.stdin.resume();

const parentWatchdog = setInterval(() => {
  if (process.ppid !== parentPid) {
    exitWithParent();
    return;
  }
  try {
    process.kill(parentPid, 0);
  } catch {
    exitWithParent();
  }
}, 250);
parentWatchdog.unref();
