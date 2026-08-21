import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { foldByRequestId, parseJsonlLine, type SessionMeta } from "./claude-jsonl.ts";
import { createScanState, scanClaudeUsage } from "./claude-log.server.ts";

function assistant(partial: Record<string, unknown>) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-19T15:12:29.612Z",
    sessionId: "sess-1",
    cwd: "/tmp/balance-fixture/claude",
    requestId: "req_aaa",
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 10,
        output_tokens: 523,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 39408,
      },
    },
    ...partial,
  });
}

test("parseJsonlLine keeps usage and requestId", () => {
  const ev = parseJsonlLine(assistant({}), { sessionId: "sess-1", cwd: "", title: "", lastUser: "" });
  assert.ok(ev);
  assert.equal(ev.id, "req_aaa");
  assert.equal(ev.model, "opus");
  assert.equal(ev.modelRaw, "claude-opus-4-6");
  assert.equal(ev.tokensIn, 10);
  assert.equal(ev.tokensOut, 523);
  assert.equal(ev.cacheWrite, 39408);
  assert.equal(ev.cacheWriteUnsplit, true);
});

test("content-block splits with the same requestId collapse to last", () => {
  const meta = { sessionId: "sess-1", cwd: "", title: "修 PR", lastUser: "" };
  const a = parseJsonlLine(assistant({}), meta);
  const b = parseJsonlLine(
    assistant({
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 10,
          output_tokens: 523,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 39408,
        },
      },
    }),
    meta,
  );
  const folded = foldByRequestId([a!, b!]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0]?.task, "修 PR");
});

test("nested cache_creation counts as cache write", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-19T15:12:29.612Z",
    sessionId: "sess-1",
    requestId: "req_bbb",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 2,
        output_tokens: 40,
        cache_read_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 12 },
      },
    },
  });
  const ev = parseJsonlLine(line, { sessionId: "sess-1", cwd: "", title: "", lastUser: "" });
  assert.ok(ev);
  assert.equal(ev.model, "sonnet");
  assert.equal(ev.modelRaw, "claude-sonnet-4-6");
  assert.equal(ev.cacheWrite, 8);
  assert.equal(ev.cacheWrite1h, 12);
  assert.equal(ev.cacheRead, 100);
  assert.equal(ev.cacheWriteUnsplit, undefined);
});

test("user / queue lines are ignored", () => {
  const user = parseJsonlLine(
    JSON.stringify({ type: "user", sessionId: "sess-1", message: { role: "user", content: "hi" } }),
    { sessionId: "sess-1", cwd: "", title: "", lastUser: "" },
  );
  assert.equal(user, null);
});

test("incremental scan only returns new requestIds after the first pass", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-claude-"));
  const dir = join(home, ".claude", "projects", "-Volumes-data-dev-demo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  writeFileSync(
    file,
    `${assistant({ requestId: "req_1" })}\n${assistant({ requestId: "req_1" })}\n`,
  );

  const state = createScanState();
  const first = scanClaudeUsage(0, { home, now: Date.parse("2026-08-19T16:00:00Z"), state });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.id, "req_1");

  appendFileSync(
    file,
    `${assistant({ requestId: "req_2", timestamp: "2026-08-19T15:13:01.000Z" })}\n`,
  );
  const since = first.events[0]!.ts + 1;
  const second = scanClaudeUsage(since, { home, now: Date.parse("2026-08-19T16:00:01Z"), state });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.id, "req_2");
});

test("Claude per-file cursor keeps a late parallel event older than global since", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-claude-late-"));
  const dir = join(home, ".claude", "projects", "-demo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "root-session.jsonl");
  writeFileSync(file, `${assistant({ requestId: "req-new", timestamp: "2026-08-19T15:12:29.612Z" })}\n`);
  const state = createScanState();
  const first = scanClaudeUsage(0, { home, now: Date.parse("2026-08-19T16:00:00Z"), state });
  appendFileSync(file, `${assistant({ requestId: "req-late", timestamp: "2026-08-19T15:12:00.000Z" })}\n`);
  const second = scanClaudeUsage(first.events[0]!.ts + 1, {
    home,
    now: Date.parse("2026-08-19T16:00:01Z"),
    state,
  });
  assert.deepEqual(second.events.map((event) => event.id), ["req-late"]);
});

test("Claude keeps billing session and subagent actor identities separate", () => {
  const meta = {
    sessionId: "agent-a1",
    cwd: "",
    title: "",
    lastUser: "",
    actorId: "agent-a1",
    actorKind: "subagent" as const,
  };
  parseJsonlLine(
    JSON.stringify({
      type: "user",
      sessionId: "parent-session",
      agentId: "a1",
      isSidechain: true,
      message: { role: "user", content: "检查并修复支付回归" },
    }),
    meta,
  );
  parseJsonlLine(
    JSON.stringify({
      type: "user",
      sessionId: "parent-session",
      agentId: "a1",
      message: { role: "user", content: "<system-reminder>Other agents active</system-reminder>" },
    }),
    meta,
  );
  const event = parseJsonlLine(
    assistant({ sessionId: "parent-session", agentId: "a1", requestId: "req-child" }),
    meta,
  );
  assert.ok(event);
  assert.equal(event.sessionId, "parent-session");
  assert.equal(event.actorId, "agent-a1");
  assert.equal(event.actorKind, "subagent");
  assert.equal(event.task, "检查并修复支付回归");
});

test("Claude reports concurrently writing subagents as active", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-claude-active-"));
  const root = join(home, ".claude", "projects", "-demo", "parent-session");
  const subagents = join(root, "subagents");
  mkdirSync(subagents, { recursive: true });
  const now = Date.parse("2026-08-20T11:00:00Z");
  for (const actor of ["a1", "a2"]) {
    const file = join(subagents, `agent-${actor}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", sessionId: "parent-session", agentId: actor, message: { content: `任务 ${actor}` } })}\n${assistant({ sessionId: "parent-session", agentId: actor, requestId: `req-${actor}`, timestamp: "2026-08-20T10:59:59Z" })}\n`,
    );
    utimesSync(file, new Date(now - 1_000), new Date(now - 1_000));
  }
  const result = scanClaudeUsage(0, { home, now, state: createScanState() });
  assert.equal(result.active.length, 2);
  assert.deepEqual(result.active.map((task) => task.actorId).sort(), ["agent-a1", "agent-a2"]);
  assert.equal(result.live?.writing, true);
  assert.equal(new Set(result.events.map((event) => event.actorId)).size, 2);
});

test("Claude workflow subagent prefers the workflow label over its long prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-claude-workflow-"));
  const session = join(home, ".claude", "projects", "-demo", "parent-session");
  const workflowDir = join(session, "workflows");
  const logDir = join(session, "subagents", "workflows", "wf_demo");
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(workflowDir, "wf_demo.json"),
    JSON.stringify({
      workflowProgress: [
        { type: "workflow_agent", agentId: "ab45c5", label: "M0-3-ws-origin" },
      ],
    }),
  );
  const now = Date.parse("2026-08-20T11:00:00Z");
  const log = join(logDir, "agent-ab45c5.jsonl");
  writeFileSync(
    log,
    `${JSON.stringify({ type: "user", sessionId: "parent-session", agentId: "ab45c5", isSidechain: true, message: { content: "这是不应成为标题的完整长任务 prompt" } })}\n${assistant({ sessionId: "parent-session", agentId: "ab45c5", attributionAgent: "workflow-subagent", requestId: "req-workflow", timestamp: "2026-08-20T10:59:59Z" })}\n`,
  );
  utimesSync(log, new Date(now - 1_000), new Date(now - 1_000));
  const result = scanClaudeUsage(0, { home, now, state: createScanState() });
  assert.equal(result.events[0]?.task, "M0-3-ws-origin");
  assert.equal(result.events[0]?.actorKind, "workflow-subagent");
  assert.equal(result.active[0]?.task, "M0-3-ws-origin");
});

test("Claude numeric Unix seconds are converted to milliseconds", () => {
  const meta: SessionMeta = {
    sessionId: "session",
    cwd: "/tmp/project",
    title: "",
    lastUser: "",
  };
  const event = parseJsonlLine(JSON.stringify({
    type: "assistant",
    timestamp: 1_725_000_000,
    requestId: "req-seconds",
    message: {
      model: "claude-sonnet-5",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }), meta);
  assert.equal(event!.ts, 1_725_000_000_000);
});
