import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import {
  normalizeAgentLine,
  redactAgentOutput,
  type AgentCommand,
} from "./adapters.ts";
import type {
  NativeAgentId,
  OrchestratorEvent,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1_000;
const MAX_TIMEOUT_MS = 120 * 60 * 1_000;
const CANCEL_GRACE_MS = 5_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RAW_LOG_BYTES = 20 * 1024 * 1024;

export interface ProcessRunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdoutLines: string[];
  stderrLines: string[];
}

export interface RunningProcess {
  pid: number;
  completion: Promise<ProcessRunResult>;
  cancel(): Promise<void>;
}

export interface ProcessRuntime {
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  descendantPids(pid: number): Promise<number[]>;
  killPid(pid: number, signal: NodeJS.Signals): void;
  setTimer(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
}

function psDescendants(rootPid: number): Promise<number[]> {
  return new Promise((resolveDescendants, rejectDescendants) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid="], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        rejectDescendants(error);
        return;
      }
      const children = new Map<number, number[]>();
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        const siblings = children.get(parentPid) ?? [];
        siblings.push(pid);
        children.set(parentPid, siblings);
      }
      const descendants: number[] = [];
      const queue = [...(children.get(rootPid) ?? [])];
      while (queue.length > 0) {
        const pid = queue.shift()!;
        descendants.push(pid);
        queue.push(...(children.get(pid) ?? []));
      }
      resolveDescendants(descendants.reverse());
    });
  });
}

const defaultRuntime: ProcessRuntime = {
  spawn(command, args, options) {
    return spawn(command, args, options);
  },
  killGroup(pid, signal) {
    if (process.platform === "win32") throw new Error("process groups are unavailable on Windows");
    process.kill(-pid, signal);
  },
  descendantPids(pid) {
    return psDescendants(pid);
  },
  killPid(pid, signal) {
    process.kill(pid, signal);
  },
  setTimer(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
};

interface LineReader {
  stream: "stdout" | "stderr";
  source: Readable;
  buffer: Buffer;
  onData(chunk: Buffer | string): void;
  onEnd(): void;
}

export function startAgentProcess(input: {
  command: AgentCommand;
  agent: NativeAgentId;
  signal: AbortSignal;
  timeoutMs?: number;
  secrets?: readonly string[];
  onEvent(event: OrchestratorEvent): Promise<void> | void;
  runtime?: ProcessRuntime;
}): RunningProcess {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("native agent timeout must be between 1ms and 120 minutes");
  }
  const runtime = input.runtime ?? defaultRuntime;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let rawBytes = 0;
  let rawTruncated = false;
  let outputFailure: Error | null = null;
  let eventFailure: Error | null = null;
  let eventQueue = Promise.resolve();
  let child: ChildProcessWithoutNullStreams;
  let exited = false;
  let settled = false;
  let cancelRequested = false;
  let timedOut = false;
  let cancellation: Promise<void> | null = null;
  let mainTimer: NodeJS.Timeout | null = null;
  const exitWaiters = new Set<() => void>();

  let resolveCompletion!: (result: ProcessRunResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<ProcessRunResult>((resolveResult, rejectResult) => {
    resolveCompletion = resolveResult;
    rejectCompletion = rejectResult;
  });

  const redactedError = (error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(redactAgentOutput(message, input.secrets ?? []));
  };

  const emitEvent = (event: OrchestratorEvent): void => {
    eventQueue = eventQueue
      .then(() => input.onEvent(event))
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!eventFailure) eventFailure = redactedError(error);
        if (!exited) void cancelInternal();
      });
  };

  const notifyExitWaiters = (): void => {
    for (const waiter of [...exitWaiters]) waiter();
    exitWaiters.clear();
  };

  const waitForExitOrDelay = (milliseconds: number): Promise<void> => {
    if (exited) return Promise.resolve();
    return new Promise((resolveDelay) => {
      const finish = (): void => {
        runtime.clearTimer(timer);
        exitWaiters.delete(finish);
        resolveDelay();
      };
      const timer = runtime.setTimer(finish, milliseconds);
      exitWaiters.add(finish);
      if (exited) finish();
    });
  };

  const signalTree = async (signal: NodeJS.Signals): Promise<void> => {
    if (exited || !child.pid) return;
    const rootPid = child.pid;
    try {
      runtime.killGroup(rootPid, signal);
      return;
    } catch {
      // A process group may be unavailable; fall back to the registered live tree.
    }
    let descendants: number[];
    try {
      descendants = await runtime.descendantPids(rootPid);
    } catch {
      descendants = [];
    }
    for (const descendant of descendants) {
      if (exited) return;
      try {
        const liveDescendants = await runtime.descendantPids(rootPid);
        if (!liveDescendants.includes(descendant)) continue;
        runtime.killPid(descendant, signal);
      } catch {
        // The descendant may have exited between discovery and signaling.
      }
    }
    if (exited) return;
    try {
      runtime.killPid(rootPid, signal);
    } catch {
      // The leader may already have exited.
    }
  };

  const cancelStages = async (): Promise<void> => {
    if (exited) return;
    cancelRequested = true;
    await signalTree("SIGINT");
    if (exited) return;
    await waitForExitOrDelay(CANCEL_GRACE_MS);
    if (exited) return;
    await signalTree("SIGTERM");
    if (exited) return;
    await waitForExitOrDelay(CANCEL_GRACE_MS);
    if (exited) return;
    await signalTree("SIGKILL");
    await completion.catch(() => undefined);
  };

  function cancelInternal(): Promise<void> {
    if (exited) return Promise.resolve();
    cancellation ??= cancelStages();
    return cancellation;
  }

  const retainRawLine = (stream: "stdout" | "stderr", line: string): void => {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (rawBytes + lineBytes <= MAX_RAW_LOG_BYTES) {
      (stream === "stdout" ? stdoutLines : stderrLines).push(line);
      rawBytes += lineBytes;
      return;
    }
    if (!rawTruncated) {
      rawTruncated = true;
      emitEvent({
        type: "diagnostic",
        stream,
        message: "Native agent raw log was truncated after 20 MiB; output is still being drained.",
      });
    }
  };

  const processLine = (stream: "stdout" | "stderr", bytes: Buffer): void => {
    if (outputFailure) return;
    if (bytes.byteLength > MAX_LINE_BYTES) {
      outputFailure = new Error("Native agent output exceeded the 1 MiB logical line limit");
      emitEvent({ type: "process_failed", category: "output_limit", message: outputFailure.message });
      void cancelInternal();
      return;
    }
    const normalizedBytes = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    const safeLine = redactAgentOutput(normalizedBytes.toString("utf8"), input.secrets ?? []);
    retainRawLine(stream, safeLine);
    for (const event of normalizeAgentLine(input.agent, stream, safeLine)) emitEvent(event);
  };

  const makeLineReader = (stream: "stdout" | "stderr", source: Readable): LineReader => {
    const reader: LineReader = {
      stream,
      source,
      buffer: Buffer.alloc(0),
      onData(chunk) {
        if (outputFailure) return;
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        reader.buffer = reader.buffer.length === 0 ? next : Buffer.concat([reader.buffer, next]);
        let newline = reader.buffer.indexOf(0x0a);
        while (newline >= 0) {
          processLine(stream, reader.buffer.subarray(0, newline));
          reader.buffer = reader.buffer.subarray(newline + 1);
          if (outputFailure) {
            reader.buffer = Buffer.alloc(0);
            return;
          }
          newline = reader.buffer.indexOf(0x0a);
        }
        if (reader.buffer.byteLength > MAX_LINE_BYTES) {
          processLine(stream, reader.buffer);
          reader.buffer = Buffer.alloc(0);
        }
      },
      onEnd() {
        if (reader.buffer.length > 0) processLine(stream, reader.buffer);
        reader.buffer = Buffer.alloc(0);
      },
    };
    return reader;
  };

  try {
    child = runtime.spawn(input.command.command, input.command.args, {
      cwd: input.command.cwd,
      env: input.command.env,
      detached: true,
      shell: false,
    });
  } catch (error) {
    const spawnError = redactedError(error);
    emitEvent({ type: "process_failed", category: "spawn", message: spawnError.message });
    exited = true;
    settled = true;
    void eventQueue.then(() => rejectCompletion(spawnError));
    return { pid: -1, completion, cancel: () => Promise.resolve() };
  }

  const stdoutReader = makeLineReader("stdout", child.stdout);
  const stderrReader = makeLineReader("stderr", child.stderr);

  const removeListeners = (): void => {
    input.signal.removeEventListener("abort", onAbort);
    child.removeListener("error", onChildError);
    child.removeListener("close", onChildClose);
    stdoutReader.source.removeListener("data", stdoutReader.onData);
    stdoutReader.source.removeListener("end", stdoutReader.onEnd);
    stderrReader.source.removeListener("data", stderrReader.onData);
    stderrReader.source.removeListener("end", stderrReader.onEnd);
  };

  const finishCompletion = (
    result: ProcessRunResult | null,
    error: Error | null,
  ): void => {
    if (settled) return;
    settled = true;
    void eventQueue.then(() => {
      const finalError = error ?? eventFailure;
      if (finalError) rejectCompletion(finalError);
      else resolveCompletion(result!);
    });
  };

  const settleProcess = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error: Error | null,
  ): void => {
    if (exited) return;
    exited = true;
    if (mainTimer) {
      runtime.clearTimer(mainTimer);
      mainTimer = null;
    }
    stdoutReader.onEnd();
    stderrReader.onEnd();
    removeListeners();
    notifyExitWaiters();
    const exitCode = code ?? -1;
    if (error) {
      emitEvent({ type: "process_failed", category: "spawn", message: error.message });
      finishCompletion(null, error);
      return;
    }
    if (outputFailure) {
      finishCompletion(null, outputFailure);
      return;
    }
    if (timedOut) {
      emitEvent({ type: "process_failed", category: "timeout", message: `Native agent timed out after ${timeoutMs}ms` });
    } else if (cancelRequested || input.signal.aborted) {
      emitEvent({ type: "process_failed", category: "cancelled", message: "Native agent process was cancelled" });
    } else if (exitCode !== 0) {
      emitEvent({ type: "process_failed", category: "exit", message: `Native agent exited with code ${exitCode}` });
    } else {
      emitEvent({ type: "process_completed", exitCode });
    }
    finishCompletion({ exitCode, signal, stdoutLines, stderrLines }, null);
  };

  const onChildError = (error: Error): void => {
    settleProcess(null, null, redactedError(error));
  };
  const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    settleProcess(code, signal, null);
  };
  const onAbort = (): void => {
    void cancelInternal();
  };

  child.stdout.on("data", stdoutReader.onData);
  child.stdout.on("end", stdoutReader.onEnd);
  child.stderr.on("data", stderrReader.onData);
  child.stderr.on("end", stderrReader.onEnd);
  child.once("error", onChildError);
  child.once("close", onChildClose);
  input.signal.addEventListener("abort", onAbort, { once: true });
  emitEvent({ type: "process_started", pid: child.pid ?? -1 });
  mainTimer = runtime.setTimer(() => {
    timedOut = true;
    void cancelInternal();
  }, timeoutMs);
  if (input.signal.aborted) void cancelInternal();

  return {
    pid: child.pid ?? -1,
    completion,
    cancel: cancelInternal,
  };
}
