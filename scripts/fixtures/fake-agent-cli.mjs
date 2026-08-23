#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

const args = process.argv.slice(2);

function argumentAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function agentKind() {
  if (args[0] === "exec") return "codex";
  if (args.includes("--no-auto-update")) return "grok";
  return "claude";
}

async function fixtureMode() {
  if (process.env.BALANCE_FAKE_AGENT_MODE) return process.env.BALANCE_FAKE_AGENT_MODE;
  try {
    return (await readFile(resolve(process.cwd(), ".balance-fake-mode"), "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return "success";
    throw error;
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const plan = {
  title: "Fake CLI E2E",
  summary: "Create two files in isolated native Agent worktrees.",
  tasks: [
    {
      id: "alpha",
      title: "Create alpha fixture",
      description: "Create the alpha fixture file with deterministic content.",
      size: "small",
      preferredAgent: "codex",
      dependsOn: [],
      expectedFiles: ["balance-alpha.txt"],
      acceptanceCriteria: ["balance-alpha.txt exists with the expected content"],
      verificationCommands: [{ executable: "test", args: ["-f", "balance-alpha.txt"] }],
    },
    {
      id: "beta",
      title: "Create beta fixture",
      description: "Create the beta fixture file with deterministic content.",
      size: "small",
      preferredAgent: "grok",
      dependsOn: [],
      expectedFiles: ["balance-beta.txt"],
      acceptanceCriteria: ["balance-beta.txt exists with the expected content"],
      verificationCommands: [{ executable: "test", args: ["-f", "balance-beta.txt"] }],
    },
  ],
};

function planningRequest() {
  return (
    argumentAfter("--sandbox") === "read-only" ||
    argumentAfter("--permission-mode") === "plan" ||
    args.includes("--output-schema") ||
    args.includes("--json-schema")
  );
}

function promptText() {
  if (args[0] === "exec") return args.at(-1) ?? "";
  return argumentAfter("-p") ?? argumentAfter("--print") ?? "";
}

function declaredFiles(prompt) {
  const match = /^Expected files:\s*(.+)$/m.exec(prompt);
  if (!match || match[1] === "none declared") return [];
  const root = resolve(process.cwd());
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((relative) => {
      if (
        isAbsolute(relative) ||
        relative.includes("\0") ||
        relative.split(/[\\/]/).includes("..")
      ) {
        throw new Error(`unsafe expected file: ${relative}`);
      }
      const target = resolve(root, relative);
      if (!target.startsWith(`${root}${sep}`))
        throw new Error(`expected file escaped cwd: ${relative}`);
      return { relative, target };
    });
}

async function writeDeclaredFiles(prompt, mode) {
  const taskId = /^Task ([a-z][a-z0-9-]*):/m.exec(prompt)?.[1] ?? "unknown";
  for (const file of declaredFiles(prompt)) {
    await mkdir(dirname(file.target), { recursive: true });
    await writeFile(file.target, `Balance fake task ${taskId}\n`, "utf8");
  }
  if (mode === "conflict") {
    await writeFile(resolve(process.cwd(), "balance-shared.txt"), `${taskId}\n`, "utf8");
  }
  return taskId;
}

function emitPlanning(agent) {
  if (agent === "claude") {
    emit({ type: "result", session_id: "fake-plan-claude", structured_output: plan });
  } else if (agent === "codex") {
    emit({ type: "thread.started", thread_id: "fake-plan-codex" });
    emit({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(plan) },
    });
  } else {
    emit(plan);
  }
}

function emitExecution(agent, taskId) {
  const completionText = `completed ${taskId} in worktree ${process.cwd()}`;
  if (agent === "claude") {
    emit({ type: "system", subtype: "init", session_id: `fake-${taskId}` });
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: completionText }] },
    });
    emit({
      type: "result",
      session_id: `fake-${taskId}`,
      result: completionText,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 1 },
    });
  } else if (agent === "codex") {
    emit({ type: "thread.started", thread_id: `fake-${taskId}` });
    emit({ type: "item.completed", item: { type: "agent_message", text: completionText } });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 1 },
    });
  } else {
    emit({ type: "session.started", session_id: `fake-${taskId}` });
    emit({ type: "assistant", content: completionText });
    emit({
      type: "result",
      session_id: `fake-${taskId}`,
      output: completionText,
      usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 1 },
    });
  }
}

if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write("balance-fake-agent 1.0.0\n");
} else if (args[0] === "inspect" && args.includes("--json")) {
  emit({ hooks: [], plugins: [], mcpServers: [], configSources: { layers: [] } });
} else {
  const mode = await fixtureMode();
  const agent = agentKind();
  if (planningRequest()) {
    if (mode === "broken-plan") process.stdout.write("{broken-plan\n");
    else emitPlanning(agent);
  } else if (mode === "nonzero") {
    emitExecution(agent, "failed");
    process.exitCode = 23;
  } else if (mode === "broken-json") {
    process.stdout.write("{broken-json\n");
  } else if (mode === "long-line") {
    process.stdout.write(`${"x".repeat(1024 * 1024 + 32)}\n`);
  } else if (mode === "hang" || mode === "child-process") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    emitExecution(agent, "hanging");
    emit({ type: "message", text: `fake descendant PID ${descendant.pid}` });
    setInterval(() => {}, 1_000);
  } else {
    const taskId = await writeDeclaredFiles(promptText(), mode);
    emitExecution(agent, taskId);
  }
}
