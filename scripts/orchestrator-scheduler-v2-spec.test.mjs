import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const SPEC_PATH = resolve(
  import.meta.dirname,
  "../docs/specs/2026-08-24-balance-orchestrator-scheduler-v2.md",
);

test("Scheduler V2 specification fixes execution, quota and partial scheduling invariants", () => {
  const spec = readFileSync(SPEC_PATH, "utf8");
  for (const required of [
    "传递依赖基线",
    "进程级 Agent lease",
    "新鲜官方额度决定硬准入",
    "planning / execution / repair",
    "跨 run 软预订",
    "完整计划与当前批次分离",
    "partial_ready",
    "waiting_quota",
    "partial_completed",
    "unschedulable",
    "旧 run 迁移",
    "用户 checkout 永远不修改",
  ]) {
    assert.match(spec, new RegExp(required.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(spec, /负责人预留 20%|coordinator[^\n]*0\.8/i);
});

test("Scheduler V2 specification contains auditable acceptance matrices", () => {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const originalRows = spec.match(/^\| O\d{2} \|/gm) ?? [];
  const schedulerRows = spec.match(/^\| V\d{2} \|/gm) ?? [];
  assert.equal(originalRows.length, 18);
  assert.equal(schedulerRows.length, 18);
  assert.match(spec, /\| 编号 \| 不变量或验收行为 \| 实现步骤 \| 自动测试 \| 运行时证据 \|/);
});
