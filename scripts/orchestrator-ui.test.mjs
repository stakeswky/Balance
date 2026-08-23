import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("main navigation exposes orchestration and no standalone plugin view", async () => {
  const [header, dashboard] = await Promise.all([
    source("src/components/balance/header.tsx"),
    source("src/components/balance/dashboard.tsx"),
  ]);
  assert.match(header, /id: "orchestrator", label: "调度"/);
  assert.doesNotMatch(header, /id: "plugin"|label: "插件"/);
  assert.match(dashboard, /<OrchestratorPanel quotaEvidence=\{orchestratorQuotaEvidence\}/);
});

test("orchestrator controller uses capability, strict confirmations, incremental polling and history", async () => {
  const client = await source("src/lib/orchestrator/client.ts");
  for (const action of [
    "validateRepository",
    "analyzeOrchestratorPlan",
    "startOrchestratorRun",
    "getOrchestratorRun",
    "cancelOrchestratorRun",
    "listOrchestratorRuns",
  ]) {
    assert.match(client, new RegExp(action));
  }
  assert.match(client, /getOrchestratorAuthorization/);
  assert.match(client, /afterSeq/);
  assert.match(client, /setTimeout\([\s\S]*?\}, 1_000\)/);
  assert.match(client, /trustedRepository: true/);
  assert.match(client, /draft\.repositoryDevice/);
  assert.match(client, /draft\.repositoryInode/);
  assert.match(client, /draft\.baseSha/);
  assert.match(client, /TERMINAL_STATUSES/);
});

test("root boot consumes and removes the desktop capability before onboarding", async () => {
  const root = await source("src/routes/__root.tsx");
  assert.match(root, /getOrchestratorAuthorization/);
  assert.match(root, /useEffect\(\(\) => \{\s*getOrchestratorAuthorization\(\)/);
});

test("workspace renders repository trust, capacity, full plan, execution and recovery details", async () => {
  const panel = await source("src/components/balance/orchestrator-panel.tsx");
  for (const testId of [
    "orchestrator-panel",
    "orchestrator-repository-input",
    "orchestrator-validate",
    "orchestrator-prompt",
    "orchestrator-coordinator",
    "orchestrator-analyze",
    "orchestrator-plan",
    "orchestrator-trust",
    "orchestrator-start",
    "orchestrator-run",
    "orchestrator-cancel",
    "orchestrator-events",
    "orchestrator-history",
  ]) {
    assert.match(panel, new RegExp(`data-testid="${testId}"`));
  }
  for (const detail of [
    "canonicalPath",
    "baseSha",
    "acceptanceCriteria",
    "dependsOn",
    "expectedFiles",
    "verificationCommands",
    "integrationWorktree",
    "capacity_blocked",
    "interrupted",
  ]) {
    assert.match(panel, new RegExp(detail));
  }
  assert.match(panel, /工作目录/);
  assert.match(panel, /最小环境/);
  assert.match(panel, /仅可查看，不能自动续跑/);
});

test("quota evidence chooses a conservative trustworthy dollar window and fresh official fallback", async () => {
  const client = await source("src/lib/orchestrator/client.ts");
  assert.match(client, /value\.confidence === "medium" \|\| value\.confidence === "high"/);
  assert.match(client, /remainingLowUsd \/ value\.totalHighUsd/);
  assert.match(client, /Math\.max\(\.\.\.usedPercentages\)/);
  assert.match(client, /windowStale/);
  assert.match(client, /weekStale/);
  assert.doesNotMatch(client, /enabled|binaryPath|recentSuccessRate/);
});

test("minimal mode regression visits orchestration instead of the removed plugin view", async () => {
  const e2e = await source("scripts/minimal-mode-e2e.mjs");
  assert.match(e2e, /openView\(page, "调度"\)/);
  assert.match(e2e, /data-testid="orchestrator-panel"/);
  assert.doesNotMatch(e2e, /openView\(page, "插件"\)/);
});

test("orchestration product source names exactly the three supported agents", async () => {
  const combined = (
    await Promise.all([
      source("src/components/balance/orchestrator-panel.tsx"),
      source("src/lib/orchestrator/client.ts"),
      source("src/components/balance/dashboard.tsx"),
    ])
  ).join("\n");
  for (const agent of ["claude", "codex", "grok"]) assert.match(combined, new RegExp(agent));
  const retiredName = ["ge", "mini"].join("");
  assert.equal(combined.toLowerCase().includes(retiredName), false);
});
