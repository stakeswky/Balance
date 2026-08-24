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
    "orchestrator-analysis-status",
    "orchestrator-error",
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
    "计划已生成，共 2 项任务",
    "分析失败，请查看错误提示",
    "fast-analysis-visible-feedback",
    "navigation-state-preserved",
    "hang",
    "interrupted",
    "BALANCE_REAL_CLI_E2E",
    "--no-proxy-server",
    "--proxy-bypass-list=*",
  ]) {
    assert.match(source, new RegExp(evidence));
  }
  assert.doesNotMatch(source.toLowerCase(), new RegExp(["ge", "mini"].join("")));
  assert.match(source, /taskEventPids\(events\)\.length >= 2/);
  assert.match(source, /taskEventPids\(hanging\.events\)\.filter\(pidAlive\)/);
  assert.match(source, /e2e-source-home/);
  assert.match(source, /HOME: e2eHome/);
  assert.match(source, /CODEX_HOME: e2eCodexHome/);
  assert.match(source, /GROK_HOME: e2eGrokHome/);
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
