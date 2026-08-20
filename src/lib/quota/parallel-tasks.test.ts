import assert from "node:assert/strict";
import { test } from "node:test";
import { parallelTaskSummary } from "./parallel-tasks.ts";
import type { AgentLiveInfo } from "./types.ts";

function task(sessionId: string): AgentLiveInfo {
  return {
    sessionId,
    cwd: "/tmp",
    task: `任务 ${sessionId}`,
    writing: true,
    lastTs: 1,
    startedAt: 1,
    turns: 1,
  };
}

test("parallelTaskSummary respects paused state and caps the compact list", () => {
  assert.equal(parallelTaskSummary([task("one")], true), null);
  assert.equal(parallelTaskSummary([task("a"), task("b")], false), null);
  const summary = parallelTaskSummary(["a", "b", "c", "d", "e"].map(task), true);
  assert.equal(summary?.total, 5);
  assert.deepEqual(summary?.visible.map((item) => item.sessionId), ["a", "b", "c", "d"]);
  assert.equal(summary?.overflow, 1);
});
