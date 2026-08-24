import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { orchestratorActionInputSchemas } from "./actions.ts";
import { isOrchestratorCapabilityAllowed } from "./request-guard.server.ts";

const authorization = "local-capability";
const runId = "run_20260824123045_a1b2c3d4e5f6";
const repositoryPath = "/tmp/balance-orchestrator-repository";
const baseSha = "a".repeat(40);
const quotaEvidence = {
  officialRemainingPct: 50,
  officialObservedAt: Date.now(),
  officialResetsAt: Date.now() + 60_000,
  officialFresh: true,
  officialSource: "test-official",
  l3RemainingPct: 40,
  l3Confidence: "high" as const,
  l3ObservedAt: Date.now(),
};

test("desktop capability comparison fails closed and accepts only an exact token", () => {
  assert.equal(isOrchestratorCapabilityAllowed(authorization, undefined), false);
  assert.equal(isOrchestratorCapabilityAllowed(authorization, ""), false);
  assert.equal(isOrchestratorCapabilityAllowed(authorization, "wrong"), false);
  assert.equal(isOrchestratorCapabilityAllowed(authorization, authorization), true);
  assert.equal(isOrchestratorCapabilityAllowed("x".repeat(129), "x".repeat(129)), false);
});

test("action schemas are strict and reject unsafe repository and plan input", () => {
  assert.throws(() =>
    orchestratorActionInputSchemas.getSettings.parse({
      authorization,
      extra: true,
    }),
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.validateRepository.parse({
      authorization,
      repoPath: "/tmp/unsafe\0path",
    }),
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.analyzePlan.parse({
      authorization,
      repositoryPath,
      prompt: " ",
      coordinator: "auto",
      quotaEvidence: { claude: quotaEvidence, codex: quotaEvidence, grok: quotaEvidence },
    }),
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.analyzePlan.parse({
      authorization,
      repositoryPath,
      prompt: "implement the plan",
      coordinator: "unsupported-agent",
      quotaEvidence: { claude: quotaEvidence, codex: quotaEvidence, grok: quotaEvidence },
    }),
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.startRun.parse({
      authorization,
      runId,
      fingerprint: "b".repeat(64),
      trustedRepository: false,
      confirmedRepository: { path: repositoryPath, device: 1, inode: 2, baseSha },
    }),
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.analyzePlan.parse({
      authorization,
      repositoryPath,
      prompt: "implement the plan",
      coordinator: "auto",
      quotaEvidence: { claude: quotaEvidence, codex: quotaEvidence, grok: quotaEvidence },
      enabled: true,
    }),
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.analyzePlan.parse({
      authorization,
      repositoryPath,
      prompt: "implement the plan",
      coordinator: "auto",
      quotaEvidence: {
        claude: { ...quotaEvidence, officialObservedAt: Date.now() + 60_000 },
        codex: quotaEvidence,
        grok: quotaEvidence,
      },
    }),
    /future/i,
  );
  assert.throws(() =>
    orchestratorActionInputSchemas.analyzePlan.parse({
      authorization,
      repositoryPath,
      prompt: "implement the plan",
      coordinator: "auto",
      quotaEvidence: {
        claude: { ...quotaEvidence, enabled: true },
        codex: quotaEvidence,
        grok: quotaEvidence,
      },
    }),
    /unrecognized|unknown/i,
  );
});

test("valid analyze, start and incremental event requests retain their safe fields", () => {
  const analyze = orchestratorActionInputSchemas.analyzePlan.parse({
    authorization,
    repositoryPath,
    prompt: "implement the plan",
    coordinator: "codex",
    quotaEvidence: { claude: quotaEvidence, codex: quotaEvidence, grok: quotaEvidence },
  });
  assert.equal(analyze.coordinator, "codex");

  const start = orchestratorActionInputSchemas.startRun.parse({
    authorization,
    runId,
    fingerprint: "b".repeat(64),
    trustedRepository: true,
    confirmedRepository: { path: repositoryPath, device: 1, inode: 2, baseSha },
  });
  assert.equal(start.trustedRepository, true);

  const continuation = orchestratorActionInputSchemas.continueRun.parse({
    ...start,
    quotaEvidence: { claude: quotaEvidence, codex: quotaEvidence, grok: quotaEvidence },
  });
  assert.equal(continuation.quotaEvidence.codex.officialRemainingPct, 50);

  const get = orchestratorActionInputSchemas.getRun.parse({ authorization, runId, afterSeq: 12 });
  assert.equal(get.afterSeq, 12);
  assert.throws(() =>
    orchestratorActionInputSchemas.getRun.parse({ authorization, runId, afterSeq: -1 }),
  );
});

test("all ten orchestration actions are POST-only and invoke the combined guard", async () => {
  const source = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
  const guardSource = await readFile(new URL("./request-guard.server.ts", import.meta.url), "utf8");
  const postActions = source.match(/createServerFn\(\{ method: "POST" \}\)/g) ?? [];
  const guards = source.match(/assertOrchestratorRequestAllowed\(data\.authorization\)/g) ?? [];
  assert.equal(postActions.length, 10);
  assert.equal(guards.length, 10);
  for (const name of [
    "getNativeAgentSettings",
    "saveNativeAgentSettings",
    "detectNativeAgentRuntimes",
    "validateRepository",
    "analyzeOrchestratorPlan",
    "startOrchestratorRun",
    "refreshAndContinueOrchestratorRun",
    "getOrchestratorRun",
    "cancelOrchestratorRun",
    "listOrchestratorRuns",
  ]) {
    assert.match(source, new RegExp(`export const ${name} = createServerFn`));
  }
  assert.match(guardSource, /assertQuotaRequestAllowed\(\)/);
  assert.match(guardSource, /timingSafeEqual/);
});

test("the HMR singleton stores one supervisor promise and exposes a shutdown hook", async () => {
  const source = await readFile(new URL("./supervisor.server.ts", import.meta.url), "utf8");
  assert.match(source, /__balanceOrchestratorSupervisorPromise__\s*\?\?=/);
  assert.match(source, /__balanceOrchestratorSupervisorPromise__ = undefined/);
  assert.match(source, /Symbol\.for\("balance\.orchestrator\.shutdown"\)/);
  assert.match(source, /recoverInterrupted\(\)/);
  assert.match(source, /#active\.has\(input\.runId\)/);
  assert.doesNotMatch(source, /authorization|BALANCE_ORCHESTRATOR_TOKEN|process\.env\[/);
});

test("client snapshots expose normalized events without raw process buffers", async () => {
  const source = await readFile(new URL("./supervisor.server.ts", import.meta.url), "utf8");
  const snapshot = source.slice(
    source.indexOf("export interface RunSnapshot"),
    source.indexOf("export interface RunSummary"),
  );
  assert.match(snapshot, /events: RunEventRecord\[\]/);
  assert.match(snapshot, /nextSeq: number/);
  assert.doesNotMatch(snapshot, /stdout|stderr|env|secret|authorization/i);
});
