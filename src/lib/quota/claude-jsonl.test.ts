import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { foldByRequestId, parseJsonlLine } from "./claude-jsonl.ts";
import { createScanState, scanClaudeUsage } from "./claude-log.server.ts";

function assistant(partial: Record<string, unknown>) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-19T15:12:29.612Z",
    sessionId: "sess-1",
    cwd: "/tmp/synq-fixture/claude",
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
  const home = mkdtempSync(join(tmpdir(), "synq-claude-"));
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
