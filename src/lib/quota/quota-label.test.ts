import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrationSourceLabel,
  quotaSourceLabel,
  quotaSourceMessage,
  quotaValueDiagnostics,
} from "./quota-label.ts";
import type { QuotaValue } from "./quota-value.ts";

const quotaValueFixture: QuotaValue = {
  usedPct: 50,
  l1Usd: 10,
  l1Credits: null,
  l1Tokens: 100000,
  pricedTokenCoverage: 1,
  pricedEventCoverage: 1,
  rolling: false,
  windowId: "test-window",
  totalLowUsd: 18,
  totalPointUsd: 20,
  totalHighUsd: 22,
  remainingLowUsd: 8,
  remainingPointUsd: 10,
  remainingHighUsd: 12,
  totalLowCredits: null,
  totalPointCredits: null,
  totalHighCredits: null,
  remainingLowCredits: null,
  remainingPointCredits: null,
  remainingHighCredits: null,
  confidence: "high",
  calibrationSource: "current-window",
  pricingVersion: "2026-08-21",
  externalUsageDetected: false,
  anomalousPairs: 0,
  historyComplete: true,
};

test("quota source labels distinguish official, snapshot, and local estimates", () => {
  assert.equal(quotaSourceLabel("5 小时窗", "official"), "5 小时窗（官方）");
  assert.equal(quotaSourceLabel("本周额度", "official-stale"), "本周额度（官方快照）");
  assert.equal(quotaSourceLabel("5 小时窗", "local-estimate"), "5 小时窗用量（本地估算）");
  assert.equal(quotaSourceLabel("本周额度", "local-estimate"), "本周用量（本地估算）");
});

test("loading copy identifies the temporary local estimate", () => {
  assert.equal(
    quotaSourceMessage("loading", false, true, false),
    "正在读取官方额度；当前显示本地估算。",
  );
});

test("error copy never presents a local estimate as official quota", () => {
  assert.equal(
    quotaSourceMessage("error", false, true, false),
    "官方额度读取失败；当前显示本地估算。",
  );
});

test("partial official copy labels missing fields as local estimates", () => {
  assert.equal(
    quotaSourceMessage("ready", true, true, false),
    "部分官方额度暂未返回；缺失项显示本地估算。",
  );
});

test("stale copy identifies values from the last successful read", () => {
  assert.equal(
    quotaSourceMessage("ready", false, false, true),
    "官方接口暂不可用；标为“官方快照”的值来自上次成功读取。",
  );
});

test("fully official data needs no explanatory message", () => {
  assert.equal(quotaSourceMessage("ready", true, false, false), null);
});

test("calibration labels distinguish current samples from historical priors", () => {
  assert.equal(calibrationSourceLabel("current-window"), "当前窗口样本");
  assert.equal(calibrationSourceLabel("historical-prior"), "历史窗口先验");
  assert.equal(calibrationSourceLabel("none"), "无可用校准");
});

test("quota diagnostics expose truncation and both coverage dimensions", () => {
  const messages = quotaValueDiagnostics({
    ...quotaValueFixture,
    historyComplete: false,
    pricedTokenCoverage: 0.79,
    pricedEventCoverage: 0.75,
    calibrationSource: "historical-prior",
    externalUsageDetected: true,
  });
  assert.deepEqual(messages, [
    "本地校准历史已截断，区间已关闭",
    "可计价 token 覆盖率不足 80%",
    "可计价事件覆盖率不足 80%",
    "检测到本机日志之外的额度消耗",
    "当前窗口样本不足，暂用同套餐历史窗口先验",
  ]);
});

