import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const algorithm = readFileSync("docs/subscription-quota-value-algorithm.md", "utf8");
const desktop = readFileSync("docs/macos-desktop.md", "utf8");

test("quota docs record the new correctness gates", () => {
  for (const phrase of [
    "fetchedAt",
    "锚点链式差分",
    "加权 MAD",
    "历史窗口先验",
    "可计价事件覆盖率",
    "extra_usage",
    "Theil–Sen 离线 shadow",
  ]) assert.ok(algorithm.includes(phrase), `algorithm doc missing: ${phrase}`);
});

test("desktop docs record the sanitized cache boundary", () => {
  for (const phrase of ["0600", "8 天", "不保存 prompt", "删除后可从本地日志恢复"]) {
    assert.ok(desktop.includes(phrase), `desktop doc missing: ${phrase}`);
  }
});
