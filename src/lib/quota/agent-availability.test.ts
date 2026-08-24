import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsForAgents, visibleAgentIds } from "./agent-availability.ts";
import type { UsageAgentId, UsageEvent } from "./types.ts";

function event(agent: UsageAgentId, id = `event-${agent}`): UsageEvent {
  return {
    id,
    agent,
    model: agent === "claude" ? "opus" : agent === "grok" ? "grok-4.6" : "gpt-5.6-sol",
    ts: 1,
    sessionId: `session-${agent}`,
    task: `task-${agent}`,
    tokensIn: 1,
    tokensOut: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
  };
}

test("real mode shows only detected agents", () => {
  assert.deepEqual(visibleAgentIds({ claude: true, grok: false, codex: true, antigravity: false }, false, []), [
    "claude",
    "codex",
  ]);
});

test("manual data makes an undetected agent visible", () => {
  assert.deepEqual(
    visibleAgentIds({ claude: false, grok: false, codex: false, antigravity: false }, false, [event("grok")]),
    ["grok"],
  );
});

test("real mode with no detected or imported agents has no active data", () => {
  const agents = visibleAgentIds({ claude: false, grok: false, codex: false, antigravity: false }, false, []);
  assert.deepEqual(agents, []);
  assert.deepEqual(eventsForAgents([event("claude"), event("grok"), event("codex")], agents), []);
});

test("demo mode always shows all three agents", () => {
  assert.deepEqual(visibleAgentIds({ claude: false, grok: false, codex: false, antigravity: false }, true, []), [
    "claude",
    "grok",
    "codex",
  ]);
});

test("eventsForAgents removes unavailable agent data from summaries", () => {
  const claude = event("claude");
  const hiddenGrok = event("grok");
  const hiddenCodex = event("codex");
  const filtered = eventsForAgents([claude, hiddenGrok, hiddenCodex], ["claude"]);
  assert.deepEqual(filtered, [claude]);
  assert.equal(
    filtered.some((item) => item.id === hiddenGrok.id),
    false,
  );
  assert.equal(
    filtered.some((item) => item.id === hiddenCodex.id),
    false,
  );
});

test("real mode covers every single-agent and two-agent combination", () => {
  const none = { claude: false, grok: false, codex: false, antigravity: false };
  assert.deepEqual(visibleAgentIds({ claude: true, grok: false, codex: false, antigravity: false }, false, []), [
    "claude",
  ]);
  assert.deepEqual(visibleAgentIds({ claude: false, grok: true, codex: false, antigravity: false }, false, []), [
    "grok",
  ]);
  assert.deepEqual(visibleAgentIds({ claude: false, grok: false, codex: true, antigravity: false }, false, []), [
    "codex",
  ]);
  assert.deepEqual(visibleAgentIds({ claude: true, grok: true, codex: false, antigravity: false }, false, []), [
    "claude",
    "grok",
  ]);
  assert.deepEqual(visibleAgentIds({ claude: true, grok: false, codex: true, antigravity: false }, false, []), [
    "claude",
    "codex",
  ]);
  assert.deepEqual(visibleAgentIds({ claude: false, grok: true, codex: true, antigravity: false }, false, []), [
    "grok",
    "codex",
  ]);
  assert.deepEqual(visibleAgentIds({ claude: true, grok: true, codex: true, antigravity: false }, false, []), [
    "claude",
    "grok",
    "codex",
  ]);
  assert.deepEqual(visibleAgentIds(none, false, [event("codex")]), ["codex"]);
});

test("hidden agent events are excluded from visible token totals", () => {
  const claude = { ...event("claude"), tokensIn: 100, tokensOut: 10 };
  const grok = { ...event("grok"), tokensIn: 9_000, tokensOut: 900 };
  const codex = { ...event("codex"), tokensIn: 8_000, tokensOut: 800 };
  const visible = eventsForAgents([claude, grok, codex], ["claude"]);
  assert.equal(
    visible.reduce((sum, item) => sum + item.tokensIn + item.tokensOut, 0),
    110,
  );
});

test("Antigravity is visible from CLI availability but never becomes a demo usage agent", () => {
  const availability = { claude: false, grok: false, codex: false, antigravity: true };
  assert.deepEqual(visibleAgentIds(availability, false, []), ["antigravity"]);
  assert.deepEqual(visibleAgentIds(availability, true, []), ["claude", "grok", "codex"]);
  assert.deepEqual(eventsForAgents([event("claude")], ["antigravity"]), []);
});
