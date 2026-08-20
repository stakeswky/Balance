import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaSourceLabel, quotaSourceMessage } from "./quota-label.ts";

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

