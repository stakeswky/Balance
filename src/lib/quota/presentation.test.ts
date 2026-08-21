import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOfficial, routingAdvice } from "./engine.ts";
import type { OfficialSlice } from "./official.ts";
import {
  apiEquivalentSections,
  effectiveQuotaStatus,
  formatCreditRange,
  formatCredits,
  formatWeekResetLabel,
  primaryUsagePercent,
  primaryWindowLabel,
  primaryWindowResetsAt,
  quotaAlertDecision,
  quotaAlertLatch,
  tightestQuota,
} from "./presentation.ts";
import type { QuotaValue } from "./quota-value.ts";
import type { MeterSnapshot } from "./types.ts";

function meter(partial: Partial<MeterSnapshot> = {}): MeterSnapshot {
  return {
    agent: "codex",
    windowPct: 0,
    weekPct: 0,
    windowTokens: 0,
    weekTokens: 0,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    windowBudget: 1,
    weekBudget: 1,
    windowResetsAt: 0,
    weekResetsAt: 0,
    burnPctPerHour: 0,
    etaMs: null,
    apiUsdWindow: 0,
    apiUsdWeek: 0,
    status: "ok",
    ...partial,
  };
}

function official(partial: Partial<OfficialSlice> = {}): OfficialSlice {
  return {
    agent: "codex",
    windowPct: null,
    weekPct: null,
    windowResetsAt: null,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: null,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel: "ChatGPT Pro",
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "wham-usage",
    fetchedAt: 1,
    windowKind: "weekly",
    ...partial,
  };
}

function quotaValue(confidence: QuotaValue["confidence"] = "low"): QuotaValue {
  return {
    usedPct: 20,
    l1Usd: 10,
    l1Credits: null,
    l1Tokens: 1_000,
    pricedTokenCoverage: 1,
    pricedEventCoverage: 1,
    rolling: false,
    windowId: "fixture",
    totalLowUsd: 40,
    totalPointUsd: 50,
    totalHighUsd: 60,
    remainingLowUsd: 32,
    remainingPointUsd: 40,
    remainingHighUsd: 48,
    totalLowCredits: null,
    totalPointCredits: null,
    totalHighCredits: null,
    remainingLowCredits: null,
    remainingPointCredits: null,
    remainingHighCredits: null,
    confidence,
    calibrationSource: "current-window",
    pricingVersion: "test",
    externalUsageDetected: false,
    anomalousPairs: 0,
  };
}

test("weekly official usage does not overwrite the local short window", () => {
  const result = applyOfficial(
    meter({ windowPct: 12, weekPct: 20 }),
    official({ weekPct: 60, weekResetsAt: 8_000_000 }),
  );
  assert.equal(result.windowPct, 12);
  assert.equal(result.weekPct, 60);
  assert.equal(primaryUsagePercent(result, "weekly"), 60);
  assert.equal(primaryWindowLabel("weekly"), "本周额度");
  assert.equal(primaryWindowResetsAt(result, "weekly"), 8_000_000);
});

test("weekly primary alert uses official week percent, threshold, and label", () => {
  const alert = quotaAlertDecision({
    meter: meter({ windowPct: 12, weekPct: 60 }),
    kind: "weekly",
    windowThreshold: 80,
    weekThreshold: 50,
  });
  assert.equal(alert.primaryTriggered, true);
  assert.equal(alert.primaryPercent, 60);
  assert.equal(alert.primaryThreshold, 50);
  assert.equal(alert.primaryLabel, "本周额度");
  assert.equal(alert.weekTriggered, false);
});

test("five-hour primary keeps a separate weekly alert", () => {
  const alert = quotaAlertDecision({
    meter: meter({ windowPct: 82, weekPct: 90 }),
    kind: "five_hour",
    windowThreshold: 80,
    weekThreshold: 85,
  });
  assert.equal(alert.primaryTriggered, true);
  assert.equal(alert.primaryLabel, "5 小时窗");
  assert.equal(alert.weekTriggered, true);
});

test("routing advice respects a weekly-only Codex limit", () => {
  const tips = routingAdvice([
    meter({ agent: "claude", windowPct: 20, weekPct: 20 }),
    meter({ agent: "grok", windowPct: 20, weekPct: 20 }),
    meter({ agent: "codex", windowPct: 12, weekPct: 80 }),
  ]);
  assert.ok(tips.some((tip) => tip.title.includes("Codex")));
});

test("routing advice never names unavailable agents", () => {
  const tips = routingAdvice([
    meter({ agent: "claude", windowPct: 20, weekPct: 20 }),
  ]);
  assert.ok(tips.length > 0);
  assert.ok(tips.every((tip) => !tip.title.includes("Grok") && !tip.title.includes("Codex")));
  assert.ok(tips.every((tip) => !tip.body.includes("Grok") && !tip.body.includes("Codex")));
});

test("routing advice for Grok-only never names Claude or Codex", () => {
  const tips = routingAdvice([meter({ agent: "grok", windowPct: 20, weekPct: 20 })]);
  assert.ok(tips.length > 0);
  assert.ok(tips.every((tip) => !tip.title.includes("Claude") && !tip.title.includes("Codex")));
  assert.ok(tips.every((tip) => !tip.body.includes("Claude") && !tip.body.includes("Codex")));
});

test("routing advice for a Claude and Grok pair never names Codex", () => {
  const tips = routingAdvice([
    meter({ agent: "claude", windowPct: 80, weekPct: 20 }),
    meter({ agent: "grok", windowPct: 20, weekPct: 20 }),
  ]);
  assert.ok(tips.some((tip) => tip.title.includes("Claude") || tip.body.includes("Grok")));
  assert.ok(tips.every((tip) => !tip.title.includes("Codex") && !tip.body.includes("Codex")));
});

test("credit formatting is compact and range-first", () => {
  assert.equal(formatCredits(652.7024375), "653");
  assert.equal(formatCreditRange(18_002.592, 24_356.448), "18,003–24,356");
  assert.equal(formatCreditRange(null, 24_356.448), "样本不足");
});

test("Claude always exposes five-hour and weekly sections", () => {
  const sections = apiEquivalentSections("claude", "five_hour", quotaValue(), quotaValue());
  assert.deepEqual(sections.map((section) => section.label), ["5h", "本周"]);
});

test("Grok exposes only its shared weekly section", () => {
  const sections = apiEquivalentSections("grok", "weekly", quotaValue(), quotaValue());
  assert.deepEqual(sections.map((section) => section.label), ["本周"]);
});

test("five-hour primary Codex keeps its five-hour section", () => {
  const sections = apiEquivalentSections("codex", "five_hour", quotaValue(), quotaValue());
  assert.deepEqual(sections.map((section) => section.label), ["5h"]);
});

test("sample-insufficient sections remain visible", () => {
  const none = quotaValue("none");
  const sections = apiEquivalentSections("claude", "five_hour", none, none);
  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.value.confidence, "none");
});

test("Fable sub-limit can raise the Claude card status", () => {
  assert.equal(effectiveQuotaStatus("ok", 90), "critical");
  assert.equal(effectiveQuotaStatus("ok", 75), "watch");
  assert.equal(effectiveQuotaStatus("critical", 10), "critical");
});

test("tightest quota includes a stricter Fable sub-limit", () => {
  const result = tightestQuota([
    { label: "Claude", pct: 30, resetsAt: 10 },
    { label: "Claude Fable 5", pct: 80, resetsAt: 20 },
  ]);
  assert.deepEqual(result, { label: "Claude Fable 5", pct: 80, resetsAt: 20 });
});

const WEEK_RESET = Date.parse("2026-08-26T20:59:00Z");
const FOUR_DAYS_BEFORE = Date.parse("2026-08-22T20:59:00Z");

test("week reset label uses the official clock in Asia/Shanghai", () => {
  assert.equal(
    formatWeekResetLabel(WEEK_RESET, FOUR_DAYS_BEFORE, { timeZone: "Asia/Shanghai" }),
    "周限额刷新 8月27日 04:59 · 4 天 0 小时",
  );
});

test("week reset label stays null without an official timestamp", () => {
  assert.equal(formatWeekResetLabel(null, FOUR_DAYS_BEFORE), null);
  assert.equal(formatWeekResetLabel(0, FOUR_DAYS_BEFORE), null);
  assert.equal(formatWeekResetLabel(Number.NaN, FOUR_DAYS_BEFORE), null);
});

test("past official week reset is marked elapsed instead of a dash", () => {
  assert.equal(
    formatWeekResetLabel(WEEK_RESET, WEEK_RESET + 60_000, { timeZone: "Asia/Shanghai" }),
    "周限额刷新 8月27日 04:59 · 已过",
  );
});

test("Fable prefix does not reuse the generic weekly copy", () => {
  assert.equal(
    formatWeekResetLabel(WEEK_RESET, FOUR_DAYS_BEFORE, {
      timeZone: "Asia/Shanghai",
      prefix: "Fable 5 周限额刷新",
    }),
    "Fable 5 周限额刷新 8月27日 04:59 · 4 天 0 小时",
  );
});

test("Fable alert latch triggers once and unlocks after a 12 point drop", () => {
  assert.deepEqual(quotaAlertLatch(90, 85, false), {
    triggered: true,
    nextWarned: true,
  });
  assert.deepEqual(quotaAlertLatch(90, 85, true), {
    triggered: false,
    nextWarned: true,
  });
  assert.deepEqual(quotaAlertLatch(72, 85, true), {
    triggered: false,
    nextWarned: false,
  });
  assert.deepEqual(quotaAlertLatch(null, 85, true), {
    triggered: false,
    nextWarned: false,
  });
});
