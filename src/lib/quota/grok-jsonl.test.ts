import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asGrokModel, parseGrokUpdateLine } from "./grok-jsonl.ts";
import { createGrokScanState, scanGrokUsage } from "./grok-log.server.ts";

const meta = {
  sessionId: "sess-g",
  cwd: "/tmp/synq-fixture/grok",
  title: "接 Grok 日志",
  model: "grok-4.6",
};

function turn(partial: Record<string, unknown>) {
  return JSON.stringify({
    timestamp: 1787153666,
    method: "_x.ai/session/update",
    params: {
      sessionId: "sess-g",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        stop_reason: "end_turn",
        usage: {
          inputTokens: 1080403,
          outputTokens: 33067,
          cachedReadTokens: 637568,
          cacheCreationTokens: 0,
          reasoningTokens: 15886,
          costUsdTicks: 424242,
          modelUsage: { "grok-4.6-build": { inputTokens: 1080403, costUsdTicks: 424242 } },
        },
      },
      _meta: { eventId: "ev-1", agentTimestampMs: 1787153666911 },
    },
    ...partial,
  });
}

test("parses turn_completed usage and grok-4.6-build", () => {
  const ev = parseGrokUpdateLine(turn({}), meta);
  assert.ok(ev);
  assert.equal(ev.agent, "grok");
  assert.equal(ev.model, "grok-4.6");
  assert.equal(ev.id, "prompt-1");
  assert.equal(ev.tokensIn, 1080403 - 637568);
  assert.equal(ev.tokensOut, 33067);
  assert.equal(ev.cacheRead, 637568);
  assert.equal(ev.modelRaw, "grok-4.6-build");
  assert.equal(ev.reportedCostTicks, 424242);
  assert.equal(ev.reportedCostByModel?.["grok-4.6-build"], 424242);
  assert.equal(ev.ts, 1787153666911);
  assert.equal(ev.task, "接 Grok 日志");
});

test("snake_case grok usage fields still split cached input", () => {
  const line = JSON.stringify({
    timestamp: 1787153666,
    params: {
      sessionId: "sess-g",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p-snake",
        usage: { input_tokens: 50, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
      },
    },
  });
  const ev = parseGrokUpdateLine(line, meta);
  assert.ok(ev);
  assert.equal(ev.tokensIn, 30);
  assert.equal(ev.cacheRead, 20);
  assert.equal(ev.cacheWrite, 3);
});

test("unix-second timestamps become ms", () => {
  const line = JSON.stringify({
    timestamp: 1787153666,
    params: {
      sessionId: "sess-g",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p2",
        usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 0, cacheCreationTokens: 0 },
      },
    },
  });
  const ev = parseGrokUpdateLine(line, meta);
  assert.ok(ev);
  assert.equal(ev.ts, 1787153666000);
});

test("tool_call lines are ignored", () => {
  const line = JSON.stringify({
    params: { update: { sessionUpdate: "tool_call" }, _meta: { totalTokens: 43749 } },
  });
  assert.equal(parseGrokUpdateLine(line, meta), null);
});

test("asGrokModel maps build ids", () => {
  assert.equal(asGrokModel("grok-4.6-build"), "grok-4.6");
  assert.equal(asGrokModel("grok-4.5"), "grok-4.5");
  assert.equal(asGrokModel("grok-4"), "grok-4.6");
});

test("incremental scan only emits new prompt_ids", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-grok-"));
  const grokHome = join(home, ".grok");
  const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/demo"), "sess-g");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({ generated_title: "接 Grok 日志", current_model_id: "grok-4.6", info: { cwd: "/tmp/demo" } }),
  );
  const file = join(dir, "updates.jsonl");
  writeFileSync(file, `${turn({})}\n${turn({})}\n`);

  const state = createGrokScanState();
  const first = scanGrokUsage(0, { grokHome, now: 1787153666911 + 60_000, state });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.id, "prompt-1");
  assert.equal(first.events[0]?.task, "接 Grok 日志");

  const secondLine = turn({
    timestamp: 1787153700,
    params: {
      sessionId: "sess-g",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-2",
        usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
      },
      _meta: { agentTimestampMs: 1787153700001 },
    },
  });
  appendFileSync(file, `${secondLine}\n`);
  const second = scanGrokUsage(first.events[0]!.ts + 1, { grokHome, now: 1787153700001 + 1000, state });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.id, "prompt-2");
});

test("Grok per-file cursor keeps a late parallel turn older than global since", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-grok-late-"));
  const grokHome = join(home, ".grok");
  const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/demo"), "sess-g");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ generated_title: "并行 Grok", info: { cwd: "/tmp/demo" } }));
  const file = join(dir, "updates.jsonl");
  writeFileSync(file, `${turn({})}\n`);
  const state = createGrokScanState();
  const first = scanGrokUsage(0, { grokHome, now: 1_787_153_667_911, state });
  const late = turn({
    params: {
      sessionId: "sess-g",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-late",
        usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
      },
      _meta: { agentTimestampMs: 1_787_153_600_000 },
    },
  });
  appendFileSync(file, `${late}\n`);
  const second = scanGrokUsage(first.events[0]!.ts + 1, { grokHome, now: 1_787_153_668_000, state });
  assert.deepEqual(second.events.map((event) => event.id), ["prompt-late"]);
});

test("Grok reports two concurrently writing sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-grok-active-"));
  const grokHome = join(home, ".grok");
  const now = 1_787_153_700_000;
  for (const [sessionId, offset] of [["sess-a", 1_000], ["sess-b", 2_000]] as const) {
    const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/demo"), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ generated_title: `任务 ${sessionId}`, info: { cwd: "/tmp/demo" } }));
    const file = join(dir, "updates.jsonl");
    writeFileSync(file, `${turn({
      params: {
        sessionId,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: `prompt-${sessionId}`,
          usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
        },
        _meta: { agentTimestampMs: now - offset },
      },
    })}\n`);
    utimesSync(file, new Date(now - offset), new Date(now - offset));
  }
  const result = scanGrokUsage(0, { grokHome, now, state: createGrokScanState() });
  assert.deepEqual(result.active.map((task) => task.sessionId).sort(), ["sess-a", "sess-b"]);
  assert.equal(result.live?.sessionId, "sess-a");
  assert.equal(result.live?.lastTs, now - 1_000);
});
