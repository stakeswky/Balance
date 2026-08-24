import type { ValueConfidence } from "../quota/quota-value.ts";
import type { AgentId } from "../quota/types.ts";

export type NativeAgentId = AgentId;
export type TaskSize = "small" | "medium" | "large";
export type TaskPriority = "critical" | "high" | "normal";
export type CoordinatorChoice = "auto" | NativeAgentId;

export type RunStatus =
  | "draft"
  | "ready"
  | "running"
  | "cancelling"
  | "integrating"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "capacity_blocked";

export type TaskStatus =
  | "queued"
  | "blocked"
  | "preparing"
  | "running"
  | "verifying"
  | "integrating"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const VERIFICATION_EXECUTABLES = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "git",
  "node",
  "python3",
  "pytest",
  "make",
  "cmake",
  "xcodebuild",
  "swift",
  "gradle",
  "test",
  "./gradlew",
] as const;

export type VerificationExecutable = (typeof VERIFICATION_EXECUTABLES)[number];

export interface VerificationCommand {
  executable: VerificationExecutable;
  args: string[];
}

export interface AgentRuntimeProbe {
  agent: NativeAgentId;
  ok: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface ClientQuotaEvidence {
  officialRemainingPct: number | null;
  officialObservedAt: number | null;
  officialResetsAt: number | null;
  officialFresh: boolean;
  officialSource: string | null;
  l3RemainingPct: number | null;
  l3Confidence: ValueConfidence;
  l3ObservedAt: number | null;
}

export interface QuotaCapacityEvidence extends ClientQuotaEvidence {
  l3Trusted: boolean;
  computedExecutionUnits: number;
  admissionSource: AgentAdmissionSource;
  diagnostics: string[];
}

export interface QuotaSnapshot {
  capturedAt: number;
  evidence: Record<NativeAgentId, QuotaCapacityEvidence>;
}

export interface RepositoryValidation {
  valid: boolean;
  reasons: string[];
  canonicalPath: string | null;
  device: number | null;
  inode: number | null;
  branch: string | null;
  baseSha: string | null;
  dirty: boolean | null;
}

export interface WorktreeRegistration {
  path: string;
  device: number;
  inode: number;
  branch: string;
}

export interface AgentCapacity {
  agent: NativeAgentId;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  officialRemainingPct: number | null;
  officialObservedAt: number | null;
  officialResetsAt: number | null;
  officialFresh: boolean;
  officialSource: string | null;
  l3RemainingPct: number | null;
  l3Confidence: ValueConfidence;
  l3ObservedAt: number | null;
  l3Trusted: boolean;
  planningSuccessRate: number | null;
  executionSuccessRate: number | null;
  repairSuccessRate: number | null;
  allowUnknownQuota: boolean;
}

export type AgentAdmissionSource = "official" | "l3-fallback" | "unknown-allowed" | "excluded";

export interface RoleSuccessRates {
  planningSuccessRate: number | null;
  executionSuccessRate: number | null;
  repairSuccessRate: number | null;
}

export interface AgentSchedulingProfile extends AgentCapacity {
  canPlan: boolean;
  canExecute: boolean;
  canRepair: boolean;
  executionUnits: number;
  admissionSource: AgentAdmissionSource;
  admissionRemainingPct: number | null;
  planningRisk: string | null;
  repairRisk: string | null;
  exclusionReasons: string[];
  diagnostics: string[];
}

export interface OrchestratorTaskPlan {
  id: string;
  title: string;
  description: string;
  size: TaskSize;
  priority: TaskPriority;
  splittable: boolean;
  preferredAgent: NativeAgentId | null;
  dependsOn: string[];
  expectedFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: VerificationCommand[];
}

export interface OrchestratorPlan {
  title: string;
  summary: string;
  tasks: OrchestratorTaskPlan[];
}

export interface AssignedTask extends OrchestratorTaskPlan {
  assignedAgent: NativeAgentId;
}

export type DeferredReason =
  | "quota"
  | "dependency"
  | "agent_unavailable"
  | "task_too_large"
  | "reservation_conflict"
  | "stale_quota";

export interface DeferredTask {
  taskId: string;
  reason: DeferredReason;
  blockedBy: string[];
  requiredUnits: number;
  eligibleAgents: NativeAgentId[];
  eligibleAfter: number | null;
}

export interface ScheduleSelection {
  runnableTasks: AssignedTask[];
  deferredTasks: DeferredTask[];
  diagnostics: string[];
}

export interface PlanDraft {
  runId: string;
  repositoryPath: string;
  repositoryDevice: number;
  repositoryInode: number;
  repositoryDirtyAtAnalysis: boolean;
  baseBranch: string;
  baseSha: string;
  coordinator: NativeAgentId;
  prompt: string;
  plan: OrchestratorPlan;
  assignedTasks: AssignedTask[];
  quotaSnapshot?: QuotaSnapshot;
  fingerprint: string;
  createdAt: number;
}

export type OrchestratorEvent =
  | { type: "process_started"; pid: number }
  | { type: "session_started"; sessionId: string }
  | { type: "message"; text: string }
  | { type: "tool_started"; tool: string; detail: string | null }
  | { type: "tool_completed"; tool: string; success: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: "diagnostic"; stream: "stdout" | "stderr"; message: string }
  | { type: "process_completed"; exitCode: number }
  | { type: "process_failed"; category: string; message: string };

export interface RunEventRecord {
  seq: number;
  runId: string;
  taskId: string | null;
  agent: NativeAgentId | null;
  at: number;
  event: OrchestratorEvent;
}

export type AgentActivityRole = "planning" | "execution" | "repair";

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AgentActivityRecord {
  seq: number;
  runId: string;
  taskId: string | null;
  agent: NativeAgentId;
  role: AgentActivityRole;
  startedAt: number;
  finishedAt: number;
  success: boolean;
  sessionId: string | null;
  usage: AgentTokenUsage | null;
  events: OrchestratorEvent[];
}

export interface TaskRunState extends AssignedTask {
  status: TaskStatus;
  worktree: WorktreeRegistration | null;
  commitSha: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface OrchestratorRun {
  id: string;
  status: RunStatus;
  repositoryPath: string;
  baseBranch: string;
  baseSha: string;
  coordinator: NativeAgentId;
  resultBranch: string | null;
  integrationWorktree: WorktreeRegistration | null;
  repositoryTrustedAt: number | null;
  error: string | null;
  draft: PlanDraft;
  tasks: TaskRunState[];
  createdAt: number;
  updatedAt: number;
}

export interface NativeAgentSetting {
  agent: NativeAgentId;
  enabled: boolean;
  binaryPath: string | null;
  allowUnknownQuota: boolean;
}

export interface OrchestratorSettings {
  globalMaxConcurrency: 1 | 2 | 3;
  agents: Record<NativeAgentId, NativeAgentSetting>;
}
