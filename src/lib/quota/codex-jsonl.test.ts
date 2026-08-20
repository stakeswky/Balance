import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asCodexModel, parseCodexJsonlLine, type CodexSessionMeta } from "./codex-jsonl.ts";
import { createCodexScanState, scanCodexUsage } from "./codex-log.server.ts";

const meta: CodexSessionMeta = {
  sessionId: "sess-c",
  cwd: "/tmp/synq-fixture/codex",
  title: "Codex 会话",
  model: "gpt-5.4",
};

function tokenCount(partial: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: "2026-08-20T01:00:46.299Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 90000,
          cached_input_tokens: 80000,
          cache_write_input_tokens: 0,
          output_tokens: 1500,
          reasoning_output_tokens: 800,
          total_tokens: 91500,
        },
        last_token_usage: {
          input_tokens: 27339,
          cached_input_tokens: 27008,
          cache_write_input_tokens: 0,
          output_tokens: 807,
          reasoning_output_tokens: 482,
          total_tokens: 28146,
        },
      },
      rate_limits: {
        primary: { used_percent: 57, window_minutes: 10080, resets_at: 1787209839 },
        plan_type: "pro",
      },
    },
    ...partial,
  });
}

test("parseCodexJsonlLine uses last_token_usage not session totals", () => {
  const { event, official } = parseCodexJsonlLine(tokenCount(), { ...meta });
  assert.ok(event);
  assert.equal(event.tokensIn, 331);
  assert.equal(event.tokensOut, 807);
  assert.equal(event.cacheRead, 27008);
  assert.equal(event.modelRaw, "gpt-5.4");
  assert.ok(event.reasoningMin > 0.5 && event.reasoningMin < 0.7);
  assert.equal(event.model, "gpt-5.4");
  assert.equal(asCodexModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(official?.weekPct, 57);
  assert.equal(official?.planLabel, "ChatGPT Pro");
});

test("session_meta and turn_context update cwd/model", () => {
  const m: CodexSessionMeta = { sessionId: "x", cwd: "", title: "", model: "gpt-5.4" };
  parseCodexJsonlLine(
    JSON.stringify({
      type: "session_meta",
      payload: { session_id: "abc", cwd: "/tmp/demo", agent_nickname: "Bacon" },
    }),
    m,
  );
  parseCodexJsonlLine(
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/tmp/demo" } }),
    m,
  );
  assert.equal(m.sessionId, "abc");
  assert.equal(m.cwd, "/tmp/demo");
  assert.equal(m.title, "Bacon");
  assert.equal(m.model, "gpt-5.6-sol");
  assert.equal(asCodexModel(m.model), "gpt-5.6-sol");
});

test("non token_count lines are ignored", () => {
  const { event } = parseCodexJsonlLine(
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
    meta,
  );
  assert.equal(event, null);
});

test("incremental scan only emits new token_count ids", () => {
  const home = mkdtempSync(join(tmpdir(), "synq-codex-"));
  const codexHome = join(home, ".codex");
  const dir = join(codexHome, "sessions", "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-08-20T09-00-26-01a01caf-0009-78b1-a9fe-152648fe32d4.jsonl");
  const firstLine = tokenCount();
  writeFileSync(file, `${firstLine}\n`);

  const state = createCodexScanState();
  const now = Date.parse("2026-08-20T01:10:00Z");
  const first = scanCodexUsage(0, { codexHome, now, state });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.tokensIn, 331);
  assert.equal(first.official?.weekPct, 57);
  assert.deepEqual(first.officialHistory.map((s) => s.weekPct), [57]);

  const second = JSON.stringify({
    timestamp: "2026-08-20T01:01:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
      rate_limits: {
        primary: { used_percent: 58, window_minutes: 10080, resets_at: 1787209839 },
        plan_type: "pro",
      },
    },
  });
  appendFileSync(file, `${second}\n`);
  const next = scanCodexUsage(first.events[0]!.ts + 1, { codexHome, now, state });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0]?.tokensIn, 100);
  assert.equal(next.official?.weekPct, 58);
  assert.deepEqual(next.officialHistory.map((s) => s.weekPct), [58]);
});
