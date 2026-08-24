import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunStore } from "./run-store.server.ts";
import { analyzePlan, type AnalyzeRequest, type PlannerDependencies } from "./planner.server.ts";
import { buildTrustedQuotaSnapshot } from "./quota-policy.ts";
import { defaultOrchestratorSettings } from "./settings.server.ts";
import type { OfficialSlice } from "../quota/official.ts";
import type {
  AgentRuntimeProbe,
  ClientQuotaEvidence,
  NativeAgentId,
  OrchestratorPlan,
} from "./types.ts";

const NOW = Date.UTC(2026, 7, 24, 13, 14, 15);

function evidence(officialRemainingPct: number): ClientQuotaEvidence {
  return {
    officialRemainingPct,
    officialObservedAt: NOW,
    officialResetsAt: NOW + 60_000,
    officialFresh: true,
    officialSource: "client-display",
    l3RemainingPct: null,
    l3Confidence: "none",
    l3ObservedAt: null,
  };
}

function officialSlice(agent: NativeAgentId, remainingPct: number): OfficialSlice {
  return {
    agent, windowPct: 100 - remainingPct, weekPct: null,
    windowResetsAt: NOW + 60_000, weekResetsAt: null, weekStartedAt: null,
    windowDurationMs: 5 * 60 * 60 * 1_000, weekDurationMs: null, burnPctPerHour: 0,
    planLabel: null, products: [], prepaidBalance: null, onDemandUsed: null, onDemandCap: null,
    source: "test", fetchedAt: NOW, windowKind: "five_hour",
  };
}

function validPlan(): OrchestratorPlan {
  return {
    title: "Build API",
    summary: "Implement and test two isolated parts.",
    tasks: [
      {
        id: "api",
        title: "API",
        description: "Implement the API handler.",
        size: "small",
        priority: "critical",
        splittable: false,
        preferredAgent: null,
        dependsOn: [],
        expectedFiles: ["src/api/index.ts"],
        acceptanceCriteria: ["Returns 200"],
        verificationCommands: [{ executable: "npm", args: ["run", "test:api"] }],
      },
      {
        id: "api-test",
        title: "API test",
        description: "Add API coverage.",
        size: "small",
        priority: "high",
        splittable: true,
        preferredAgent: "codex",
        dependsOn: [],
        expectedFiles: ["src/api/index.ts"],
        acceptanceCriteria: ["Regression is covered"],
        verificationCommands: [{ executable: "git", args: ["diff", "--check"] }],
      },
    ],
  };
}

const runtimePaths: Record<NativeAgentId, string> = {
  claude: "/native/claude",
  codex: "/native/codex",
  grok: "/native/grok",
};

function probe(agent: NativeAgentId, ok = true): AgentRuntimeProbe {
  return {
    agent,
    ok,
    path: ok ? runtimePaths[agent] : null,
    version: ok ? `${agent} 1.0` : null,
    error: ok ? null : "not installed",
  };
}

async function harness(
  outputs: string[],
  options: {
    runtimeOverrides?: Partial<Record<NativeAgentId, AgentRuntimeProbe>>;
    official?: Partial<Record<NativeAgentId, number>>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "balance-planner-"));
  const store = createRunStore(root);
  await store.initialize();
  const calls: Array<{ agent: NativeAgentId; prompt: string; args: string[] }> = [];
  const inspections: Array<{ path: string; mode: "analyze" }> = [];
  const schemaCalls: Array<{ runId: string; schema: object }> = [];
  let outputIndex = 0;
  const runtimes = {
    claude: options.runtimeOverrides?.claude ?? probe("claude"),
    codex: options.runtimeOverrides?.codex ?? probe("codex"),
    grok: options.runtimeOverrides?.grok ?? probe("grok"),
  };
  const settings = defaultOrchestratorSettings();
  const dependencies: PlannerDependencies = {
    async inspectRepository(path, mode) {
      inspections.push({ path, mode });
      return {
        root: "/repo/project",
        device: 101,
        inode: 202,
        branch: "main",
        head: "a".repeat(40),
        dirty: false,
      };
    },
    async runtimeFor(agent) {
      return runtimes[agent];
    },
    async runPlanCommand(input) {
      calls.push({
        agent: input.agent,
        prompt: input.command.args.join(" "),
        args: input.command.args,
      });
      const line = outputs[outputIndex++] ?? outputs.at(-1)!;
      return {
        exitCode: 0,
        stdoutLines: [line],
        events: [
          { type: "session_started" as const, sessionId: `planning-${outputIndex}` },
          {
            type: "usage" as const,
            inputTokens: 100 * outputIndex,
            outputTokens: 20 * outputIndex,
            cachedInputTokens: 10 * outputIndex,
          },
        ],
      };
    },
    async createSchemaFile(runId, schema) {
      schemaCalls.push({ runId, schema });
      return join(root, "runs", runId, "plan-schema.json");
    },
    async recentSuccessRates() {
      return {
        claude: { planningSuccessRate: 0.8, executionSuccessRate: 0.8, repairSuccessRate: null },
        codex: { planningSuccessRate: 0.9, executionSuccessRate: 0.9, repairSuccessRate: null },
        grok: { planningSuccessRate: null, executionSuccessRate: null, repairSuccessRate: null },
      };
    },
    async refreshQuotaSnapshot(input) {
      return buildTrustedQuotaSnapshot({
        ...input,
        officialQuota: {
          claude: officialSlice("claude", options.official?.claude ?? 80),
          codex: officialSlice("codex", options.official?.codex ?? 60),
          grok: officialSlice("grok", options.official?.grok ?? 40),
        },
      });
    },
    async loadSettings() {
      return settings;
    },
    async detectRuntimes() {
      return runtimes;
    },
    store,
    now: () => NOW,
    randomHex: (bytes) => {
      assert.equal(bytes, 6);
      return "a1b2c3d4e5f6";
    },
  };
  const request: AnalyzeRequest = {
    repositoryPath: "/repo/project",
    prompt: "Build the API",
    coordinator: "auto",
    quotaEvidence: {
      claude: evidence(options.official?.claude ?? 80),
      codex: evidence(options.official?.codex ?? 60),
      grok: evidence(options.official?.grok ?? 40),
    },
  };
  return { root, store, calls, inspections, schemaCalls, dependencies, request };
}

test("generates a confirmable draft with server-selected coordinator and preserved verification", async () => {
  const plan = validPlan();
  const h = await harness([JSON.stringify({ structured_output: plan })]);
  const draft = await analyzePlan(h.request, h.dependencies);
  assert.equal(draft.runId, "run_20260824131415_a1b2c3d4e5f6");
  assert.equal(draft.coordinator, "claude");
  assert.equal(draft.repositoryPath, "/repo/project");
  assert.equal(draft.assignedTasks.length, 2);
  assert.deepEqual(draft.plan.tasks[0]!.verificationCommands, [
    { executable: "npm", args: ["run", "test:api"] },
  ]);
  assert.equal(
    draft.plan.tasks[1]!.dependsOn.includes("api"),
    true,
    "overlapping files must serialize",
  );
  assert.match(draft.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(h.inspections, [{ path: "/repo/project", mode: "analyze" }]);
  assert.equal(h.schemaCalls.length, 1);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]!.prompt, /only analyze|只分析/i);
  assert.match(h.calls[0]!.prompt, /Claude.*Codex.*Grok|claude.*codex.*grok/i);
  assert.match(h.calls[0]!.prompt, /claude, codex, and grok/i);
  assert.match(h.calls[0]!.prompt, /capacity envelope/i);
  assert.match(h.calls[0]!.prompt, /executionUnits|execution_units/i);
  assert.match(h.calls[0]!.prompt, /globalMaxConcurrency|global_max_concurrency/i);
  assert.doesNotMatch(h.calls[0]!.prompt, /\/native\/(claude|codex|grok)/i);
  const stored = await h.store.get(draft.runId);
  assert.equal(stored?.status, "draft");
  assert.deepEqual(stored?.draft, draft);
  assert.equal(
    stored?.tasks.every((task) => task.status === "queued"),
    true,
  );
  const activities = await h.store.activities({ agent: "claude", role: "planning", limit: 20 });
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.success, true);
  assert.equal(activities[0]?.sessionId, "planning-1");
  assert.deepEqual(activities[0]?.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
  });
  const planningEvents = await h.store.events(draft.runId);
  assert.deepEqual(planningEvents.map((record) => record.event.type), ["session_started", "usage"]);
});

test("honors an eligible manual coordinator and rejects an unavailable one", async () => {
  const plan = validPlan();
  const manual = await harness([JSON.stringify({ structured_output: plan })]);
  manual.request.coordinator = "codex";
  const draft = await analyzePlan(manual.request, manual.dependencies);
  assert.equal(draft.coordinator, "codex");
  assert.equal(manual.calls[0]!.agent, "codex");

  const unavailable = await harness([JSON.stringify({ structured_output: plan })], {
    runtimeOverrides: { codex: probe("codex", false) },
  });
  unavailable.request.coordinator = "codex";
  await assert.rejects(
    () => analyzePlan(unavailable.request, unavailable.dependencies),
    /coordinator|eligible|available/i,
  );
  assert.deepEqual(await unavailable.store.list(), []);
});

test("retries one invalid structure with bounded Zod issues and creates no half-run after two failures", async () => {
  const plan = validPlan();
  const invalid = JSON.stringify({
    structured_output: { ...plan, tasks: [{ ...plan.tasks[0], size: "huge" }] },
  });
  const repaired = await harness([invalid, JSON.stringify({ structured_output: plan })]);
  const draft = await analyzePlan(repaired.request, repaired.dependencies);
  assert.equal(repaired.calls.length, 2);
  assert.match(repaired.calls[1]!.prompt, /validation|校验|issue/i);
  assert.doesNotMatch(repaired.calls[1]!.prompt, /HOME=|API_KEY|TOKEN=/i);
  assert.ok(await repaired.store.get(draft.runId));

  const failed = await harness([invalid, invalid]);
  await assert.rejects(
    () => analyzePlan(failed.request, failed.dependencies),
    /two|twice|两次|invalid/i,
  );
  assert.equal(failed.calls.length, 2);
  assert.deepEqual(await failed.store.list(), []);
  assert.deepEqual(
    (await failed.store.activities({ role: "planning", limit: 20 }))
      .map((record) => record.success),
    [false, false],
  );
});

test("keeps the full plan visible while waiting for quota", async () => {
  const plan = validPlan();
  plan.tasks[0]!.size = "large";
  plan.tasks[1]!.size = "large";
  const h = await harness([JSON.stringify({ structured_output: plan })], {
    official: { claude: 10, codex: 10, grok: 10 },
  });
  const draft = await analyzePlan(h.request, h.dependencies);
  assert.deepEqual(draft.runnableTasks, []);
  assert.equal(draft.plan.tasks.length, 2);
  assert.equal(draft.deferredTasks?.length, 2);
  const stored = await h.store.get(draft.runId);
  assert.equal(stored?.status, "waiting_quota");
  assert.equal(stored?.tasks.length, 2);
  assert.equal(stored?.tasks.every((task) => task.status === "blocked"), true);
});

test("rejects forged or non-finite quota evidence before running a native planner", async () => {
  const h = await harness([JSON.stringify({ structured_output: validPlan() })]);
  h.request.quotaEvidence.claude.officialRemainingPct = Number.NaN;
  await assert.rejects(
    () => analyzePlan(h.request, h.dependencies),
    /quota|finite|number|evidence/i,
  );
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.store.list(), []);

  const forged = await harness([JSON.stringify({ structured_output: validPlan() })]);
  (forged.request.quotaEvidence.claude as ClientQuotaEvidence & { enabled: boolean }).enabled =
    true;
  await assert.rejects(
    () => analyzePlan(forged.request, forged.dependencies),
    /quota|unrecognized|evidence/i,
  );
  assert.equal(forged.calls.length, 0);
});

test("persists planning session and usage when the native planner process fails", async () => {
  const h = await harness([JSON.stringify({ structured_output: validPlan() })]);
  h.dependencies.runPlanCommand = async () => ({
    exitCode: 7,
    stdoutLines: [],
    events: [
      { type: "session_started", sessionId: "failed-session" },
      { type: "usage", inputTokens: 55, outputTokens: 5, cachedInputTokens: 3 },
    ],
  });

  await assert.rejects(() => analyzePlan(h.request, h.dependencies), /exited with code 7/i);
  assert.deepEqual(await h.store.list(), []);
  const activity = (await h.store.activities({ role: "planning", limit: 20 }))[0];
  assert.equal(activity?.success, false);
  assert.equal(activity?.sessionId, "failed-session");
  assert.deepEqual(activity?.usage, {
    inputTokens: 55,
    outputTokens: 5,
    cachedInputTokens: 3,
  });
});

test("refreshes quota after planning before assigning execution work", async () => {
  const h = await harness([JSON.stringify({ structured_output: validPlan() })]);
  let refreshes = 0;
  h.dependencies.refreshQuotaSnapshot = async (input) => {
    refreshes += 1;
    const remaining = refreshes === 1 ? 80 : 0;
    return buildTrustedQuotaSnapshot({
      ...input,
      officialQuota: {
        claude: officialSlice("claude", remaining),
        codex: officialSlice("codex", remaining),
        grok: officialSlice("grok", remaining),
      },
    });
  };

  const draft = await analyzePlan(h.request, h.dependencies);
  assert.equal(refreshes, 2);
  assert.deepEqual(draft.assignedTasks, []);
  assert.equal(draft.quotaSnapshot?.evidence.codex.officialRemainingPct, 0);
  assert.equal((await h.store.get(draft.runId))?.status, "waiting_quota");
});
