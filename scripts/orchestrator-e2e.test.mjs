import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("native orchestration E2E covers success, failure, cancellation and restart recovery", async () => {
  const source = await readFile(new URL("./orchestrator-e2e.mjs", import.meta.url), "utf8");
  for (const evidence of [
    "BALANCE_STATE_DIR",
    "BALANCE_ORCHESTRATOR_TOKEN",
    "orchestrator-repository-input",
    "orchestrator-validate",
    "orchestrator-analyze",
    "orchestrator-trust",
    "orchestrator-start",
    "orchestrator-cancel",
    "balance-alpha.txt",
    "balance-beta.txt",
    "process_started",
    "process_completed",
    "nonzero",
    "broken-plan",
    "slow-plan",
    ".balance-plan-started",
    ".balance-plan-release",
    "正在拆解计划",
    "navigation-state-preserved",
    "hang",
    "interrupted",
    "BALANCE_REAL_CLI_E2E",
  ]) {
    assert.match(source, new RegExp(evidence));
  }
  assert.doesNotMatch(source.toLowerCase(), new RegExp(["ge", "mini"].join("")));
});

test("package scripts expose orchestrator E2E and a debug native app build", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts["test:e2e:orchestrator"], "node scripts/orchestrator-e2e.mjs");
  assert.equal(
    packageJson.scripts["test:e2e:orchestrator:desktop"],
    "node scripts/orchestrator-desktop-e2e.mjs",
  );
  assert.equal(
    packageJson.scripts["desktop:build:debug"],
    'tauri build --debug --target aarch64-apple-darwin --bundles app --config \'{"bundle":{"createUpdaterArtifacts":false}}\'',
  );
});
