import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsForAgents, visibleAgentIds } from "./agent-availability.ts";
import type { AgentId, UsageEvent } from "./types.ts";

function event(agent: AgentId, id = `event-${agent}`): UsageEvent {
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
  assert.deepEqual(visibleAgentIds({ claude: true, grok: false, codex: true }, false, []), [
    "claude",
    "codex",
  ]);
});

test("manual data makes an undetected agent visible", () => {
  assert.deepEqual(
    visibleAgentIds({ claude: false, grok: false, codex: false }, false, [event("grok")]),
    ["grok"],
  );
});

test("real mode with no detected or imported agents has no active data", () => {
  const agents = visibleAgentIds({ claude: false, grok: false, codex: false }, false, []);
  assert.deepEqual(agents, []);
  assert.deepEqual(eventsForAgents([event("claude"), event("grok"), event("codex")], agents), []);
});

test("demo mode always shows all three agents", () => {
  assert.deepEqual(visibleAgentIds({ claude: false, grok: false, codex: false }, true, []), [
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
