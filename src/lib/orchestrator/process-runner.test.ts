import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import {
  startAgentProcess,
  type ProcessRuntime,
} from "./process-runner.server.ts";
import type { AgentCommand } from "./adapters.ts";
import type { OrchestratorEvent } from "./types.ts";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr, null, null] as const;
  pid: number | undefined = 4_242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

interface FakeTimer {
  callback: () => void;
  milliseconds: number;
  cleared: boolean;
}

class FakeRuntime implements ProcessRuntime {
  readonly child = new FakeChild();
  readonly spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: SpawnOptionsWithoutStdio;
  }> = [];
  readonly signals: Array<{ target: "group" | "pid"; pid: number; signal: NodeJS.Signals }> = [];
  readonly timers: FakeTimer[] = [];
  descendants: number[] = [4_243, 4_244];
  failGroup = false;
  closeOnSignal: NodeJS.Signals | null = null;

  spawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
    this.spawnCalls.push({ command, args, options });
    return this.child as unknown as ChildProcessWithoutNullStreams;
  }

  killGroup(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ target: "group", pid, signal });
    if (this.failGroup) throw new Error("no process group");
    if (this.closeOnSignal === signal) this.child.close(null, signal);
  }

  async descendantPids(): Promise<number[]> {
    return [...this.descendants];
  }

  killPid(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ target: "pid", pid, signal });
    if (pid === this.child.pid && this.closeOnSignal === signal) this.child.close(null, signal);
  }

  setTimer(callback: () => void, milliseconds: number): NodeJS.Timeout {
    const timer: FakeTimer = { callback, milliseconds, cleared: false };
    this.timers.push(timer);
    return timer as unknown as NodeJS.Timeout;
  }

  clearTimer(timer: NodeJS.Timeout): void {
    (timer as unknown as FakeTimer).cleared = true;
  }

  fireTimer(milliseconds: number): void {
    const timer = this.timers.find((candidate) => !candidate.cleared && candidate.milliseconds === milliseconds);
    assert.ok(timer, `missing active ${milliseconds}ms timer`);
    timer.cleared = true;
    timer.callback();
  }
}

const command: AgentCommand = {
  command: "/native/codex",
  args: ["exec", "--json", "task"],
  cwd: "/repo/task",
  env: { HOME: "/private/run/home", NO_COLOR: "1" },
};

function start(runtime: FakeRuntime, options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  events?: OrchestratorEvent[];
  secrets?: readonly string[];
} = {}) {
  const controller = new AbortController();
  const events = options.events ?? [];
  const running = startAgentProcess({
    command,
    agent: "codex",
    signal: options.signal ?? controller.signal,
    timeoutMs: options.timeoutMs,
    secrets: options.secrets,
    onEvent(event) {
      events.push(event);
    },
    runtime,
  });
  return { running, controller, events };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("spawns directly in a detached process group and drains both streams", async () => {
  const runtime = new FakeRuntime();
  const { running, events } = start(runtime);
  assert.equal(running.pid, 4_242);
  assert.equal(runtime.spawnCalls.length, 1);
  assert.equal(runtime.spawnCalls[0]!.command, "/native/codex");
  assert.deepEqual(runtime.spawnCalls[0]!.args, ["exec", "--json", "task"]);
  assert.deepEqual(runtime.spawnCalls[0]!.options, {
    cwd: "/repo/task",
    env: command.env,
    detached: true,
    shell: false,
  });

  runtime.child.stdout.write('{"type":"thread.started","thread_id":"t-1"}\n');
  runtime.child.stderr.write("visible warning\n");
  runtime.child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
  runtime.child.close(0);
  const result = await running.completion;
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdoutLines, [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  ]);
  assert.deepEqual(result.stderrLines, ["visible warning"]);
  assert.deepEqual(events, [
    { type: "process_started", pid: 4_242 },
    { type: "session_started", sessionId: "t-1" },
    { type: "diagnostic", stream: "stderr", message: "visible warning" },
    { type: "message", text: "done" },
    { type: "process_completed", exitCode: 0 },
  ]);
});

test("redacts lines before raw retention, normalization and failure events", async () => {
  const runtime = new FakeRuntime();
  const events: OrchestratorEvent[] = [];
  const { running } = start(runtime, { events, secrets: ["private-value", "/private/run/home"] });
  runtime.child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"private-value token: api-secret /private/run/home"}}\n');
  runtime.child.stderr.write("Authorization: Bearer bearer-secret\n");
  runtime.child.close(7);
  const result = await running.completion;
  const serialized = JSON.stringify({ result, events });
  for (const secret of ["private-value", "api-secret", "/private/run/home", "bearer-secret"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(result.exitCode, 7);
  assert.equal(events.at(-1)?.type, "process_failed");
});

test("fails and terminates the process when one logical line exceeds 1 MiB", async () => {
  const runtime = new FakeRuntime();
  runtime.closeOnSignal = "SIGKILL";
  const { running, events } = start(runtime);
  runtime.child.stdout.write("x".repeat(1024 * 1024 + 1));
  await flushAsync();
  runtime.fireTimer(5_000);
  await flushAsync();
  runtime.fireTimer(5_000);
  await assert.rejects(running.completion, /1 MiB|line limit/i);
  assert.equal(events.some((event) => event.type === "process_failed"), true);
  assert.deepEqual(runtime.signals.filter((entry) => entry.target === "group").map((entry) => entry.signal), [
    "SIGINT", "SIGTERM", "SIGKILL",
  ]);
});

test("retains at most 20 MiB of raw logs while draining and diagnoses truncation once", async () => {
  const runtime = new FakeRuntime();
  const { running, events } = start(runtime);
  const line = `${"x".repeat(1024 * 1024 - 1)}\n`;
  for (let index = 0; index < 22; index += 1) runtime.child.stdout.write(line);
  runtime.child.close(0);
  const result = await running.completion;
  const retainedBytes = result.stdoutLines.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
  assert.ok(retainedBytes <= 20 * 1024 * 1024);
  const truncationEvents = events.filter(
    (event) => event.type === "diagnostic" && /20 MiB|truncat/i.test(event.message),
  );
  assert.equal(truncationEvents.length, 1);
  assert.equal(result.exitCode, 0);
});

test("reports spawn errors once and removes stream and process listeners", async () => {
  const runtime = new FakeRuntime();
  const { running, events } = start(runtime);
  runtime.child.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(running.completion, /ENOENT/);
  assert.equal(events.filter((event) => event.type === "process_failed").length, 1);
  assert.equal(runtime.child.listenerCount("error"), 0);
  assert.equal(runtime.child.listenerCount("close"), 0);
  assert.equal(runtime.child.stdout.listenerCount("data"), 0);
  assert.equal(runtime.child.stderr.listenerCount("data"), 0);
});

test("uses a 45 minute default timeout and rejects values beyond 120 minutes", () => {
  const runtime = new FakeRuntime();
  const { running } = start(runtime);
  assert.equal(runtime.timers.some((timer) => timer.milliseconds === 45 * 60 * 1_000), true);
  runtime.child.close(0);
  void running.completion;

  const tooLongRuntime = new FakeRuntime();
  assert.throws(
    () => start(tooLongRuntime, { timeoutMs: 120 * 60 * 1_000 + 1 }),
    /120|timeout/i,
  );
  assert.equal(tooLongRuntime.spawnCalls.length, 0);
});

test("external abort escalates SIGINT, SIGTERM and SIGKILL at five-second intervals", async () => {
  const runtime = new FakeRuntime();
  runtime.closeOnSignal = "SIGKILL";
  const controller = new AbortController();
  const { running } = start(runtime, { signal: controller.signal });
  controller.abort();
  await flushAsync();
  assert.deepEqual(runtime.signals.map((entry) => entry.signal), ["SIGINT"]);
  runtime.fireTimer(5_000);
  await flushAsync();
  assert.deepEqual(runtime.signals.map((entry) => entry.signal), ["SIGINT", "SIGTERM"]);
  runtime.fireTimer(5_000);
  await running.cancel();
  await running.completion;
  assert.deepEqual(runtime.signals.map((entry) => entry.signal), ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(runtime.timers.filter((timer) => !timer.cleared).length, 0);
});

test("falls back to live registered descendants when process-group signaling fails", async () => {
  const runtime = new FakeRuntime();
  runtime.failGroup = true;
  runtime.closeOnSignal = "SIGINT";
  const { running } = start(runtime);
  await running.cancel();
  await running.completion;
  assert.deepEqual(runtime.signals, [
    { target: "group", pid: 4_242, signal: "SIGINT" },
    { target: "pid", pid: 4_243, signal: "SIGINT" },
    { target: "pid", pid: 4_244, signal: "SIGINT" },
    { target: "pid", pid: 4_242, signal: "SIGINT" },
  ]);
});

test("cancel is idempotent after exit and completion settles only once", async () => {
  const runtime = new FakeRuntime();
  const { running, events } = start(runtime);
  runtime.child.close(0);
  const first = await running.completion;
  runtime.child.emit("close", 9, null);
  const second = await running.completion;
  await running.cancel();
  await running.cancel();
  assert.deepEqual(second, first);
  assert.deepEqual(runtime.signals, []);
  assert.equal(events.filter((event) => event.type === "process_completed").length, 1);
});

test("timeout follows the same cancellation path", async () => {
  const runtime = new FakeRuntime();
  runtime.closeOnSignal = "SIGKILL";
  const { running, events } = start(runtime, { timeoutMs: 2_000 });
  runtime.fireTimer(2_000);
  await flushAsync();
  runtime.fireTimer(5_000);
  await flushAsync();
  runtime.fireTimer(5_000);
  await running.completion;
  assert.deepEqual(runtime.signals.map((entry) => entry.signal), ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(events.some((event) => event.type === "process_failed" && event.category === "timeout"), true);
});
