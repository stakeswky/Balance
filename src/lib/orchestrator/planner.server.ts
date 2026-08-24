import { isAbsolute } from "node:path";
import { z } from "zod";
import { buildPlanCommand, extractStructuredPlan, type AgentCommand } from "./adapters.ts";
import { assignTasks, chooseCoordinator } from "./capacity.ts";
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
  ClientQuotaEvidence,
  CoordinatorChoice,
  NativeAgentId,
  OrchestratorEvent,
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
  }): Promise<{ stdoutLines: string[]; events: OrchestratorEvent[] }>;
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

function plannerPrompt(userPrompt: string, repairIssues: unknown[] | null): string {
  const boundary = [
    "You are the Balance planning coordinator. Only analyze the repository; do not modify files, run mutating commands, or request credentials.",
    "Return only one object matching the supplied strict JSON Schema. Create 1-12 tasks.",
    "Every task must declare description, size, dependsOn, expectedFiles, acceptanceCriteria, structured verificationCommands, and preferredAgent.",
    "The only supported Agent values are claude, codex, and grok (Claude, Codex, Grok).",
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
  const quota = await dependencies.refreshQuotaSnapshot({
    clientEvidence: request.quotaEvidence,
    runtimes,
    settings,
    roleSuccessRates: successRates,
    now,
  });
  const coordinator = chooseCoordinator(quota.profiles, request.coordinator);
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = plannerPrompt(request.prompt, issues);
    const command = buildPlanCommand({
      agent: coordinator,
      binaryPath: coordinatorRuntime.path,
      repositoryPath: repository.root,
      prompt,
      schemaPath,
      inlineSchema,
    });
    const result = await dependencies.runPlanCommand({
      command,
      agent: coordinator,
      signal,
      runId,
      attempt,
    });
    try {
      parsedPlan = parseOrchestratorPlan(extractStructuredPlan(coordinator, result.stdoutLines));
      break;
    } catch (error) {
      issues = validationIssues(error);
    }
  }
  if (!parsedPlan) throw new Error("native planning output was invalid twice; no run was created");
  const plan = serializeOverlappingTasks(parsedPlan);
  const assignment = assignTasks(plan.tasks, quota.profiles);
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
    assignedTasks: assignment.tasks,
    quotaSnapshot: quota.snapshot,
  };
  const draft: PlanDraft = {
    ...draftWithoutFingerprint,
    fingerprint: fingerprintPlan(draftWithoutFingerprint),
    createdAt: now,
  };
  const run: OrchestratorRun = {
    id: runId,
    status: assignment.status === "ready" ? "draft" : "capacity_blocked",
    repositoryPath: repository.root,
    baseBranch: repository.branch,
    baseSha: repository.head,
    coordinator,
    resultBranch: null,
    integrationWorktree: null,
    repositoryTrustedAt: null,
    error:
      assignment.status === "capacity_blocked"
        ? assignment.diagnostics.join("\n").slice(0, 20_000)
        : null,
    draft,
    tasks: assignment.tasks.map((task) => ({
      ...task,
      status: "queued",
      worktree: null,
      commitSha: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    })),
    createdAt: now,
    updatedAt: now,
  };
  await dependencies.store.create(run);
  return draft;
}
