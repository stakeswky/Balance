import assert from "node:assert/strict";
import { test } from "node:test";
import {
  grokAccessTokenFromAuthFile,
  grokPlanIdFromLabel,
  grokProductLabel,
  mergeGrokOfficial,
  nextCodexPlanId,
  parseClaudeHistoryPoints,
  parseClaudePlanHistory,
  parseClaudeUsagePayload,
  slicesFromClaudeHistory,
  parseCodexRateLimitLog,
  parseCodexUsagePayload,
  parseGrokBillingLog,
  parseGrokBillingLogAll,
  parseGrokBillingPayload,
  codexPlanIdFromLabel,
} from "./official.ts";

function grokLine(percent: number, timestamp: string): string {
  return JSON.stringify({
    ts: timestamp,
    msg: "billing: fetched credits config",
    ctx: {
      config: {
        creditUsagePercent: percent,
        currentPeriod: {
          start: "2026-08-18T13:28:17Z",
          end: "2026-08-25T13:28:17Z",
        },
      },
      subscriptionTier: "X Premium+",
    },
  });
}

test("claude plan-usage-history uses latest fh/sd percents", () => {
  const now = Date.parse("2026-08-19T17:10:00Z");
  const raw = {
    version: 2,
    samples: [
      { t: Date.parse("2026-08-19T16:22:00Z"), org: "x", u: { fh: 4, sd: 18 } },
      { t: Date.parse("2026-08-19T16:37:00Z"), org: "x", u: { fh: 6, sd: 18 } },
      { t: Date.parse("2026-08-19T17:07:00Z"), org: "x", u: { fh: 7, sd: 19 } },
    ],
  };
  const s = parseClaudePlanHistory(raw, now);
  assert.ok(s);
  assert.equal(s.windowPct, 7);
  assert.equal(s.weekPct, 19);
  assert.equal(s.windowKind, "five_hour");
  assert.ok(s.burnPctPerHour > 3 && s.burnPctPerHour < 5);
});

test("claude history replay keeps fractional percents after reset", () => {
  const t0 = Date.parse("2026-08-19T15:52:00Z");
  const points = parseClaudeHistoryPoints({
    samples: [
      { t: t0 - 15 * 60_000, org: "x", u: { fh: 13, sd: 17 } },
      { t: t0, org: "x", u: { fh: 0, sd: 17 } },
      { t: t0 + 10 * 60_000, org: "x", u: { fh: 1, sd: 17 } },
      { t: t0 + 12 * 60_000, org: "x", u: { fh: 1.2, sd: 17 } },
      { t: t0 + 20 * 60_000, org: "x", u: { fh: 2, sd: 18 } },
      { t: t0 + 30 * 60_000, org: "x", u: { fh: 3, sd: 18 } },
    ],
  });
  const slices = slicesFromClaudeHistory(points);
  assert.deepEqual(slices.map((s) => s.windowPct), [0, 1, 1.2, 2, 3]);
  assert.equal(slices[0]?.windowResetsAt, t0 + 5 * 60 * 60 * 1000);
  assert.equal(slices[0]?.windowKind, "five_hour");
});

test("claude history keeps weekly cadence without inventing a five-hour reset", () => {
  const t0 = Date.parse("2026-08-19T15:52:00Z");
  const withReset = parseClaudeHistoryPoints({
    samples: [
      { t: t0 - 60_000, org: "x", u: { fh: 12, sd: 17 } },
      { t: t0, org: "x", u: { fh: 0, sd: 17 } },
      { t: t0 + 10 * 60_000, org: "x", u: { fh: 4, sd: 17 } },
      { t: t0 + 6 * 60 * 60_000, org: "x", u: { fh: 2, sd: 18 } },
      { t: t0 + 6 * 60 * 60_000 + 20 * 60_000, org: "x", u: { fh: 3, sd: 18 } },
    ],
  });
  const slices = slicesFromClaudeHistory(withReset);
  assert.equal(slices[0]?.windowResetsAt, t0 + 5 * 60 * 60 * 1000);
  const later = slices.filter((s) => (s.fetchedAt ?? 0) >= t0 + 6 * 60 * 60_000);
  assert.ok(later.length >= 2);
  assert.ok(later.every((s) => s.windowResetsAt === null));
  assert.deepEqual(later.map((s) => s.windowPct), [2, 3]);
});

test("Claude history does not tile an expired five-hour anchor", () => {
  const start = Date.parse("2026-08-21T00:00:00Z");
  const rows = slicesFromClaudeHistory([
    { t: start, fh: 20.75, sd: 30.25 },
    { t: start + 60_000, fh: 0.5, sd: 30.5 },
    { t: start + 6 * 60 * 60_000, fh: 12.25, sd: 31.25 },
  ]);
  assert.equal(rows.at(-1)!.windowResetsAt, null);
  assert.equal(rows.at(-1)!.windowPct, 12.25);
  assert.equal(rows.at(-1)!.weekPct, 31.25);
});

test("claude 5h reset is inferred when fh drops to 0", () => {
  const t0 = Date.parse("2026-08-19T15:52:00Z");
  const raw = {
    samples: [
      { t: t0 - 15 * 60_000, org: "x", u: { fh: 13, sd: 17 } },
      { t: t0, org: "x", u: { fh: 0, sd: 17 } },
      { t: t0 + 15 * 60_000, org: "x", u: { fh: 1, sd: 17 } },
    ],
  };
  const s = parseClaudePlanHistory(raw, t0 + 20 * 60_000);
  assert.ok(s);
  assert.equal(s.windowResetsAt, t0 + 5 * 60 * 60 * 1000);
});

test("Claude accepts a seven percent to zero five-hour reset", () => {
  const t0 = Date.parse("2026-08-20T00:55:00Z");
  const raw = {
    samples: [
      { t: t0 - 60_000, u: { fh: 7, sd: 20 } },
      { t: t0, u: { fh: 0, sd: 20 } },
      { t: t0 + 60_000, u: { fh: 1, sd: 20 } },
    ],
  };
  const points = parseClaudeHistoryPoints(raw);
  const latest = slicesFromClaudeHistory(points).at(-1);
  assert.equal(latest?.windowResetsAt, t0 + 5 * 60 * 60 * 1000);
  assert.equal(parseClaudePlanHistory(raw, t0 + 2 * 60_000)?.windowResetsAt, t0 + 5 * 60 * 60 * 1000);
});

test("Claude history anchors and advances the seven-day window", () => {
  const t0 = Date.parse("2026-08-18T01:36:00Z");
  const points = parseClaudeHistoryPoints({
    samples: [
      { t: t0 - 60_000, u: { fh: 9, sd: 77 } },
      { t: t0, u: { fh: 0, sd: 0 } },
      { t: t0 + 60_000, u: { fh: 1, sd: 1 } },
      { t: t0 + 8 * 24 * 60 * 60 * 1000, u: { fh: 2, sd: 3 } },
    ],
  });
  const slices = slicesFromClaudeHistory(points);
  assert.equal(slices[0]?.weekStartedAt, t0);
  assert.equal(slices[0]?.weekResetsAt, t0 + 7 * 24 * 60 * 60 * 1000);
  assert.ok((slices.at(-1)?.weekStartedAt ?? 0) >= t0 + 7 * 24 * 60 * 60 * 1000);
});

test("Claude OAuth usage exposes the official Fable weekly limit", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const fableReset = "2026-08-25T20:59:00Z";
  const usage = parseClaudeUsagePayload(
    {
      five_hour: { utilization: 34, resets_at: "2026-08-20T15:00:00Z" },
      seven_day: { utilization: 27, resets_at: "2026-08-25T20:59:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Fable 5" } },
          percent: 24,
          resets_at: fableReset,
        },
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Other" } },
          percent: 91,
          resets_at: fableReset,
        },
      ],
    },
    { fetchedAt: now },
  );

  assert.ok(usage);
  assert.equal(usage.windowPct, 34);
  assert.equal(usage.weekPct, 27);
  assert.deepEqual(usage.modelWeekLimits, {
    fable: { usedPct: 24, resetsAt: Date.parse(fableReset) },
  });
  assert.equal(usage.source, "oauth-usage");
});

test("Claude OAuth usage parses the observed scalar 24/34/26 contract", () => {
  const usage = parseClaudeUsagePayload({
    five_hour: 24,
    seven_day: 34,
    limits: [
      { kind: "session", percent: 24 },
      { kind: "weekly_all", percent: 34 },
      {
        kind: "weekly_scoped",
        scope: { model: { display_name: "Fable" } },
        percent: 26,
      },
    ],
  });

  assert.ok(usage);
  assert.equal(usage.windowPct, 24);
  assert.equal(usage.weekPct, 34);
  assert.equal(usage.windowResetsAt, null);
  assert.equal(usage.weekResetsAt, null);
  assert.deepEqual(usage.modelWeekLimits, {
    fable: { usedPct: 26, resetsAt: null },
  });
});

test("Claude OAuth limits win over legacy top-level windows", () => {
  const usage = parseClaudeUsagePayload({
    five_hour: { utilization: 9, resets_at: "2026-08-20T15:00:00Z" },
    seven_day: { utilization: 11, resets_at: "2026-08-25T20:59:00Z" },
    limits: [
      { kind: "session", percent: 24, resets_at: "2026-08-20T16:00:00Z" },
      { kind: "weekly_all", percent: 34, resets_at: "2026-08-26T20:59:00Z" },
    ],
  });

  assert.ok(usage);
  assert.equal(usage.windowPct, 24);
  assert.equal(usage.weekPct, 34);
  assert.equal(usage.windowResetsAt, Date.parse("2026-08-20T16:00:00Z"));
  assert.equal(usage.weekResetsAt, Date.parse("2026-08-26T20:59:00Z"));
});

test("Claude OAuth skips invalid limits and falls back to valid top-level scalars", () => {
  const usage = parseClaudeUsagePayload({
    five_hour: "24",
    seven_day: 34,
    limits: [
      { kind: "session", percent: false },
      { kind: "weekly_all", percent: { value: 99 } },
    ],
  });

  assert.ok(usage);
  assert.equal(usage.windowPct, 24);
  assert.equal(usage.weekPct, 34);
  assert.equal(parseClaudeUsagePayload({ five_hour: false }), null);
});

test("Claude OAuth usage accepts Fable and ignores malformed scoped limits", () => {
  const usage = parseClaudeUsagePayload({
    seven_day_overage_included: { utilization: 31, resets_at: 1_787_691_540 },
    limits: [
      { kind: "daily_scoped", scope: { model: { display_name: "Fable" } }, percent: 90 },
      { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: "bad" },
    ],
  });

  assert.ok(usage);
  assert.deepEqual(usage.modelWeekLimits, {
    fable: { usedPct: 31, resetsAt: 1_787_691_540_000 },
  });
});

test("Claude OAuth usage rejects payloads without any usage windows", () => {
  assert.equal(parseClaudeUsagePayload({ limits: [] }), null);
});

test("Grok same-percent plateau keeps the latest observation", () => {
  const all = parseGrokBillingLogAll(
    `${grokLine(8, "2026-08-19T16:00:00Z")}\n${grokLine(8, "2026-08-19T17:00:00Z")}\n`,
  );
  assert.equal(all.length, 1);
  assert.equal(all[0]?.fetchedAt, Date.parse("2026-08-19T17:00:00Z"));
});

test("grok live billing payload includes product split", () => {
  const s = parseGrokBillingPayload({
    config: {
      creditUsagePercent: 14,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-18T13:28:17.911572+00:00",
        end: "2026-08-25T13:28:17.911572+00:00",
      },
      productUsage: [
        { product: "GrokBuild", usagePercent: 12 },
        { product: "GrokAppBuilder", usagePercent: 2 },
        { product: "GrokChat" },
      ],
    },
  });
  assert.ok(s);
  assert.equal(s.weekPct, 14);
  assert.equal(s.products[0]?.product, "GrokBuild");
  assert.equal(s.products[0]?.usagePercent, 12);
  assert.equal(s.products[2]?.usagePercent, null);
  assert.equal(grokProductLabel("GrokBuild"), "Grok Build / CLI");
});

test("grok billing log yields weekly percent and X Premium+", () => {
  const line = JSON.stringify({
    ts: "2026-08-19T16:48:52.988Z",
    msg: "billing: fetched credits config",
    ctx: {
      config: {
        creditUsagePercent: 8.0,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-18T13:28:17.911572+00:00",
          end: "2026-08-25T13:28:17.911572+00:00",
        },
      },
      subscriptionTier: "X Premium+",
    },
  });
  const s = parseGrokBillingLog(`${line}\n`);
  assert.ok(s);
  assert.equal(s.weekPct, 8);
  assert.equal(s.windowPct, null);
  assert.equal(s.planLabel, "X Premium+");
  assert.equal(s.windowKind, "weekly");
  assert.equal(grokPlanIdFromLabel(s.planLabel), "grok-super");
  assert.ok(s.weekResetsAt);
});

test("grok auth file yields access token without exposing other accounts", () => {
  const token = grokAccessTokenFromAuthFile({
    "https://auth.x.ai::acct": { key: "eyJhbGciOiJIUzI1NiJ9.e30.sig", auth_mode: "oidc" },
  });
  assert.equal(token, "eyJhbGciOiJIUzI1NiJ9.e30.sig");
  assert.equal(grokAccessTokenFromAuthFile({}), null);
});

test("merge prefers live percent and borrows plan label from the log", () => {
  const live = parseGrokBillingPayload({
    config: {
      creditUsagePercent: 15,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-18T13:28:17Z",
        end: "2026-08-25T13:28:17Z",
      },
      productUsage: [{ product: "GrokBuild", usagePercent: 13 }],
      prepaidBalance: { val: 0 },
    },
  });
  const log = parseGrokBillingPayload(
    {
      config: { creditUsagePercent: 8, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
      subscriptionTier: "X Premium+",
    },
    { source: "unified-billing-log" },
  );
  const merged = mergeGrokOfficial(live, log);
  assert.ok(merged);
  assert.equal(merged.weekPct, 15);
  assert.equal(merged.source, "billing-api");
  assert.equal(merged.planLabel, "X Premium+");
  assert.equal(merged.products[0]?.usagePercent, 13);
  assert.equal(merged.prepaidBalance, 0);
  assert.equal(grokPlanIdFromLabel(merged.planLabel), "grok-super");
});

test("codex live usage payload is weekly ChatGPT Pro at 57%", () => {
  const s = parseCodexUsagePayload({
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: 57,
        limit_window_seconds: 604800,
        reset_at: 1787209839,
      },
      secondary_window: null,
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1787205758 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1787792558 },
        },
      },
    ],
    credits: { balance: "0" },
  });
  assert.ok(s);
  assert.equal(s.agent, "codex");
  assert.equal(s.windowKind, "weekly");
  assert.equal(s.weekPct, 57);
  assert.equal(s.windowPct, null);
  assert.equal(s.windowDurationMs, null);
  assert.equal(s.weekDurationMs, 604_800_000);
  assert.equal(s.planLabel, "ChatGPT Pro");
  assert.equal(codexPlanIdFromLabel(s.planLabel), "chatgpt-pro");
  assert.equal(codexPlanIdFromLabel("ChatGPT Pro 20×"), "chatgpt-pro-20x");
  assert.equal(codexPlanIdFromLabel("ChatGPT Pro 5x"), "chatgpt-pro-5x");
  assert.equal(s.weekResetsAt, 1787209839 * 1000);
  assert.equal(s.products[0]?.product, "GPT-5.3-Codex-Spark");
  assert.equal(s.products[0]?.usagePercent, 0);
  assert.equal(s.prepaidBalance, 0);
});

test("codex jsonl rate_limits uses last_token_usage companion fields", () => {
  const line = JSON.stringify({
    timestamp: "2026-08-20T01:00:46.299Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0 },
      },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 57, window_minutes: 10080, resets_at: 1787209839 },
        secondary: null,
        plan_type: "pro",
        credits: { balance: "0" },
      },
    },
  });
  const s = parseCodexRateLimitLog(`${line}\n`);
  assert.ok(s);
  assert.equal(s.weekPct, 57);
  assert.equal(s.windowKind, "weekly");
  assert.equal(s.planLabel, "ChatGPT Pro");
  assert.equal(s.source, "session-rate-limits");
});

test("codex 5h primary plus weekly secondary", () => {
  const s = parseCodexUsagePayload({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1787170000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1787209839 },
    },
  });
  assert.ok(s);
  assert.equal(s.windowKind, "five_hour");
  assert.equal(s.windowPct, 12);
  assert.equal(s.weekPct, 40);
  assert.equal(s.windowDurationMs, 18_000_000);
  assert.equal(s.weekDurationMs, 604_800_000);
  assert.equal(s.planLabel, "ChatGPT Plus");
  assert.equal(codexPlanIdFromLabel(s.planLabel), "chatgpt-plus");
});

test("ambiguous pro label preserves the user's current tier", () => {
  assert.equal(nextCodexPlanId("chatgpt-pro-5x", "ChatGPT Pro"), "chatgpt-pro-5x");
  assert.equal(nextCodexPlanId("chatgpt-pro-20x", "ChatGPT Pro"), "chatgpt-pro-20x");
  assert.equal(nextCodexPlanId("chatgpt-plus", "ChatGPT Pro"), "chatgpt-plus");
  assert.equal(nextCodexPlanId("chatgpt-plus", "ChatGPT Pro 20×"), "chatgpt-pro-20x");
});
