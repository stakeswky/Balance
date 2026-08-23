import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ensurePrivateDirectory } from "./paths.server.ts";
import { validateBinaryPath } from "./runtime.server.ts";
import type { AssignedTask, NativeAgentId, OrchestratorEvent } from "./types.ts";

const INSPECT_TIMEOUT_MS = 3_000;
const INSPECT_OUTPUT_LIMIT = 1024 * 1024;

export interface AgentCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentSessionEnvironment {
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
  cleanup(): Promise<void>;
}

function requiredAbsolutePath(value: string | undefined, label: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path without NUL`);
  }
  return resolve(value);
}

async function canonicalIfPresent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw error;
  }
}

async function linkAuthentication(source: string, destination: string): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await realpath(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile())
    throw new Error(`native authentication path is not a regular file: ${source}`);
  const effectiveUid = process.geteuid?.();
  if (effectiveUid !== undefined && metadata.uid !== effectiveUid) {
    throw new Error(`native authentication file is not owned by the current user: ${source}`);
  }
  await symlink(canonical, destination);
  return canonical;
}

export async function prepareAgentSessionEnvironment(input: {
  agent: NativeAgentId;
  runRoot: string;
  sourceEnv?: NodeJS.ProcessEnv;
}): Promise<AgentSessionEnvironment> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const runRoot = requiredAbsolutePath(input.runRoot, "runRoot");
  const sourceHome = await realpath(requiredAbsolutePath(sourceEnv.HOME, "HOME"));
  const sourceConfigHomes = {
    claude: await canonicalIfPresent(join(sourceHome, ".claude")),
    codex: await canonicalIfPresent(
      sourceEnv.CODEX_HOME
        ? requiredAbsolutePath(sourceEnv.CODEX_HOME, "CODEX_HOME")
        : join(sourceHome, ".codex"),
    ),
    grok: await canonicalIfPresent(
      sourceEnv.GROK_HOME
        ? requiredAbsolutePath(sourceEnv.GROK_HOME, "GROK_HOME")
        : join(sourceHome, ".grok"),
    ),
  } satisfies Record<NativeAgentId, string>;

  await ensurePrivateDirectory(runRoot);
  const canonicalRunRoot = await realpath(runRoot);
  const agentHomeRoot = join(canonicalRunRoot, "agent-home");
  await ensurePrivateDirectory(agentHomeRoot);
  const sessionHome = join(agentHomeRoot, input.agent);
  await mkdir(sessionHome, { mode: 0o700 });
  const temporaryDirectory = join(sessionHome, "tmp");
  await mkdir(temporaryDirectory, { mode: 0o700 });

  const configNames = {
    claude: ".claude",
    codex: ".codex",
    grok: ".grok",
  } satisfies Record<NativeAgentId, string>;
  const authNames = {
    claude: ".credentials.json",
    codex: "auth.json",
    grok: "auth.json",
  } satisfies Record<NativeAgentId, string>;
  const configHome = join(sessionHome, configNames[input.agent]);
  await mkdir(configHome, { mode: 0o700 });
  const authSource = join(sourceConfigHomes[input.agent], authNames[input.agent]);
  const authTarget = join(configHome, authNames[input.agent]);
  const linkedAuthentication = await linkAuthentication(authSource, authTarget);

  const language = sourceEnv.LANG?.trim() || "C.UTF-8";
  const locale = sourceEnv.LC_ALL?.trim() || language;
  const env: NodeJS.ProcessEnv = {
    HOME: sessionHome,
    TMPDIR: temporaryDirectory,
    LANG: language,
    LC_ALL: locale,
    NO_COLOR: "1",
  };
  if (input.agent === "claude") env.CLAUDE_CONFIG_DIR = configHome;
  if (input.agent === "codex") env.CODEX_HOME = configHome;
  if (input.agent === "grok") env.GROK_HOME = configHome;

  const secretValues = new Set<string>([sessionHome, temporaryDirectory, configHome]);
  secretValues.add(sourceHome);
  for (const path of Object.values(sourceConfigHomes)) secretValues.add(path);
  if (linkedAuthentication) secretValues.add(linkedAuthentication);
  if (sourceEnv.BALANCE_ORCHESTRATOR_TOKEN) {
    secretValues.add(sourceEnv.BALANCE_ORCHESTRATOR_TOKEN);
  }
  const secrets = Object.freeze([...secretValues]);
  const agentHomeRootIdentity = await lstat(agentHomeRoot);
  const sessionHomeIdentity = await lstat(sessionHome);

  return {
    env,
    secrets,
    async cleanup(): Promise<void> {
      const currentRunRoot = await realpath(runRoot);
      if (currentRunRoot !== canonicalRunRoot) {
        throw new Error("refusing to clean an agent home after the run root identity changed");
      }
      const currentAgentHomeRoot = await lstat(agentHomeRoot);
      if (
        currentAgentHomeRoot.isSymbolicLink() ||
        !currentAgentHomeRoot.isDirectory() ||
        currentAgentHomeRoot.dev !== agentHomeRootIdentity.dev ||
        currentAgentHomeRoot.ino !== agentHomeRootIdentity.ino
      ) {
        throw new Error("refusing to clean an agent home after its parent identity changed");
      }
      const currentSessionMetadata = await lstat(sessionHome);
      if (
        currentSessionMetadata.isSymbolicLink() ||
        !currentSessionMetadata.isDirectory() ||
        currentSessionMetadata.dev !== sessionHomeIdentity.dev ||
        currentSessionMetadata.ino !== sessionHomeIdentity.ino
      ) {
        throw new Error("refusing to clean an unsafe agent session home");
      }
      if (!sessionHome.startsWith(`${canonicalRunRoot}/agent-home/`)) {
        throw new Error("refusing to clean an agent home outside the run root");
      }
      await rm(sessionHome, { recursive: true });
    },
  };
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false && value !== "";
}

function terminateProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct PID when the process group already exited.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The child already exited.
  }
}

export async function verifyGrokIsolation(
  binaryPath: string,
  environment: AgentSessionEnvironment,
): Promise<void> {
  const canonical = await validateBinaryPath(binaryPath);
  const raw = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(canonical, ["inspect", "--json"], {
      detached: process.platform !== "win32",
      env: environment.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectOutput(error);
      else resolveOutput(stdout);
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = `${current}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(next, "utf8") > INSPECT_OUTPUT_LIMIT) {
        terminateProcessGroup(child.pid);
        finish(new Error("Grok inspect output exceeded 1 MiB"));
      }
      return next.slice(0, INSPECT_OUTPUT_LIMIT);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const diagnostic = redactAgentOutput(stderr.slice(0, 500), environment.secrets);
        finish(new Error(`Grok inspect exited with ${code ?? signal ?? "unknown"}: ${diagnostic}`));
      } else {
        finish(null);
      }
    });
    const timeout = setTimeout(() => {
      terminateProcessGroup(child.pid);
      finish(new Error("Grok inspect timed out after 3000ms"));
    }, INSPECT_TIMEOUT_MS);
    timeout.unref();
  });

  let inspection: unknown;
  try {
    inspection = JSON.parse(raw);
  } catch {
    throw new Error("Grok inspect did not return valid JSON");
  }
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    throw new Error("Grok inspect returned an invalid isolation report");
  }
  const report = inspection as Record<string, unknown>;
  const configSources = report.configSources;
  const configSourceRecord = asRecord(configSources);
  if (
    !("hooks" in report) ||
    !("plugins" in report) ||
    !("mcpServers" in report) ||
    !configSourceRecord ||
    !("layers" in configSourceRecord)
  ) {
    throw new Error("Grok inspect returned an incomplete isolation report");
  }
  const layers = configSourceRecord.layers;
  if (
    hasEntries(report.hooks) ||
    hasEntries(report.plugins) ||
    hasEntries(report.mcpServers) ||
    hasEntries(layers)
  ) {
    throw new Error(
      "Grok isolation check found hooks, plugins, MCP servers or configuration layers",
    );
  }
}

function validateCommandInput(binaryPath: string, cwd: string): void {
  requiredAbsolutePath(binaryPath, "binaryPath");
  requiredAbsolutePath(cwd, "working directory");
}

export function buildPlanCommand(input: {
  agent: NativeAgentId;
  binaryPath: string;
  repositoryPath: string;
  prompt: string;
  schemaPath: string | null;
  inlineSchema: string;
}): AgentCommand {
  validateCommandInput(input.binaryPath, input.repositoryPath);
  let args: string[];
  if (input.agent === "claude") {
    args = [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      "{}",
      "--setting-sources",
      "",
      "--settings",
      "{}",
      "--permission-mode",
      "plan",
      "--json-schema",
      input.inlineSchema,
      "--allowedTools",
      "Read,Glob,Grep",
    ];
  } else if (input.agent === "codex") {
    if (!input.schemaPath) throw new Error("Codex planning requires an absolute schemaPath");
    requiredAbsolutePath(input.schemaPath, "schemaPath");
    args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "multi_agent",
      "-c",
      'approval_policy="never"',
      "--cd",
      input.repositoryPath,
      "--sandbox",
      "read-only",
      "--output-schema",
      input.schemaPath,
      input.prompt,
    ];
  } else {
    args = [
      "-p",
      input.prompt,
      "--output-format",
      "json",
      "--no-auto-update",
      "--disable-web-search",
      "--no-subagents",
      "--verbatim",
      "--sandbox",
      "read-only",
      "--permission-mode",
      "plan",
      "--json-schema",
      input.inlineSchema,
      "--tools",
      "Read,Glob,Grep",
    ];
  }
  return { command: input.binaryPath, args, cwd: input.repositoryPath, env: {} };
}

function executionPrompt(task: AssignedTask): string {
  return [
    `Task ${task.id}: ${task.title}`,
    task.description,
    `Expected files: ${task.expectedFiles.join(", ") || "none declared"}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    `Verification commands:\n${task.verificationCommands
      .map((command) => `- ${JSON.stringify([command.executable, ...command.args])}`)
      .join("\n")}`,
    "Implement only this task in the current worktree. Do not commit changes.",
  ].join("\n\n");
}

export function buildExecuteCommand(input: {
  agent: NativeAgentId;
  binaryPath: string;
  worktreePath: string;
  task: AssignedTask;
}): AgentCommand {
  validateCommandInput(input.binaryPath, input.worktreePath);
  const prompt = executionPrompt(input.task);
  let args: string[];
  if (input.agent === "claude") {
    args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      "{}",
      "--setting-sources",
      "",
      "--settings",
      "{}",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Edit,Write,Glob,Grep,Bash",
    ];
  } else if (input.agent === "codex") {
    args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "multi_agent",
      "-c",
      'approval_policy="never"',
      "--cd",
      input.worktreePath,
      "--sandbox",
      "workspace-write",
      prompt,
    ];
  } else {
    args = [
      "-p",
      prompt,
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--disable-web-search",
      "--no-subagents",
      "--verbatim",
      "--sandbox",
      "workspace",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Edit,Write,Glob,Grep,Bash",
    ];
  }
  return { command: input.binaryPath, args, cwd: input.worktreePath, env: {} };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function serializedDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable tool detail]";
  }
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageEvent(value: unknown): OrchestratorEvent | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const hasUsage = [
    "input_tokens",
    "inputTokens",
    "output_tokens",
    "outputTokens",
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read_input_tokens",
  ].some((key) => key in usage);
  if (!hasUsage) return null;
  return {
    type: "usage",
    inputTokens: nonNegativeNumber(usage.input_tokens ?? usage.inputTokens),
    outputTokens: nonNegativeNumber(usage.output_tokens ?? usage.outputTokens),
    cachedInputTokens: nonNegativeNumber(
      usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens,
    ),
  };
}

function normalizeClaude(value: Record<string, unknown>): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = [];
  if (value.type === "system" && value.subtype === "init") {
    const sessionId = textValue(value.session_id);
    if (sessionId) events.push({ type: "session_started", sessionId });
  } else if (value.type === "assistant") {
    const message = asRecord(value.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        const block = asRecord(entry);
        if (!block) continue;
        if (block.type === "text") {
          const text = textValue(block.text);
          if (text) events.push({ type: "message", text });
        } else if (block.type === "tool_use") {
          events.push({
            type: "tool_started",
            tool: textValue(block.name) ?? "unknown_tool",
            detail: serializedDetail(block.input),
          });
        }
      }
    }
  } else if (value.type === "user") {
    const message = asRecord(value.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        const block = asRecord(entry);
        if (block?.type === "tool_result") {
          events.push({
            type: "tool_completed",
            tool: textValue(block.name) ?? textValue(block.tool_use_id) ?? "unknown_tool",
            success: block.is_error !== true,
          });
        }
      }
    }
  } else if (value.type === "result") {
    const sessionId = textValue(value.session_id);
    if (sessionId) events.push({ type: "session_started", sessionId });
    const resultText = textValue(value.result);
    if (resultText) events.push({ type: "message", text: resultText });
    const usage = usageEvent(value.usage);
    if (usage) events.push(usage);
  }
  return events;
}

function normalizeCodex(value: Record<string, unknown>): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = [];
  if (value.type === "thread.started") {
    const sessionId = textValue(value.thread_id);
    if (sessionId) events.push({ type: "session_started", sessionId });
  } else if (value.type === "item.started" || value.type === "item.completed") {
    const item = asRecord(value.item);
    if (!item) return events;
    if (item.type === "agent_message" && value.type === "item.completed") {
      const text = textValue(item.text);
      if (text) events.push({ type: "message", text });
    } else if (value.type === "item.started") {
      events.push({
        type: "tool_started",
        tool: textValue(item.type) ?? "unknown_tool",
        detail: serializedDetail(item.command ?? item.name ?? item.arguments),
      });
    } else {
      events.push({
        type: "tool_completed",
        tool: textValue(item.type) ?? "unknown_tool",
        success:
          item.status !== "failed" && (typeof item.exit_code !== "number" || item.exit_code === 0),
      });
    }
  } else if (value.type === "turn.completed") {
    const usage = usageEvent(value.usage);
    if (usage) events.push(usage);
  } else if (value.type === "error" || value.type === "turn.failed") {
    const error = asRecord(value.error);
    events.push({
      type: "process_failed",
      category: textValue(error?.type) ?? String(value.type),
      message:
        textValue(error?.message) ?? textValue(value.message) ?? "native agent reported an error",
    });
  }
  return events;
}

function normalizeGrok(value: Record<string, unknown>): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = [];
  if (value.type === "session.started" || value.type === "session_started") {
    const sessionId = textValue(value.session_id ?? value.sessionId);
    if (sessionId) events.push({ type: "session_started", sessionId });
  } else if (value.type === "assistant" || value.type === "message") {
    const text = textValue(value.content ?? value.text);
    if (text) events.push({ type: "message", text });
  } else if (value.type === "tool_call" || value.type === "tool.started") {
    events.push({
      type: "tool_started",
      tool: textValue(value.name ?? value.tool) ?? "unknown_tool",
      detail: serializedDetail(value.arguments ?? value.input ?? value.detail),
    });
  } else if (value.type === "tool_result" || value.type === "tool.completed") {
    events.push({
      type: "tool_completed",
      tool: textValue(value.name ?? value.tool) ?? "unknown_tool",
      success: value.success !== false && value.error === undefined,
    });
  } else if (value.type === "result") {
    const sessionId = textValue(value.session_id ?? value.sessionId);
    if (sessionId) events.push({ type: "session_started", sessionId });
    const text = textValue(value.output ?? value.result);
    if (text) events.push({ type: "message", text });
    const usage = usageEvent(value.usage);
    if (usage) events.push(usage);
  } else if (value.type === "error") {
    events.push({
      type: "process_failed",
      category: textValue(value.category) ?? "grok_error",
      message: textValue(value.message) ?? "native agent reported an error",
    });
  }
  return events;
}

export function normalizeAgentLine(
  agent: NativeAgentId,
  stream: "stdout" | "stderr",
  line: string,
): OrchestratorEvent[] {
  if (stream === "stderr") return [{ type: "diagnostic", stream, message: line }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "diagnostic", stream, message: line }];
  }
  const value = asRecord(parsed);
  if (!value) return [{ type: "diagnostic", stream, message: line }];
  const events =
    agent === "claude"
      ? normalizeClaude(value)
      : agent === "codex"
        ? normalizeCodex(value)
        : normalizeGrok(value);
  return events.length > 0 ? events : [{ type: "diagnostic", stream, message: line }];
}

function parseJsonObject(text: string): unknown | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function looksLikePlan(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    Array.isArray(record.tasks),
  );
}

export function extractStructuredPlan(agent: NativeAgentId, rawLines: readonly string[]): unknown {
  for (let index = rawLines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonObject(rawLines[index]!);
    const record = asRecord(parsed);
    if (!record) continue;
    const structured = record.structured_output ?? record.structuredOutput;
    if (structured && typeof structured === "object") return structured;
    if (agent === "claude" && record.type === "result") {
      if (looksLikePlan(record.result)) return record.result;
      const resultText = textValue(record.result);
      const result = resultText ? parseJsonObject(resultText) : null;
      if (looksLikePlan(result)) return result;
    }
    if (agent === "codex" && record.type === "item.completed") {
      const item = asRecord(record.item);
      if (item?.type === "agent_message") {
        const text = textValue(item.text);
        const result = text ? parseJsonObject(text) : null;
        if (looksLikePlan(result)) return result;
      }
    }
    if (agent === "grok" && looksLikePlan(record)) return record;
  }
  throw new Error(`No structured plan was found in ${agent} output`);
}

function escapedSecretVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  variants.add(secret.replaceAll("/", "\\/"));
  try {
    variants.add(encodeURIComponent(secret));
  } catch {
    // The raw value is still redacted when URL encoding cannot represent it.
  }
  return [...variants].filter(Boolean);
}

export function redactAgentOutput(line: string, secrets: readonly string[]): string {
  let safe = line;
  safe = safe.replace(/(\bauthorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;|"']+/gi, "$1[REDACTED]");
  safe = safe.replace(/(\bbearer\s+)[^\s,;|"']+/gi, "$1[REDACTED]");
  safe = safe.replace(
    /((?:["']?(?:api[_-]?key|oauth[_-]?(?:token|key)|access[_-]?token|refresh[_-]?token|token)["']?)\s*[:=]\s*["']?)[^\s,;|"']+/gi,
    "$1[REDACTED]",
  );
  const variants = new Set<string>();
  for (const secret of secrets) {
    for (const variant of escapedSecretVariants(secret)) variants.add(variant);
  }
  for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
    safe = safe.split(variant).join("[REDACTED]");
  }
  return safe;
}
