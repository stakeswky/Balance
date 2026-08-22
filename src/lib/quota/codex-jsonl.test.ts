import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asCodexModel, parseCodexJsonlLine, type CodexSessionMeta } from "./codex-jsonl.ts";
import { createCodexScanState, scanCodexUsage } from "./codex-log.server.ts";
import { observeWindow } from "./quota-value.ts";

const meta: CodexSessionMeta = {
  sessionId: "sess-c",
  cwd: "/tmp/balance-fixture/codex",
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
  const home = mkdtempSync(join(tmpdir(), "balance-codex-"));
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

test("Codex per-file cursor keeps a late parallel event older than global since", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-codex-late-"));
  const codexHome = join(home, ".codex");
  const dir = join(codexHome, "sessions", "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-08-20T09-00-26-01a01caf-0009-78b1-a9fe-152648fe32d4.jsonl");
  writeFileSync(file, `${tokenCount()}\n`);
  const state = createCodexScanState();
  const now = Date.parse("2026-08-20T01:10:00Z");
  const first = scanCodexUsage(0, { codexHome, now, state });
  appendFileSync(file, `${tokenCount({ timestamp: "2026-08-20T01:00:00.000Z" })}\n`);
  const second = scanCodexUsage(first.events[0]!.ts + 1, { codexHome, now, state });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.ts, Date.parse("2026-08-20T01:00:00.000Z"));
});

test("Codex parser propagates token anomalies from last_token_usage", () => {
  const { event } = parseCodexJsonlLine(
    tokenCount({
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 250,
            cache_write_input_tokens: 0,
            output_tokens: -807,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
    { ...meta },
  );
  assert.ok(event);
  assert.equal(event.tokensIn, 0);
  assert.equal(event.cacheRead, 100);
  assert.equal(event.tokensOut, 0);
  assert.deepEqual(
    event.anomalies?.map((anomaly) => anomaly.code).sort(),
    ["cached-input-exceeds-input", "negative-token"],
  );
});

test("Codex reports parallel sessions and deduplicates rollouts for one session", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-codex-active-"));
  const codexHome = join(home, ".codex");
  const dir = join(codexHome, "sessions", "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-08-20T11:00:00Z");
  const rows = [
    ["01a01caf-0009-78b1-a9fe-152648fe32d4", "sess-a", 1_000],
    ["01a01caf-0009-78b1-a9fe-152648fe32d5", "sess-a", 2_000],
    ["01a01caf-0009-78b1-a9fe-152648fe32d6", "sess-b", 3_000],
  ] as const;
  for (const [fileId, sessionId, offset] of rows) {
    const file = join(dir, `rollout-2026-08-20T10-59-00-${fileId}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd: "/tmp/demo", agent_nickname: sessionId } })}\n${tokenCount({ timestamp: new Date(now - offset).toISOString() })}\n`,
    );
    utimesSync(file, new Date(now - offset), new Date(now - offset));
  }
  const result = scanCodexUsage(0, { codexHome, now, state: createCodexScanState() });
  assert.deepEqual(result.active.map((task) => task.sessionId).sort(), ["sess-a", "sess-b"]);
  assert.equal(result.live?.sessionId, "sess-a");
  assert.equal(result.live?.startedAt, now - 2_000);
  assert.equal(result.live?.lastTs, now - 1_000);
  assert.equal(result.live?.turns, 2);
});

test("Codex explicit image token fields propagate verbatim", () => {
  const { event } = parseCodexJsonlLine(
    tokenCount({
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            image_input_tokens: 640,
            image_output_tokens: 0,
          },
        },
      },
    }),
    { ...meta },
  );
  assert.ok(event);
  assert.equal(event.imageInputTokens, 640);
  assert.equal(event.imageOutputTokens, 0);
});

test("Codex missing raw model keeps the event but stays unpriced", () => {
  const bare: CodexSessionMeta = { sessionId: "sess-nomodel", cwd: "", title: "", model: "" };
  const { event } = parseCodexJsonlLine(tokenCount(), bare);
  assert.ok(event);
  assert.equal(event.modelRaw, undefined);
  assert.equal(observeWindow([event]).pricedTokenCoverage, 0);
});

function plateauRow(usedPercent: number, timestamp: string) {
  return JSON.stringify({
    timestamp,
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
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1787209839 },
        plan_type: "pro",
      },
    },
  });
}

test("Codex history keeps only the latest row of an unchanged plateau", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-codex-plateau-"));
  const codexHome = join(home, ".codex");
  const dir = join(codexHome, "sessions", "2026", "08", "21");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-08-21T10-00-00-01a01caf-0009-78b1-a9fe-152648fe32d4.jsonl");
  const rows = [
    plateauRow(57, "2026-08-21T10:00:00.000Z"),
    plateauRow(57, "2026-08-21T10:01:00.000Z"),
    plateauRow(58, "2026-08-21T10:02:00.000Z"),
  ];
  writeFileSync(file, `${rows.join("\n")}\n`);
  const now = Date.parse("2026-08-21T10:10:00Z");
  const result = scanCodexUsage(0, { codexHome, now, state: createCodexScanState() });
  assert.deepEqual(result.officialHistory.map((row) => row.weekPct), [57, 58]);
  assert.equal(result.officialHistory[0]!.fetchedAt, Date.parse("2026-08-21T10:01:00.000Z"));
});

const SPEED_CASES = [
  { raw: "fast", expected: "fast" },
  { raw: "FAST", expected: "fast" },
  { raw: "standard", expected: "standard" },
  { raw: undefined, expected: "unknown" },
  { raw: "turbo", expected: "unknown" },
] as const;

test("Codex explicit usage speed is recorded and never guessed", () => {
  const lastWith = (extra: Record<string, unknown>) =>
    tokenCount({
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            ...extra,
          },
        },
      },
    });
  for (const { raw, expected } of SPEED_CASES) {
    const { event } = parseCodexJsonlLine(lastWith(raw === undefined ? {} : { speed: raw }), { ...meta });
    assert.ok(event);
    assert.equal(event.speed, expected);
  }
  const { event: priorityOnly } = parseCodexJsonlLine(lastWith({ priority: "high" }), { ...meta });
  assert.ok(priorityOnly);
  assert.equal(priorityOnly.speed, "unknown");
});
