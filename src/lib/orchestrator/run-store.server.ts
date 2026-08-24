import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { redactAgentOutput } from "./adapters.ts";
import { parseOrchestratorPlan } from "./plan.ts";
import { quotaCapacityEvidenceSchema } from "./schemas.ts";
import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  orchestratorStateDir,
} from "./paths.server.ts";
import { VERIFICATION_EXECUTABLES } from "./types.ts";
import type {
  AgentActivityRecord,
  AgentActivityRole,
  NativeAgentId,
  OrchestratorEvent,
  OrchestratorRun,
  RunEventRecord,
  RunStatus,
  TaskStatus,
} from "./types.ts";

const RUN_ID = /^run_\d{14}_[0-9a-f]{12}$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "capacity_blocked",
  "unschedulable",
]);
const IDLE_RESUMABLE_RUN_STATUSES = new Set<RunStatus>([
  "partial_ready",
  "waiting_quota",
  "partial_completed",
]);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const timestampSchema = z.number().int().nonnegative().safe();
const agentSchema = z.enum(["claude", "codex", "grok"]);
const verificationCommandSchema = z.object({
  executable: z.enum(VERIFICATION_EXECUTABLES),
  args: z.array(z.string().min(1).max(500)).max(30),
}).strict();
const taskPlanSchema = z.object({
  id: z.string().regex(TASK_ID),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(4_000),
  size: z.enum(["small", "medium", "large"]),
  priority: z.enum(["critical", "high", "normal"]),
  splittable: z.boolean(),
  preferredAgent: agentSchema.nullable(),
  dependsOn: z.array(z.string().regex(TASK_ID)).max(12),
  expectedFiles: z.array(z.string().min(1).max(1_000)).min(1).max(100),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  verificationCommands: z.array(verificationCommandSchema).min(1).max(5),
}).strict();
const assignedTaskSchema = taskPlanSchema.extend({ assignedAgent: agentSchema }).strict();
const worktreeSchema = z.object({
  path: z.string().min(1).max(4_096).refine(isAbsolute, "worktree path must be absolute"),
  device: z.number().int().nonnegative().safe(),
  inode: z.number().int().nonnegative().safe(),
  branch: z.string().min(1).max(500),
}).strict();
const taskRunSchema = taskPlanSchema.extend({
  assignedAgent: agentSchema.nullable(),
  status: z.enum([
    "queued", "blocked", "preparing", "running", "verifying",
    "integrating", "completed", "failed", "cancelled", "interrupted",
  ]),
  worktree: worktreeSchema.nullable(),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  error: z.string().max(20_000).nullable(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
}).strict();
const planSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(4_000),
  tasks: z.array(taskPlanSchema).min(1).max(12),
}).strict();
const quotaSnapshotSchema = z.object({
  capturedAt: timestampSchema,
  evidence: z.object({
    claude: quotaCapacityEvidenceSchema,
    codex: quotaCapacityEvidenceSchema,
    grok: quotaCapacityEvidenceSchema,
  }).strict(),
}).strict();
const deferredTaskSchema = z.object({
  taskId: z.string().regex(TASK_ID),
  reason: z.enum([
    "quota", "dependency", "agent_unavailable", "task_too_large",
    "reservation_conflict", "stale_quota",
  ]),
  blockedBy: z.array(z.string().regex(TASK_ID)).max(12),
  requiredUnits: z.number().int().positive().safe(),
  eligibleAgents: z.array(agentSchema).max(3),
  eligibleAfter: timestampSchema.nullable(),
}).strict();
const planDraftSchema = z.object({
  runId: z.string().regex(RUN_ID),
  repositoryPath: z.string().min(1).max(4_096).refine(isAbsolute),
  repositoryDevice: z.number().int().nonnegative().safe(),
  repositoryInode: z.number().int().nonnegative().safe(),
  repositoryDirtyAtAnalysis: z.boolean(),
  baseBranch: z.string().min(1).max(500),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  coordinator: agentSchema,
  prompt: z.string().min(1).max(100_000),
  plan: planSchema,
  assignedTasks: z.array(assignedTaskSchema).max(12),
  runnableTasks: z.array(assignedTaskSchema).max(12).optional(),
  deferredTasks: z.array(deferredTaskSchema).max(12).optional(),
  scheduleDiagnostics: z.array(z.string().min(1).max(4_000)).max(100).optional(),
  legacyCompatibility: z.string().min(1).max(4_000).optional(),
  quotaSnapshot: quotaSnapshotSchema.optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: timestampSchema,
}).strict();
const runSchema: z.ZodType<OrchestratorRun> = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(RUN_ID),
  status: z.enum([
    "draft", "ready", "running", "cancelling", "integrating", "verifying",
    "completed", "failed", "cancelled", "interrupted", "capacity_blocked",
    "partial_ready", "waiting_quota", "partial_completed", "unschedulable",
  ]),
  repositoryPath: z.string().min(1).max(4_096).refine(isAbsolute),
  baseBranch: z.string().min(1).max(500),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  coordinator: agentSchema,
  resultBranch: z.string().min(1).max(500).nullable(),
  integrationWorktree: worktreeSchema.nullable(),
  repositoryTrustedAt: timestampSchema.nullable(),
  error: z.string().max(20_000).nullable(),
  draft: planDraftSchema,
  tasks: z.array(taskRunSchema).max(12),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((run, context) => {
  if (run.id !== run.draft.runId) {
    context.addIssue({ code: "custom", path: ["draft", "runId"], message: "draft runId must match run id" });
  }
  try {
    parseOrchestratorPlan(run.draft.plan);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["draft", "plan"],
      message: `persisted plan is invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const planIds = run.draft.plan.tasks.map((task) => task.id);
  const assignedIds = run.draft.assignedTasks.map((task) => task.id);
  const runnableIds = (run.draft.runnableTasks ?? run.draft.assignedTasks).map((task) => task.id);
  const stateIds = run.tasks.map((task) => task.id);
  const isV2 = run.draft.runnableTasks !== undefined || run.draft.deferredTasks !== undefined;
  const capacityBlockedWithoutAssignments =
    run.status === "capacity_blocked" && assignedIds.length === 0 && stateIds.length === 0;
  if (new Set(planIds).size !== planIds.length) {
    context.addIssue({ code: "custom", path: ["draft", "plan"], message: "plan task ids must be unique" });
  }
  if (JSON.stringify(assignedIds) !== JSON.stringify(runnableIds)) {
    context.addIssue({ code: "custom", path: ["draft", "runnableTasks"], message: "assigned tasks must match runnable tasks" });
  }
  if (
    (!isV2 && !capacityBlockedWithoutAssignments && JSON.stringify(planIds) !== JSON.stringify(assignedIds))
    || (isV2 && runnableIds.some((id) => !planIds.includes(id)))
  ) {
    context.addIssue({ code: "custom", path: ["draft", "assignedTasks"], message: "assigned tasks must be a valid plan subset" });
  }
  const expectedStateIds = isV2 ? planIds : assignedIds;
  if (!capacityBlockedWithoutAssignments && JSON.stringify(expectedStateIds) !== JSON.stringify(stateIds)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "task states must match persisted plan scope" });
  }
  const planById = new Map(run.draft.plan.tasks.map((task) => [task.id, task]));
  run.draft.assignedTasks.forEach((assigned, index) => {
    const { assignedAgent: _assignedAgent, ...base } = assigned;
    if (JSON.stringify(base) !== JSON.stringify(planById.get(assigned.id))) {
      context.addIssue({
        code: "custom",
        path: ["draft", "assignedTasks", index],
        message: "assigned task content must match the validated plan",
      });
    }
  });
  const assignmentById = new Map(run.draft.assignedTasks.map((task) => [task.id, task.assignedAgent]));
  run.tasks.forEach((state, index) => {
    const {
      status: _status,
      worktree: _worktree,
      commitSha: _commitSha,
      error: _error,
      startedAt: _startedAt,
      finishedAt: _finishedAt,
      assignedAgent,
      ...base
    } = state;
    const expectedAssignment = assignmentById.get(state.id) ?? null;
    if (JSON.stringify(base) !== JSON.stringify(planById.get(state.id)) || assignedAgent !== expectedAssignment) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index],
        message: "task state content must match its assignment",
      });
    }
  });
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("process_started"), pid: z.number().int() }).strict(),
  z.object({ type: z.literal("session_started"), sessionId: z.string().min(1).max(4_096) }).strict(),
  z.object({ type: z.literal("message"), text: z.string().max(1024 * 1024) }).strict(),
  z.object({
    type: z.literal("tool_started"),
    tool: z.string().min(1).max(500),
    detail: z.string().max(1024 * 1024).nullable(),
  }).strict(),
  z.object({ type: z.literal("tool_completed"), tool: z.string().min(1).max(500), success: z.boolean() }).strict(),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    cachedInputTokens: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    type: z.literal("diagnostic"),
    stream: z.enum(["stdout", "stderr"]),
    message: z.string().max(1024 * 1024),
  }).strict(),
  z.object({ type: z.literal("process_completed"), exitCode: z.number().int() }).strict(),
  z.object({
    type: z.literal("process_failed"),
    category: z.string().min(1).max(500),
    message: z.string().max(1024 * 1024),
  }).strict(),
]);
const eventRecordSchema: z.ZodType<RunEventRecord> = z.object({
  seq: z.number().int().positive().safe(),
  runId: z.string().regex(RUN_ID),
  taskId: z.string().regex(TASK_ID).nullable(),
  agent: agentSchema.nullable(),
  at: timestampSchema,
  event: eventSchema,
}).strict();
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  cachedInputTokens: z.number().int().nonnegative().safe(),
}).strict();
const activityRecordSchema: z.ZodType<AgentActivityRecord> = z.object({
  seq: z.number().int().positive().safe(),
  runId: z.string().regex(RUN_ID),
  taskId: z.string().min(1).max(100).nullable(),
  agent: agentSchema,
  role: z.enum(["planning", "execution", "repair"]),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  success: z.boolean(),
  sessionId: z.string().min(1).max(4_096).nullable(),
  usage: usageSchema.nullable(),
  events: z.array(eventSchema).max(100_000),
}).strict().superRefine((record, context) => {
  if (record.finishedAt < record.startedAt) {
    context.addIssue({
      code: "custom",
      path: ["finishedAt"],
      message: "activity finishedAt cannot precede startedAt",
    });
  }
});

const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  draft: new Set(["ready", "partial_ready", "waiting_quota", "unschedulable", "capacity_blocked", "cancelled", "interrupted"]),
  partial_ready: new Set(["ready", "waiting_quota", "unschedulable", "cancelled", "interrupted"]),
  waiting_quota: new Set(["ready", "partial_ready", "unschedulable", "cancelled"]),
  partial_completed: new Set(["ready", "partial_ready", "waiting_quota", "unschedulable", "cancelled"]),
  unschedulable: new Set(),
  ready: new Set(["running", "cancelled", "interrupted"]),
  running: new Set(["cancelling", "integrating", "verifying", "partial_completed", "waiting_quota", "failed", "interrupted"]),
  cancelling: new Set(["cancelled", "interrupted"]),
  integrating: new Set(["cancelling", "verifying", "failed", "interrupted"]),
  verifying: new Set(["cancelling", "completed", "partial_completed", "failed", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
  capacity_blocked: new Set(),
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  queued: new Set(["blocked", "preparing", "cancelled", "interrupted"]),
  blocked: new Set(["queued", "cancelled", "interrupted"]),
  preparing: new Set(["running", "failed", "cancelled", "interrupted"]),
  running: new Set(["verifying", "failed", "cancelled", "interrupted"]),
  verifying: new Set(["integrating", "failed", "cancelled", "interrupted"]),
  integrating: new Set(["completed", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`invalid orchestrator run id: ${runId}`);
}

function safeEvent(event: OrchestratorEvent): OrchestratorEvent {
  if (event.type === "diagnostic") {
    return { ...event, message: redactAgentOutput(event.message, []) };
  }
  if (event.type === "message") return { ...event, text: redactAgentOutput(event.text, []) };
  if (event.type === "tool_started") {
    return { ...event, detail: event.detail === null ? null : redactAgentOutput(event.detail, []) };
  }
  if (event.type === "process_failed") {
    return { ...event, message: redactAgentOutput(event.message, []) };
  }
  return event;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function migrateLegacyTask(value: unknown): void {
  const task = objectRecord(value);
  if (!task) return;
  if (!("priority" in task)) task.priority = "normal";
  if (!("splittable" in task)) task.splittable = false;
}

export function migrateLegacyRun(input: unknown): unknown {
  const source = objectRecord(input);
  if (!source || source.schemaVersion !== undefined) return input;
  const migrated = structuredClone(source);
  migrated.schemaVersion = 2;
  const draft = objectRecord(migrated.draft);
  if (!draft) return migrated;
  draft.legacyCompatibility =
    "此运行记录来自旧版 Scheduler，仅供只读展示；请重新分析后再使用 V2 调度。";
  const plan = objectRecord(draft.plan);
  if (Array.isArray(plan?.tasks)) plan.tasks.forEach(migrateLegacyTask);
  if (Array.isArray(draft.assignedTasks)) draft.assignedTasks.forEach(migrateLegacyTask);
  if (Array.isArray(migrated.tasks)) migrated.tasks.forEach(migrateLegacyTask);
  const quotaSnapshot = objectRecord(draft.quotaSnapshot);
  const evidence = objectRecord(quotaSnapshot?.evidence);
  const codexEvidence = objectRecord(evidence?.codex);
  if (quotaSnapshot && !codexEvidence?.admissionSource) delete draft.quotaSnapshot;
  return migrated;
}

function assertTransitions(previous: OrchestratorRun, next: OrchestratorRun): void {
  if (previous.status !== next.status && !RUN_TRANSITIONS[previous.status].has(next.status)) {
    throw new Error(`invalid run state transition: ${previous.status} -> ${next.status}`);
  }
  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
  if (previous.status !== "draft" || next.status !== "draft") {
    for (const task of next.tasks) {
      const prior = previousTasks.get(task.id);
      if (!prior) throw new Error(`invalid task set transition: added ${task.id}`);
      if (prior.status !== task.status && !TASK_TRANSITIONS[prior.status].has(task.status)) {
        throw new Error(`invalid task state transition: ${prior.status} -> ${task.status}`);
      }
    }
    if (previousTasks.size !== next.tasks.length) throw new Error("invalid task set transition: task count changed");
  }
  if (previous.id !== next.id || previous.createdAt !== next.createdAt) {
    throw new Error("run id and createdAt are immutable");
  }
  if (next.updatedAt < previous.updatedAt) throw new Error("run updatedAt cannot move backwards");
}

async function appendPrivateLine(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface InstanceLock {
  pid: number;
  nonce: string;
  acquiredAt: number;
}

const instanceLockSchema = z.object({
  pid: z.number().int().positive().safe(),
  nonce: z.string().uuid(),
  acquiredAt: timestampSchema,
}).strict();

export interface RunStore {
  initialize(): Promise<void>;
  create(run: OrchestratorRun): Promise<void>;
  get(runId: string): Promise<OrchestratorRun | null>;
  list(): Promise<OrchestratorRun[]>;
  update(runId: string, mutate: (run: OrchestratorRun) => OrchestratorRun): Promise<OrchestratorRun>;
  appendEvent(record: Omit<RunEventRecord, "seq">): Promise<RunEventRecord>;
  events(runId: string, afterSeq?: number): Promise<RunEventRecord[]>;
  appendActivity(record: Omit<AgentActivityRecord, "seq">): Promise<AgentActivityRecord>;
  activities(filter?: {
    agent?: NativeAgentId;
    role?: AgentActivityRole;
    limit?: number;
  }): Promise<AgentActivityRecord[]>;
  recoverInterrupted(): Promise<string[]>;
  pruneExpired(now: number): Promise<string[]>;
  acquireInstanceLock(): Promise<() => Promise<void>>;
}

class FileRunStore implements RunStore {
  readonly #root: string;
  readonly #runsRoot: string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("run store root must be absolute");
    this.#root = root;
    this.#runsRoot = join(root, "runs");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#runsRoot);
  }

  #runRoot(runId: string): string {
    assertRunId(runId);
    return join(this.#runsRoot, runId);
  }

  async #validatedRunRoot(runId: string): Promise<string | null> {
    const runRoot = this.#runRoot(runId);
    let metadata;
    try {
      metadata = await lstat(runRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`unsafe symbolic-link run directory: ${runId}`);
    }
    const effectiveUid = process.geteuid?.();
    if (effectiveUid !== undefined && metadata.uid !== effectiveUid) {
      throw new Error(`unsafe run directory owner: ${runId}`);
    }
    const canonicalRunsRoot = await realpath(this.#runsRoot);
    const canonicalRunRoot = await realpath(runRoot);
    if (canonicalRunRoot !== join(canonicalRunsRoot, runId)) {
      throw new Error(`unsafe run directory identity: ${runId}`);
    }
    return runRoot;
  }

  async #exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    this.#queues.set(runId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(runId) === current) this.#queues.delete(runId);
    }
  }

  async create(input: OrchestratorRun): Promise<void> {
    const run = runSchema.parse(input);
    await this.initialize();
    await this.#exclusive(run.id, async () => {
      const runRoot = this.#runRoot(run.id);
      try {
        await mkdir(runRoot, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`orchestrator run already exists: ${run.id}`);
        }
        throw error;
      }
      for (const directory of ["stdout", "stderr", "integration", "tasks"]) {
        await mkdir(join(runRoot, directory), { mode: 0o700 });
      }
      await atomicWritePrivateJson(join(runRoot, "run.json"), run);
    });
  }

  async #quarantine(runId: string, error: unknown): Promise<void> {
    const runRoot = this.#runRoot(runId);
    const source = join(runRoot, "run.json");
    const rawTarget = join(runRoot, "run.corrupt.raw");
    await rename(source, rawTarget).catch((renameError: NodeJS.ErrnoException) => {
      if (renameError.code !== "ENOENT") throw renameError;
    });
    await chmod(rawTarget, 0o600).catch(() => undefined);
    await atomicWritePrivateJson(join(runRoot, "run.corrupt.json"), {
      diagnostic: `Corrupt or invalid run state was quarantined: ${error instanceof Error ? error.message : String(error)}`,
      quarantinedAt: Date.now(),
    });
  }

  async get(runId: string): Promise<OrchestratorRun | null> {
    const runRoot = await this.#validatedRunRoot(runId);
    if (!runRoot) return null;
    const path = join(runRoot, "run.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return runSchema.parse(migrateLegacyRun(JSON.parse(raw)));
    } catch (error) {
      await this.#quarantine(runId, error);
      return null;
    }
  }

  async list(): Promise<OrchestratorRun[]> {
    await this.initialize();
    const entries = await readdir(this.#runsRoot, { withFileTypes: true });
    const runs: OrchestratorRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const run = await this.get(entry.name);
      if (run) runs.push(run);
    }
    return runs.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  }

  async update(
    runId: string,
    mutate: (run: OrchestratorRun) => OrchestratorRun,
  ): Promise<OrchestratorRun> {
    return this.#exclusive(runId, async () => {
      const current = await this.get(runId);
      if (!current) throw new Error(`orchestrator run not found: ${runId}`);
      const next = runSchema.parse(mutate(structuredClone(current)));
      assertTransitions(current, next);
      await atomicWritePrivateJson(join(this.#runRoot(runId), "run.json"), next);
      return next;
    });
  }

  async appendEvent(input: Omit<RunEventRecord, "seq">): Promise<RunEventRecord> {
    assertRunId(input.runId);
    return this.#exclusive(input.runId, async () => {
      if (!(await this.get(input.runId))) throw new Error(`orchestrator run not found: ${input.runId}`);
      const previous = await this.events(input.runId);
      const record = eventRecordSchema.parse({
        ...input,
        seq: (previous.at(-1)?.seq ?? 0) + 1,
        event: safeEvent(input.event),
      });
      await appendPrivateLine(join(this.#runRoot(input.runId), "events.jsonl"), record);
      return record;
    });
  }

  async events(runId: string, afterSeq = 0): Promise<RunEventRecord[]> {
    assertRunId(runId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a nonnegative integer");
    const runRoot = await this.#validatedRunRoot(runId);
    if (!runRoot) return [];
    let raw: string;
    try {
      raw = await readFile(join(runRoot, "events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = raw.split(/\r?\n/).filter(Boolean).map((line) => eventRecordSchema.parse(JSON.parse(line)));
    let previous = 0;
    for (const record of records) {
      if (record.runId !== runId || record.seq !== previous + 1) {
        throw new Error(`invalid event sequence for ${runId}`);
      }
      previous = record.seq;
    }
    return records.filter((record) => record.seq > afterSeq);
  }

  async appendActivity(input: Omit<AgentActivityRecord, "seq">): Promise<AgentActivityRecord> {
    await this.initialize();
    return this.#exclusive("agent-activity", async () => {
      const previous = await this.activities();
      const record = activityRecordSchema.parse({
        ...input,
        seq: (previous.at(-1)?.seq ?? 0) + 1,
        events: input.events.map(safeEvent),
      });
      await appendPrivateLine(join(this.#root, "agent-activity.jsonl"), record);
      return record;
    });
  }

  async activities(filter: {
    agent?: NativeAgentId;
    role?: AgentActivityRole;
    limit?: number;
  } = {}): Promise<AgentActivityRecord[]> {
    await this.initialize();
    const limit = filter.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("activity limit must be an integer from 1 to 10000");
    }
    let raw: string;
    try {
      raw = await readFile(join(this.#root, "agent-activity.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = raw.split(/\r?\n/).filter(Boolean)
      .map((line) => activityRecordSchema.parse(JSON.parse(line)));
    let previous = 0;
    for (const record of records) {
      if (record.seq !== previous + 1) throw new Error("invalid agent activity sequence");
      previous = record.seq;
    }
    return records
      .filter((record) => !filter.agent || record.agent === filter.agent)
      .filter((record) => !filter.role || record.role === filter.role)
      .slice(-limit);
  }

  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = [];
    for (const run of await this.list()) {
      if (TERMINAL_RUN_STATUSES.has(run.status) || IDLE_RESUMABLE_RUN_STATUSES.has(run.status)) continue;
      await this.update(run.id, (current) => ({
        ...current,
        status: "interrupted",
        tasks: current.tasks.map((task) => TERMINAL_TASK_STATUSES.has(task.status)
          ? task
          : { ...task, status: "interrupted", finishedAt: Date.now() }),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      }));
      recovered.push(run.id);
    }
    return recovered.sort();
  }

  async pruneExpired(now: number): Promise<string[]> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("prune time must be a nonnegative integer");
    const removed: string[] = [];
    for (const run of await this.list()) {
      if (!TERMINAL_RUN_STATUSES.has(run.status) || run.updatedAt >= now - RETENTION_MS) continue;
      if (run.integrationWorktree || run.tasks.some((task) => task.worktree)) continue;
      const didRemove = await this.#exclusive(run.id, async () => {
        const current = await this.get(run.id);
        if (
          !current ||
          !TERMINAL_RUN_STATUSES.has(current.status) ||
          current.updatedAt >= now - RETENTION_MS ||
          current.integrationWorktree ||
          current.tasks.some((task) => task.worktree)
        ) {
          return false;
        }
        const runRoot = this.#runRoot(run.id);
        const metadata = await lstat(runRoot);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`refusing to prune unsafe run directory: ${run.id}`);
        }
        const canonicalRunsRoot = await realpath(this.#runsRoot);
        const canonicalRunRoot = await realpath(runRoot);
        if (!canonicalRunRoot.startsWith(`${canonicalRunsRoot}/`)) {
          throw new Error(`refusing to prune run outside the store: ${run.id}`);
        }
        await rm(runRoot, { recursive: true });
        return true;
      });
      if (didRemove) removed.push(run.id);
    }
    return removed.sort();
  }

  async acquireInstanceLock(): Promise<() => Promise<void>> {
    await this.initialize();
    const lockPath = join(this.#root, "instance.lock");
    const lock: InstanceLock = { pid: process.pid, nonce: randomUUID(), acquiredAt: Date.now() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          let current: InstanceLock;
          try {
            current = instanceLockSchema.parse(JSON.parse(await readFile(lockPath, "utf8")));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw new Error("refusing to release an instance lock whose identity cannot be verified");
          }
          if (current.nonce !== lock.nonce || current.pid !== lock.pid) {
            throw new Error("refusing to release an instance lock owned by another process");
          }
          await unlink(lockPath);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: InstanceLock;
        try {
          existing = instanceLockSchema.parse(JSON.parse(await readFile(lockPath, "utf8")));
        } catch {
          throw new Error("orchestrator instance lock exists but is invalid; refusing unsafe recovery");
        }
        if (processIsAlive(existing.pid)) {
          throw new Error(`another orchestrator instance is already running with pid ${existing.pid}`);
        }
        await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
      }
    }
    throw new Error("could not acquire the orchestrator instance lock after stale-lock recovery");
  }
}

export function createRunStore(root = orchestratorStateDir()): RunStore {
  return new FileRunStore(root);
}
