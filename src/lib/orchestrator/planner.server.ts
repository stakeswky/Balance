import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { buildPlanCommand, extractStructuredPlan, type AgentCommand } from "./adapters.ts";
import { chooseCoordinator, TASK_UNITS } from "./capacity.ts";
import { selectScheduleBatch } from "./batch-selector.ts";
import type { RepositorySnapshot } from "./git.server.ts";
import type { buildTrustedQuotaSnapshot } from "./quota-policy.ts";
import {
  fingerprintPlan,
  orchestratorPlanJsonSchema,
  parseOrchestratorPlan,
  serializeOverlappingTasks,
} from "./plan.ts";
import { clientQuotaEvidenceSchema } from "./schemas.ts";
import type { RunStore } from "./run-store.server.ts";
import type {
  AgentRuntimeProbe,
  AgentSchedulingProfile,
  ClientQuotaEvidence,
  CoordinatorChoice,
  NativeAgentId,
  OrchestratorEvent,
  OrchestratorPlan,
  OrchestratorRun,
  OrchestratorSettings,
  PlanDraft,
  RoleSuccessRates,
} from "./types.ts";

const agentSchema = z.enum(["claude", "codex", "grok"]);
export { clientQuotaEvidenceSchema } from "./schemas.ts";
export const analyzeRequestSchema = z
  .object({
    repositoryPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, "repository path must be absolute"),
    prompt: z.string().trim().min(1).max(100_000),
    coordinator: z.union([z.literal("auto"), agentSchema]),
    quotaEvidence: z
      .object({
        claude: clientQuotaEvidenceSchema,
        codex: clientQuotaEvidenceSchema,
        grok: clientQuotaEvidenceSchema,
      })
      .strict(),
  })
  .strict();

export interface AnalyzeRequest {
  repositoryPath: string;
  prompt: string;
  coordinator: CoordinatorChoice;
  quotaEvidence: Record<NativeAgentId, ClientQuotaEvidence>;
}

export interface PlannerDependencies {
  inspectRepository(path: string, mode: "analyze"): Promise<RepositorySnapshot>;
  runtimeFor(agent: NativeAgentId): Promise<AgentRuntimeProbe>;
  runPlanCommand(input: {
    command: AgentCommand;
    agent: NativeAgentId;
    signal: AbortSignal;
    runId: string;
    attempt: number;
  }): Promise<{ exitCode: number; stdoutLines: string[]; events: OrchestratorEvent[] }>;
  createSchemaFile(runId: string, schema: object): Promise<string>;
  recentSuccessRates(): Promise<Record<NativeAgentId, RoleSuccessRates>>;
  refreshQuotaSnapshot(input: {
    clientEvidence: Record<NativeAgentId, ClientQuotaEvidence>;
    runtimes: Record<NativeAgentId, AgentRuntimeProbe>;
    settings: OrchestratorSettings;
    roleSuccessRates: Record<NativeAgentId, RoleSuccessRates>;
    now: number;
  }): Promise<ReturnType<typeof buildTrustedQuotaSnapshot>>;
  loadSettings(): Promise<OrchestratorSettings>;
  detectRuntimes(settings: OrchestratorSettings): Promise<Record<NativeAgentId, AgentRuntimeProbe>>;
  store: RunStore;
  now(): number;
  randomHex(bytes: number): string;
}

function runIdAt(timestamp: number, randomHex: string): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error("planner time must be a nonnegative integer");
  if (!/^[0-9a-f]{12}$/.test(randomHex))
    throw new Error("planner randomness must be 12 lowercase hex characters");
  const compact = new Date(timestamp).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `run_${compact}_${randomHex}`;
}

function plannerPrompt(
  userPrompt: string,
  repairIssues: unknown[] | null,
  capacityEnvelope: {
    profiles: readonly AgentSchedulingProfile[];
    capturedAt: number;
    globalMaxConcurrency: number;
  },
): string {
  const availableAgents = capacityEnvelope.profiles.map((profile) => ({
    agent: profile.agent,
    canPlan: profile.canPlan,
    canExecute: profile.canExecute,
    canRepair: profile.canRepair,
    executionUnits: profile.executionUnits,
    officialObservedAt: profile.officialObservedAt,
    officialResetsAt: profile.officialResetsAt,
    exclusionReasons: profile.exclusionReasons,
  }));
  const executable = availableAgents.filter((profile) => profile.canExecute);
  const boundary = [
    "You are the Balance planning coordinator. Only analyze the repository; do not modify files, run mutating commands, or request credentials.",
    "Return only one object matching the supplied strict JSON Schema. Create 1-12 tasks.",
    "Every task must declare description, size, priority, splittable, dependsOn, expectedFiles, acceptanceCriteria, structured verificationCommands, and preferredAgent.",
    "Use small for a local single goal with few files and low context; medium for one complete module or independently verifiable vertical slice; large only for cross-module or high-context work that cannot be split safely.",
    "Minimize unnecessary task count. Prefer independently verifiable vertical slices and never inflate a simple request into many medium or large tasks.",
    "Return the complete roadmap even when current capacity cannot execute all of it. Mark priority as critical, high, or normal and mark whether each task can be safely split.",
    "File scope, acceptance criteria, and dependencies must be explicit. preferredAgent is advisory; the deterministic local scheduler makes final assignments.",
    "The only supported Agent values are claude, codex, and grok (Claude, Codex, Grok).",
    `Current trusted capacity envelope:\n${JSON.stringify({
      availableAgents,
      maximumSingleTaskUnits: Math.max(0, ...executable.map((profile) => profile.executionUnits)),
      totalExecutionUnits: executable.reduce((sum, profile) => sum + profile.executionUnits, 0),
      globalMaxConcurrency: capacityEnvelope.globalMaxConcurrency,
      perAgentMaxConcurrency: 1,
      capturedAt: capacityEnvelope.capturedAt,
    })}`,
    "Verification commands must be necessary, deterministic, and safe to run only after explicit user confirmation.",
    `User request:\n${userPrompt}`,
  ];
  if (repairIssues) {
    boundary.push(
      `The previous structure failed validation. Repair only these bounded validation issues and return a complete replacement object:\n${JSON.stringify(repairIssues).slice(0, 8_000)}`,
    );
  }
  return boundary.join("\n\n");
}

function validationIssues(error: unknown): unknown[] {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 50).map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message.slice(0, 1_000),
    }));
  }
  return [
    {
      path: [],
      code: "invalid_output",
      message: error instanceof Error ? error.message.slice(0, 1_000) : "invalid output",
    },
  ];
}

function validateSuccessRates(
  input: Record<NativeAgentId, RoleSuccessRates>,
): Record<NativeAgentId, RoleSuccessRates> {
  const rate = z.number().finite().min(0).max(1).nullable();
  const roleRates = z.object({
    planningSuccessRate: rate,
    executionSuccessRate: rate,
    repairSuccessRate: rate,
  }).strict();
  return z.object({ claude: roleRates, codex: roleRates, grok: roleRates }).strict().parse(input);
}

function planningActivity(events: readonly OrchestratorEvent[]) {
  let sessionId: string | null = null;
  for (const event of events) {
    if (event.type === "session_started") sessionId = event.sessionId;
  }
  const usageEvents = events.filter((event) => event.type === "usage");
  const usage = usageEvents.length === 0 ? null : usageEvents.reduce((total, event) => ({
    inputTokens: total.inputTokens + event.inputTokens,
    outputTokens: total.outputTokens + event.outputTokens,
    cachedInputTokens: total.cachedInputTokens + event.cachedInputTokens,
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  return { sessionId, usage };
}

function boundedSplitPrompt(
  plan: OrchestratorPlan,
  taskIds: readonly string[],
  maximumTaskUnits: number,
): string {
  return [
    "The validated plan contains splittable tasks that exceed every Agent's current single-task capacity.",
    `Split only these task IDs once: ${taskIds.join(", ")}.`,
    `Every replacement task must require at most ${maximumTaskUnits} capacity units using small=1, medium=3, large=6.`,
    "Preserve the title, summary, every unrelated task byte-for-byte in meaning and fields, and all user goals.",
    "Return one complete replacement plan matching the strict JSON Schema. Do not modify files or request credentials.",
    `Current plan:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

export async function analyzePlan(
  input: AnalyzeRequest,
  dependencies: PlannerDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<PlanDraft> {
  let request: AnalyzeRequest;
  try {
    request = analyzeRequestSchema.parse(input) as AnalyzeRequest;
  } catch (error) {
    throw new Error(
      `invalid quota evidence or analyze request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const now = dependencies.now();
  const runId = runIdAt(now, dependencies.randomHex(6));
  const repository = await dependencies.inspectRepository(request.repositoryPath, "analyze");
  const settings = await dependencies.loadSettings();
  const runtimes = await dependencies.detectRuntimes(settings);
  const successRates = validateSuccessRates(await dependencies.recentSuccessRates());
  const planningQuota = await dependencies.refreshQuotaSnapshot({
    clientEvidence: request.quotaEvidence,
    runtimes,
    settings,
    roleSuccessRates: successRates,
    now,
  });
  const coordinator = chooseCoordinator(planningQuota.profiles, request.coordinator);
  const coordinatorRuntime = await dependencies.runtimeFor(coordinator);
  if (!coordinatorRuntime.ok || !coordinatorRuntime.path) {
    throw new Error(`selected coordinator ${coordinator} is not available`);
  }
  const schemaPath = await dependencies.createSchemaFile(
    runId,
    orchestratorPlanJsonSchema as object,
  );
  if (!isAbsolute(schemaPath)) throw new Error("planner schema file must use an absolute path");
  const inlineSchema = JSON.stringify(orchestratorPlanJsonSchema);
  let parsedPlan = null;
  let issues: unknown[] | null = null;
  const planningEvents: OrchestratorEvent[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = plannerPrompt(request.prompt, issues, {
      profiles: planningQuota.profiles,
      capturedAt: planningQuota.snapshot.capturedAt,
      globalMaxConcurrency: settings.globalMaxConcurrency,
    });
    const command = buildPlanCommand({
      agent: coordinator,
      binaryPath: coordinatorRuntime.path,
      repositoryPath: repository.root,
      prompt,
      schemaPath,
      inlineSchema,
    });
    const startedAt = dependencies.now();
    let result: Awaited<ReturnType<PlannerDependencies["runPlanCommand"]>>;
    try {
      result = await dependencies.runPlanCommand({
        command,
        agent: coordinator,
        signal,
        runId,
        attempt,
      });
    } catch (error) {
      const finishedAt = Math.max(dependencies.now(), startedAt);
      await dependencies.store.appendActivity({
        runId,
        taskId: null,
        agent: coordinator,
        role: "planning",
        startedAt,
        finishedAt,
        success: false,
        sessionId: null,
        usage: null,
        events: [],
      });
      throw error;
    }
    planningEvents.push(...result.events);
    if (result.exitCode !== 0) {
      const { sessionId, usage } = planningActivity(result.events);
      await dependencies.store.appendActivity({
        runId,
        taskId: null,
        agent: coordinator,
        role: "planning",
        startedAt,
        finishedAt: Math.max(dependencies.now(), startedAt),
        success: false,
        sessionId,
        usage,
        events: result.events,
      });
      throw new Error(`planner exited with code ${result.exitCode}`);
    }
    let succeeded = false;
    try {
      parsedPlan = parseOrchestratorPlan(extractStructuredPlan(coordinator, result.stdoutLines));
      succeeded = true;
    } catch (error) {
      issues = validationIssues(error);
    }
    const { sessionId, usage } = planningActivity(result.events);
    await dependencies.store.appendActivity({
      runId,
      taskId: null,
      agent: coordinator,
      role: "planning",
      startedAt,
      finishedAt: Math.max(dependencies.now(), startedAt),
      success: succeeded,
      sessionId,
      usage,
      events: result.events,
    });
    if (succeeded) break;
  }
  if (!parsedPlan) throw new Error("native planning output was invalid twice; no run was created");
  let plan = serializeOverlappingTasks(parsedPlan);
  let executionQuota = await dependencies.refreshQuotaSnapshot({
    clientEvidence: request.quotaEvidence,
    runtimes,
    settings,
    roleSuccessRates: validateSuccessRates(await dependencies.recentSuccessRates()),
    now: dependencies.now(),
  });
  const maximumTaskUnits = Math.max(
    0,
    ...executionQuota.profiles
      .filter((profile) => profile.canExecute)
      .map((profile) => profile.executionUnits),
  );
  const oversizedSplittable = parsedPlan.tasks.filter((task) => (
    task.splittable && TASK_UNITS[task.size] > maximumTaskUnits
  ));
  const coordinatorCanStillPlan = executionQuota.profiles.some((profile) => (
    profile.agent === coordinator && profile.canPlan
  ));
  if (maximumTaskUnits > 0 && oversizedSplittable.length > 0 && coordinatorCanStillPlan) {
    const targetIds = new Set(oversizedSplittable.map((task) => task.id));
    const unrelated = parsedPlan.tasks.filter((task) => !targetIds.has(task.id));
    const command = buildPlanCommand({
      agent: coordinator,
      binaryPath: coordinatorRuntime.path,
      repositoryPath: repository.root,
      prompt: boundedSplitPrompt(parsedPlan, [...targetIds], maximumTaskUnits),
      schemaPath,
      inlineSchema,
    });
    const startedAt = dependencies.now();
    let splitEvents: OrchestratorEvent[] = [];
    let splitSucceeded = false;
    try {
      const splitResult = await dependencies.runPlanCommand({
        command,
        agent: coordinator,
        signal,
        runId,
        attempt: 2,
      });
      splitEvents = splitResult.events;
      planningEvents.push(...splitEvents);
      if (splitResult.exitCode === 0) {
        const splitPlan = parseOrchestratorPlan(
          extractStructuredPlan(coordinator, splitResult.stdoutLines),
        );
        const unchanged = unrelated.every((task) => isDeepStrictEqual(
          splitPlan.tasks.find((candidate) => candidate.id === task.id),
          task,
        ));
        const replacements = splitPlan.tasks.filter((task) => !unrelated.some(
          (candidate) => candidate.id === task.id,
        ));
        const bounded = replacements.length > 0 && replacements.every((task) => (
          TASK_UNITS[task.size] <= maximumTaskUnits
        ));
        if (
          unchanged
          && bounded
          && splitPlan.title === parsedPlan.title
          && splitPlan.summary === parsedPlan.summary
        ) {
          plan = serializeOverlappingTasks(splitPlan);
          splitSucceeded = true;
        }
      }
    } catch {
      splitSucceeded = false;
    }
    const { sessionId, usage } = planningActivity(splitEvents);
    await dependencies.store.appendActivity({
      runId,
      taskId: null,
      agent: coordinator,
      role: "planning",
      startedAt,
      finishedAt: Math.max(dependencies.now(), startedAt),
      success: splitSucceeded,
      sessionId,
      usage,
      events: splitEvents,
    });
    if (splitSucceeded) {
      executionQuota = await dependencies.refreshQuotaSnapshot({
        clientEvidence: request.quotaEvidence,
        runtimes,
        settings,
        roleSuccessRates: validateSuccessRates(await dependencies.recentSuccessRates()),
        now: dependencies.now(),
      });
    }
  }
  const schedule = selectScheduleBatch({
    tasks: plan.tasks,
    profiles: executionQuota.profiles,
    completedTaskIds: new Set(),
    globalMaxConcurrency: settings.globalMaxConcurrency,
  });
  const draftWithoutFingerprint = {
    runId,
    repositoryPath: repository.root,
    repositoryDevice: repository.device,
    repositoryInode: repository.inode,
    repositoryDirtyAtAnalysis: repository.dirty,
    baseBranch: repository.branch,
    baseSha: repository.head,
    coordinator,
    prompt: request.prompt,
    plan,
    assignedTasks: schedule.runnableTasks,
    runnableTasks: schedule.runnableTasks,
    deferredTasks: schedule.deferredTasks,
    scheduleDiagnostics: schedule.diagnostics,
    quotaSnapshot: executionQuota.snapshot,
    agentProfiles: executionQuota.profiles.map((profile) => ({
      agent: profile.agent,
      enabled: profile.enabled,
      installed: profile.installed,
      version: profile.version,
      canPlan: profile.canPlan,
      canExecute: profile.canExecute,
      canRepair: profile.canRepair,
      executionUnits: profile.executionUnits,
      admissionSource: profile.admissionSource,
      planningSuccessRate: profile.planningSuccessRate,
      executionSuccessRate: profile.executionSuccessRate,
      repairSuccessRate: profile.repairSuccessRate,
      planningRisk: profile.planningRisk,
      repairRisk: profile.repairRisk,
      exclusionReasons: profile.exclusionReasons,
      diagnostics: profile.diagnostics,
      reservedUnitsByOtherRuns: 0,
    })),
  };
  const draft: PlanDraft = {
    ...draftWithoutFingerprint,
    fingerprint: fingerprintPlan(draftWithoutFingerprint),
    createdAt: now,
  };
  const run: OrchestratorRun = {
    schemaVersion: 2,
    id: runId,
    status: schedule.runnableTasks.length === plan.tasks.length
      ? "draft"
      : schedule.runnableTasks.length > 0
        ? "partial_ready"
        : schedule.deferredTasks.some((task) => task.reason === "task_too_large")
          ? "unschedulable"
          : "waiting_quota",
    repositoryPath: repository.root,
    baseBranch: repository.branch,
    baseSha: repository.head,
    coordinator,
    resultBranch: null,
    integrationWorktree: null,
    repositoryTrustedAt: null,
    error:
      schedule.deferredTasks.length > 0
        ? schedule.diagnostics.join("\n").slice(0, 20_000)
        : null,
    draft,
    tasks: plan.tasks.map((task) => {
      const assigned = schedule.runnableTasks.find((candidate) => candidate.id === task.id);
      return {
      ...task,
      assignedAgent: assigned?.assignedAgent ?? null,
      status: assigned ? "queued" : "blocked",
      worktree: null,
      commitSha: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    }}),
    createdAt: now,
    updatedAt: now,
  };
  await dependencies.store.create(run);
  for (const event of planningEvents) {
    await dependencies.store.appendEvent({
      runId,
      taskId: null,
      agent: coordinator,
      at: dependencies.now(),
      event,
    });
  }
  return draft;
}
