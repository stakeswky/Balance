import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_PRO_20X_WEEK_TOKEN_FLOOR, inferCodexProPlanId } from "./estimate.ts";

test("pro 20x vs 5x is inferred from calibrated weekly tokens", () => {
  assert.equal(inferCodexProPlanId(CODEX_PRO_20X_WEEK_TOKEN_FLOOR), "chatgpt-pro-20x");
  assert.equal(inferCodexProPlanId(700_000_000), "chatgpt-pro-20x");
  assert.equal(inferCodexProPlanId(180_000_000), "chatgpt-pro-5x");
  assert.equal(inferCodexProPlanId(null), "chatgpt-pro-5x");
});
