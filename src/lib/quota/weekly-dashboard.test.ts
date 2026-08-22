import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfficialSlice } from "./official.ts";
import type { UsageEvent } from "./types.ts";
import {
  formatResetIn,
  pickPreferredSubscription,
  preferredSubscriptionHint,
  weekSourceLabel,
  weeklyQuotaRows,
} from "./weekly-dashboard.ts";

function event(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "e1",
    agent: "claude",
    model: "opus",
    ts: 1,
    sessionId: "s1",
    task: "task",
    tokensIn: 1,
    tokensOut: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
    ...partial,
  };
}

function official(partial: Partial<OfficialSlice> = {}): OfficialSlice {
  return {
    agent: "claude",
    windowPct: 10,
    weekPct: 37,
    windowResetsAt: null,
    weekResetsAt: 1_700_000_000_000,
    weekStartedAt: null,
    windowDurationMs: 5 * 60 * 60 * 1000,
    weekDurationMs: 7 * 24 * 60 * 60 * 1000,
    burnPctPerHour: 1,
    planLabel: "Claude Max 20×",
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "oauth",
    fetchedAt: 1,
    windowKind: "five_hour",
    ...partial,
  };
}

test("weekly dashboard lists only monitored agents", () => {
  const rows = weeklyQuotaRows({
    events: [event({ agent: "claude" }), event({ agent: "grok", model: "grok-4.6", id: "e2" })],
    availability: { claude: true, grok: false, codex: false },
    demoMode: false,
    official: { claude: official(), grok: null, codex: null },
    claudePlanId: "claude-max-20x",
    grokPlanId: "grok-super",
    codexPlanId: "chatgpt-plus",
    weekBoostPct: 0,
    now: 1_000,
  });
  assert.deepEqual(
    rows.map((row) => row.agent),
    ["claude", "grok"],
  );
  assert.equal(rows[0]?.planName, "Claude Max 20×");
  assert.equal(rows[0]?.usedPct, 37);
  assert.equal(rows[0]?.remainPct, 63);
  assert.equal(rows[0]?.source, "official");
  assert.equal(rows[0]?.status, "ok");
  assert.equal(rows[0]?.windowUsedPct, 10);
});

test("preferred subscription is the loosest window-or-week load", () => {
  const rows = weeklyQuotaRows({
    events: [],
    availability: { claude: true, grok: true, codex: true },
    demoMode: true,
    official: {
      claude: official({ agent: "claude", weekPct: 80, windowPct: 90 }),
      grok: official({ agent: "grok", weekPct: 22, windowPct: 8, planLabel: "SuperGrok" }),
      codex: official({ agent: "codex", weekPct: 50, windowPct: 46, planLabel: "ChatGPT Plus" }),
    },
    claudePlanId: "claude-max-20x",
    grokPlanId: "grok-super",
    codexPlanId: "chatgpt-plus",
    weekBoostPct: 0,
    now: 1_000,
  });
  const preferred = pickPreferredSubscription(rows);
  assert.equal(preferred?.agent, "grok");
  const hint = preferredSubscriptionHint(preferred!, rows);
  assert.equal(hint.title, "现在用 Grok");
  assert.match(hint.body, /更宽裕/);
});

test("preferred subscription keeps the first agent when loads tie", () => {
  const rows = weeklyQuotaRows({
    events: [],
    availability: { claude: true, grok: true, codex: false },
    demoMode: false,
    official: {
      claude: official({ agent: "claude", weekPct: 10, windowPct: 10 }),
      grok: official({ agent: "grok", weekPct: 10, windowPct: 10, planLabel: "SuperGrok" }),
      codex: null,
    },
    claudePlanId: "claude-max-20x",
    grokPlanId: "grok-super",
    codexPlanId: "chatgpt-plus",
    weekBoostPct: 0,
    now: 1_000,
  });
  assert.equal(pickPreferredSubscription(rows)?.agent, "claude");
  assert.equal(pickPreferredSubscription([]), null);
});

test("weekly dashboard includes Claude Fable week limit when official reports it", () => {
  const rows = weeklyQuotaRows({
    events: [],
    availability: { claude: true, grok: false, codex: false },
    demoMode: false,
    official: {
      claude: official({
        weekPct: 80,
        modelWeekLimits: { fable: { usedPct: 91, resetsAt: 9 } },
      }),
      grok: null,
      codex: null,
    },
    claudePlanId: "claude-max-20x",
    grokPlanId: "grok-super",
    codexPlanId: "chatgpt-plus",
    weekBoostPct: 0,
    now: 1_000,
  });
  assert.equal(rows[0]?.status, "watch");
  assert.equal(rows[0]?.fable?.usedPct, 91);
  assert.equal(rows[0]?.fable?.remainPct, 9);
  assert.equal(rows[0]?.fable?.limitPctOfWeek, 50);
});

test("weekly dashboard is empty when nothing is monitored", () => {
  assert.deepEqual(
    weeklyQuotaRows({
      events: [],
      availability: { claude: false, grok: false, codex: false },
      demoMode: false,
      official: { claude: null, grok: null, codex: null },
      claudePlanId: "claude-max-20x",
      grokPlanId: "grok-super",
      codexPlanId: "chatgpt-plus",
      weekBoostPct: 0,
      now: 1_000,
    }),
    [],
  );
});

test("reset copy and source labels stay compact", () => {
  assert.equal(formatResetIn(1_000, 1_000), "即将重置");
  assert.equal(formatResetIn(1_000 + 2 * 60 * 60 * 1000, 1_000), "2 小时后重置");
  assert.equal(weekSourceLabel("official"), "官方");
  assert.equal(weekSourceLabel("official-stale"), "官方快照");
  assert.equal(weekSourceLabel("local-estimate"), "本地估算");
});
