import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  buildExecuteCommand,
  buildPlanCommand,
  extractStructuredPlan,
  normalizeAgentLine,
  prepareAgentSessionEnvironment,
  redactAgentOutput,
  verifyGrokIsolation,
} from "./adapters.ts";
import type { AssignedTask, NativeAgentId } from "./types.ts";

async function temporaryDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `balance-adapter-${label}-`));
}

async function executable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function mode(value: number): number {
  return value & 0o777;
}

const task: AssignedTask = {
  id: "task_api",
  title: "Add API",
  description: "Implement the isolated API handler.",
  size: "medium",
  preferredAgent: null,
  assignedAgent: "codex",
  dependsOn: [],
  expectedFiles: ["src/api.ts"],
  acceptanceCriteria: ["The API returns 200"],
  verificationCommands: [{ executable: "npm", args: ["run", "test"] }],
};

test("builds auditable plan commands for Claude, Codex and Grok", () => {
  const common = {
    binaryPath: "/native/agent",
    repositoryPath: "/repo with spaces",
    prompt: "Plan this change",
    schemaPath: "/private/schema.json",
    inlineSchema: '{"type":"object"}',
  };
  assert.deepEqual(buildPlanCommand({ ...common, agent: "claude" }), {
    command: "/native/agent",
    args: [
      "-p",
      "Plan this change",
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
      '{"type":"object"}',
      "--allowedTools",
      "Read,Glob,Grep",
    ],
    cwd: "/repo with spaces",
    env: {},
  });
  assert.deepEqual(buildPlanCommand({ ...common, agent: "codex" }), {
    command: "/native/agent",
    args: [
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
      "/repo with spaces",
      "--sandbox",
      "read-only",
      "--output-schema",
      "/private/schema.json",
      "Plan this change",
    ],
    cwd: "/repo with spaces",
    env: {},
  });
  assert.deepEqual(buildPlanCommand({ ...common, agent: "grok" }), {
    command: "/native/agent",
    args: [
      "-p",
      "Plan this change",
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
      '{"type":"object"}',
      "--tools",
      "Read,Glob,Grep",
    ],
    cwd: "/repo with spaces",
    env: {},
  });
});

test("builds constrained execute commands without unsafe approval flags", () => {
  const commands = (["claude", "codex", "grok"] as const).map((agent) =>
    buildExecuteCommand({
      agent,
      binaryPath: `/native/${agent}`,
      worktreePath: "/task tree",
      task,
    }),
  );
  assert.deepEqual(commands[0]!.args.slice(0, 15), [
    "-p",
    commands[0]!.args[1],
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
  ]);
  assert.equal(commands[0]!.args.at(-1), "Read,Edit,Write,Glob,Grep,Bash");
  assert.deepEqual(commands[1]!.args.slice(0, 19), [
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
    "/task tree",
  ]);
  assert.deepEqual(commands[1]!.args.slice(19, 21), ["--sandbox", "workspace-write"]);
  assert.deepEqual(commands[2]!.args.slice(0, 14), [
    "-p",
    commands[2]!.args[1],
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
  ]);
  for (const command of commands) {
    assert.equal(command.cwd, "/task tree");
    assert.match(JSON.stringify(command.args), /Add API|isolated API/i);
    const serialized = JSON.stringify(command);
    for (const forbidden of [
      "--yolo",
      "danger-full-access",
      "bypassPermissions",
      "--dangerously-skip-permissions",
      "--always-approve",
    ]) {
      assert.doesNotMatch(
        serialized,
        new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      );
    }
  }
});

test("creates a private session home containing only the native auth symlink", async () => {
  const root = await temporaryDirectory("session");
  const sourceHome = join(root, "source-home");
  const runRoot = join(root, "run");
  const claudeAuth = join(sourceHome, ".claude", ".credentials.json");
  const codexAuth = join(sourceHome, ".codex", "auth.json");
  const grokAuth = join(sourceHome, ".grok", "auth.json");
  for (const [path, content] of [
    [claudeAuth, "claude-secret"],
    [codexAuth, "codex-secret"],
    [grokAuth, "grok-secret"],
  ] as const) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
  }
  await writeFile(join(sourceHome, ".claude", "settings.json"), "forbidden");

  const session = await prepareAgentSessionEnvironment({
    agent: "claude",
    runRoot,
    sourceEnv: {
      HOME: sourceHome,
      CODEX_HOME: join(sourceHome, ".codex"),
      GROK_HOME: join(sourceHome, ".grok"),
      BALANCE_ORCHESTRATOR_TOKEN: "desktop-capability",
      API_KEY: "must-not-be-injected",
    },
  });
  const sessionHome = join(await realpath(runRoot), "agent-home", "claude");
  const linkedAuth = join(sessionHome, ".claude", ".credentials.json");
  assert.equal(session.env.HOME, sessionHome);
  assert.equal(session.env.CLAUDE_CONFIG_DIR, join(sessionHome, ".claude"));
  assert.equal(session.env.API_KEY, undefined);
  assert.equal(mode((await lstat(sessionHome)).mode), 0o700);
  assert.equal(mode((await lstat(join(sessionHome, ".claude"))).mode), 0o700);
  assert.equal(mode((await lstat(join(sessionHome, "tmp"))).mode), 0o700);
  assert.equal((await lstat(linkedAuth)).isSymbolicLink(), true);
  assert.equal(await realpath(linkedAuth), await realpath(claudeAuth));
  await assert.rejects(() => readFile(join(sessionHome, ".claude", "settings.json")));
  assert.equal(session.secrets.includes(await realpath(sourceHome)), true);
  assert.equal(session.secrets.includes(await realpath(claudeAuth)), true);
  assert.equal(session.secrets.includes("desktop-capability"), true);
  assert.equal(Object.isFrozen(session.secrets), true);

  await session.cleanup();
  await assert.rejects(() => lstat(sessionHome));
  assert.equal(await readFile(claudeAuth, "utf8"), "claude-secret");
});

test("uses each agent's explicit config home and never links unrelated files", async () => {
  const root = await temporaryDirectory("homes");
  const sourceHome = join(root, "home");
  const externalCodex = join(root, "external-codex");
  const externalGrok = join(root, "external-grok");
  for (const configHome of [externalCodex, externalGrok]) {
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, "auth.json"), `${configHome}-auth`, { mode: 0o600 });
    await writeFile(join(configHome, "config.toml"), "forbidden");
  }
  await mkdir(sourceHome, { recursive: true });
  for (const agent of ["codex", "grok"] as const) {
    const session = await prepareAgentSessionEnvironment({
      agent,
      runRoot: join(root, `run-${agent}`),
      sourceEnv: { HOME: sourceHome, CODEX_HOME: externalCodex, GROK_HOME: externalGrok },
    });
    const variable = agent === "codex" ? "CODEX_HOME" : "GROK_HOME";
    const isolatedConfig = session.env[variable]!;
    assert.equal(
      await realpath(join(isolatedConfig, "auth.json")),
      await realpath(join(root, `external-${agent}`, "auth.json")),
    );
    await assert.rejects(() => lstat(join(isolatedConfig, "config.toml")));
    await session.cleanup();
  }
});

test("cleanup refuses a swapped agent-home parent and preserves the outside directory", async () => {
  const root = await temporaryDirectory("cleanup-swap");
  const sourceHome = join(root, "home");
  const runRoot = join(root, "run");
  await mkdir(sourceHome);
  const session = await prepareAgentSessionEnvironment({
    agent: "codex",
    runRoot,
    sourceEnv: { HOME: sourceHome },
  });
  const canonicalRun = await realpath(runRoot);
  const agentHomeRoot = join(canonicalRun, "agent-home");
  const heldAgentHomeRoot = join(canonicalRun, "held-agent-home");
  const outside = join(root, "outside");
  await mkdir(join(outside, "codex"), { recursive: true });
  await writeFile(join(outside, "codex", "keep.txt"), "keep");
  await rename(agentHomeRoot, heldAgentHomeRoot);
  await symlink(outside, agentHomeRoot);

  await assert.rejects(() => session.cleanup(), /identity|unsafe|refus/i);
  assert.equal(await readFile(join(outside, "codex", "keep.txt"), "utf8"), "keep");

  await rm(agentHomeRoot);
  await rename(heldAgentHomeRoot, agentHomeRoot);
  await session.cleanup();
});

test("fails Grok isolation inspection closed for every external configuration source", async () => {
  const root = await temporaryDirectory("grok-inspect");
  const sourceHome = join(root, "home");
  await mkdir(join(sourceHome, ".grok"), { recursive: true });
  await writeFile(join(sourceHome, ".grok", "auth.json"), "auth", { mode: 0o600 });
  const session = await prepareAgentSessionEnvironment({
    agent: "grok",
    runRoot: join(root, "run"),
    sourceEnv: { HOME: sourceHome },
  });
  const clean = join(root, "clean-grok");
  await executable(
    clean,
    'printf \'%s\\n\' \'{"hooks":[],"plugins":[],"mcpServers":{},"configSources":{"layers":[]}}\'',
  );
  await verifyGrokIsolation(clean, session);

  const dirtyShapes = [
    '{"hooks":["bad"],"plugins":[],"mcpServers":{},"configSources":{"layers":[]}}',
    '{"hooks":[],"plugins":{"bad":true},"mcpServers":{},"configSources":{"layers":[]}}',
    '{"hooks":[],"plugins":[],"mcpServers":{"bad":{}},"configSources":{"layers":[]}}',
    '{"hooks":[],"plugins":[],"mcpServers":{},"configSources":{"layers":["project"]}}',
  ];
  for (const [index, shape] of dirtyShapes.entries()) {
    const binary = join(root, `dirty-grok-${index}`);
    await executable(binary, `printf '%s\\n' '${shape}'`);
    await assert.rejects(
      () => verifyGrokIsolation(binary, session),
      /isolation|hook|plugin|mcp|config/i,
    );
  }
  const malformed = join(root, "malformed-grok");
  await executable(malformed, "printf 'not-json\\n'");
  await assert.rejects(() => verifyGrokIsolation(malformed, session), /JSON|inspect/i);
  const incomplete = join(root, "incomplete-grok");
  await executable(incomplete, "printf '%s\\n' '{}'");
  await assert.rejects(
    () => verifyGrokIsolation(incomplete, session),
    /incomplete|isolation|inspect/i,
  );
  const leaking = join(root, "leaking-grok");
  await executable(leaking, "printf 'token: leaked-inspect-token\\n' >&2; exit 4");
  await assert.rejects(
    () => verifyGrokIsolation(leaking, session),
    (error: Error) => {
      assert.equal(error.message.includes("leaked-inspect-token"), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
  await session.cleanup();
});

test("normalizes known Claude JSONL events and preserves unknown or broken output as diagnostics", () => {
  assert.deepEqual(
    normalizeAgentLine("claude", "stdout", '{"type":"system","subtype":"init","session_id":"s1"}'),
    [{ type: "session_started", sessionId: "s1" }],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "claude",
      "stdout",
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}}]}}',
    ),
    [
      { type: "message", text: "hello" },
      { type: "tool_started", tool: "Read", detail: '{"file_path":"src/a.ts"}' },
    ],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "claude",
      "stdout",
      '{"type":"result","usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":3}}',
    ),
    [{ type: "usage", inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 }],
  );
  assert.deepEqual(
    normalizeAgentLine("claude", "stdout", '{"type":"new_vendor_event","value":1}'),
    [{ type: "diagnostic", stream: "stdout", message: '{"type":"new_vendor_event","value":1}' }],
  );
  assert.deepEqual(normalizeAgentLine("claude", "stdout", "broken json"), [
    { type: "diagnostic", stream: "stdout", message: "broken json" },
  ]);
  assert.deepEqual(normalizeAgentLine("claude", "stderr", "warning text"), [
    { type: "diagnostic", stream: "stderr", message: "warning text" },
  ]);
});

test("normalizes Codex and Grok sessions, messages, tools and usage", () => {
  assert.deepEqual(
    normalizeAgentLine("codex", "stdout", '{"type":"thread.started","thread_id":"thread-7"}'),
    [{ type: "session_started", sessionId: "thread-7" }],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "codex",
      "stdout",
      '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}',
    ),
    [{ type: "tool_started", tool: "command_execution", detail: "npm test" }],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "codex",
      "stdout",
      '{"type":"item.completed","item":{"type":"agent_message","text":"implemented"}}',
    ),
    [{ type: "message", text: "implemented" }],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "codex",
      "stdout",
      '{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":8,"cached_input_tokens":5}}',
    ),
    [{ type: "usage", inputTokens: 20, outputTokens: 8, cachedInputTokens: 5 }],
  );
  assert.deepEqual(
    normalizeAgentLine("grok", "stdout", '{"type":"session.started","session_id":"grok-2"}'),
    [{ type: "session_started", sessionId: "grok-2" }],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "grok",
      "stdout",
      '{"type":"tool_call","name":"Write","arguments":{"path":"a.ts"}}',
    ),
    [{ type: "tool_started", tool: "Write", detail: '{"path":"a.ts"}' }],
  );
  assert.deepEqual(
    normalizeAgentLine(
      "grok",
      "stdout",
      '{"type":"result","output":"done","usage":{"input_tokens":7,"output_tokens":2,"cached_input_tokens":1}}',
    ),
    [
      { type: "message", text: "done" },
      { type: "usage", inputTokens: 7, outputTokens: 2, cachedInputTokens: 1 },
    ],
  );
});

test("extracts the final structured plan for every provider without trusting unknown wrappers", () => {
  const plan = { title: "Plan", summary: "Summary", tasks: [] };
  assert.deepEqual(
    extractStructuredPlan("claude", [
      '{"type":"assistant","message":{"content":[]}}',
      JSON.stringify({ type: "result", structured_output: plan }),
    ]),
    plan,
  );
  assert.deepEqual(
    extractStructuredPlan("codex", [
      '{"type":"thread.started","thread_id":"x"}',
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(plan) },
      }),
    ]),
    plan,
  );
  assert.deepEqual(
    extractStructuredPlan("grok", [JSON.stringify({ structured_output: plan })]),
    plan,
  );
  assert.throws(
    () => extractStructuredPlan("claude", ["bad", '{"type":"unknown"}']),
    /structured plan/i,
  );
});

test("redacts explicit secrets, encoded paths and common credential shapes", () => {
  const secretPath = "/Users/demo/Library/Application Support/Balance/auth";
  const secrets = [secretPath, "env-secret-123", "desktop-capability"];
  const raw = [
    `Authorization: Bearer bearer-value`,
    `api_key=api-secret`,
    `"oauth_token":"oauth-secret"`,
    `token: plain-token`,
    secretPath,
    JSON.stringify(secretPath),
    encodeURIComponent(secretPath),
    "env-secret-123",
    "desktop-capability",
  ].join(" | ");
  const redacted = redactAgentOutput(raw, secrets);
  for (const forbidden of [
    "bearer-value",
    "api-secret",
    "oauth-secret",
    "plain-token",
    secretPath,
    JSON.stringify(secretPath),
    encodeURIComponent(secretPath),
    "env-secret-123",
    "desktop-capability",
  ]) {
    assert.equal(redacted.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.match(redacted, /\[REDACTED\]/);
});

test("redacts private environment paths and tokens without corrupting ordinary output", async () => {
  const root = await temporaryDirectory("redact-env");
  const home = join(root, "home");
  await mkdir(home);
  const session = await prepareAgentSessionEnvironment({
    agent: "codex",
    runRoot: join(root, "run"),
    sourceEnv: { HOME: home, LANG: "custom-locale", BALANCE_ORCHESTRATOR_TOKEN: "desktop-token" },
  });
  const raw = `${session.env.HOME} | ${session.env.TMPDIR} | ${session.env.CODEX_HOME} | desktop-token | input_tokens=10 | locale=${session.env.LANG} | no_color=${session.env.NO_COLOR}`;
  const safe = redactAgentOutput(raw, session.secrets);
  for (const value of [session.env.HOME, session.env.TMPDIR, session.env.CODEX_HOME]) {
    if (value) assert.equal(safe.includes(value), false, `leaked private env path ${value}`);
  }
  assert.equal(safe.includes("desktop-token"), false);
  assert.match(safe, /input_tokens=10/);
  assert.match(safe, /locale=custom-locale/);
  assert.match(safe, /no_color=1/);
  const events = normalizeAgentLine("codex", "stderr", safe);
  assert.equal(events[0]?.type, "diagnostic");
  assert.equal(JSON.stringify(events).includes(home), false);
  await session.cleanup();
});

test("supports all and only the three native agents", () => {
  const agents: NativeAgentId[] = ["claude", "codex", "grok"];
  assert.deepEqual(
    agents.map(
      (agent) =>
        buildPlanCommand({
          agent,
          binaryPath: `/bin/${agent}`,
          repositoryPath: "/repo",
          prompt: "plan",
          schemaPath: "/schema",
          inlineSchema: "{}",
        }).command,
    ),
    ["/bin/claude", "/bin/codex", "/bin/grok"],
  );
});
