import { createHash } from "node:crypto";
import { z } from "zod";
import {
  VERIFICATION_EXECUTABLES,
  type OrchestratorPlan,
  type OrchestratorTaskPlan,
  type PlanDraft,
  type VerificationCommand,
} from "./types.ts";

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//;
const GLOB_MARKER = /[*?[\]{}]/;
const GIT_VERIFICATION_ARGS = new Set([
  JSON.stringify(["diff", "--check"]),
  JSON.stringify(["status", "--short"]),
  JSON.stringify(["rev-parse", "--verify", "HEAD"]),
  JSON.stringify(["show", "--stat", "--oneline", "HEAD"]),
]);
const MUTATING_PACKAGE_COMMANDS = new Set([
  "add",
  "dlx",
  "exec",
  "install",
  "link",
  "publish",
  "remove",
  "uninstall",
  "update",
  "upgrade",
]);

function isSafeRepositoryPath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(value)) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function verificationIssue(command: VerificationCommand): string | null {
  if (!(VERIFICATION_EXECUTABLES as readonly string[]).includes(command.executable)) {
    return `unsupported verification executable: ${String(command.executable)}`;
  }
  if (command.args.length > 30) return "verification command has more than 30 arguments";
  if (command.args.some((arg) => !arg || arg.length > 500 || arg.includes("\0") || /[\r\n]/.test(arg))) {
    return "verification arguments must be 1-500 characters without NUL or newlines";
  }
  if (command.executable === "git" && !GIT_VERIFICATION_ARGS.has(JSON.stringify(command.args))) {
    return "git verification command is outside the closed safe grammar";
  }
  if (
    command.executable === "node"
    && command.args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print")
  ) {
    return "node eval and print modes are not allowed";
  }
  if (command.executable === "python3" && command.args.some((arg) => arg === "-c")) {
    return "python command mode is not allowed";
  }
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(command.executable)
    && command.args[0]
    && MUTATING_PACKAGE_COMMANDS.has(command.args[0].toLowerCase())
  ) {
    return "dependency mutation and publishing commands are not allowed";
  }
  if (command.executable === "test") {
    if (
      command.args.length !== 2
      || !["-d", "-e", "-f"].includes(command.args[0]!)
      || !isSafeRepositoryPath(command.args[1]!)
    ) {
      return "test verification only accepts -d, -e or -f with a repository-relative path";
    }
  }
  if (
    command.executable === "./gradlew"
    && command.args.some((arg) => ["-I", "--init-script", "-p", "--project-dir"].includes(arg))
  ) {
    return "Gradle external init scripts and project directories are not allowed";
  }
  return null;
}

const verificationCommandSchema = z
  .object({
    executable: z.enum(VERIFICATION_EXECUTABLES),
    args: z.array(z.string().min(1).max(500)).max(30),
  })
  .strict()
  .superRefine((command, context) => {
    const issue = verificationIssue(command);
    if (issue) context.addIssue({ code: "custom", message: issue });
  });

const taskSchema = z
  .object({
    id: z.string().regex(TASK_ID),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(4_000),
    size: z.enum(["small", "medium", "large"]),
    preferredAgent: z.enum(["claude", "codex", "grok"]).nullable(),
    dependsOn: z.array(z.string().regex(TASK_ID)).max(12),
    expectedFiles: z
      .array(z.string().min(1).max(1_000).refine(isSafeRepositoryPath, "unsafe repository path"))
      .min(1)
      .max(100),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    verificationCommands: z.array(verificationCommandSchema).min(1).max(5),
  })
  .strict();

function addDependencyIssues(
  plan: { tasks: OrchestratorTaskPlan[] },
  context: z.RefinementCtx,
): void {
  const idCounts = new Map<string, number>();
  for (const task of plan.tasks) idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1);
  const ids = new Set(idCounts.keys());
  plan.tasks.forEach((task, taskIndex) => {
    if ((idCounts.get(task.id) ?? 0) > 1) {
      context.addIssue({ code: "custom", message: `duplicate task id: ${task.id}`, path: ["tasks", taskIndex, "id"] });
    }
    const seen = new Set<string>();
    task.dependsOn.forEach((dependency, dependencyIndex) => {
      const path = ["tasks", taskIndex, "dependsOn", dependencyIndex];
      if (!ids.has(dependency)) {
        context.addIssue({ code: "custom", message: `unknown dependency: ${dependency}`, path });
      } else if (dependency === task.id) {
        context.addIssue({ code: "custom", message: "task cannot depend on itself", path });
      } else if (seen.has(dependency)) {
        context.addIssue({ code: "custom", message: `duplicate dependency: ${dependency}`, path });
      }
      seen.add(dependency);
    });
  });

  const remaining = new Map(plan.tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const completed = new Set<string>();
  while (completed.size < plan.tasks.length) {
    const ready = plan.tasks.find((task) => {
      if (completed.has(task.id) || (idCounts.get(task.id) ?? 0) !== 1) return false;
      const dependencies = remaining.get(task.id);
      return dependencies !== undefined && [...dependencies].every((dependency) => completed.has(dependency));
    });
    if (!ready) {
      context.addIssue({ code: "custom", message: "task dependency graph contains a cycle", path: ["tasks"] });
      return;
    }
    completed.add(ready.id);
  }
}

export const orchestratorPlanSchema: z.ZodType<OrchestratorPlan> = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(4_000),
    tasks: z.array(taskSchema).min(1).max(12),
  })
  .strict()
  .superRefine(addDependencyIssues);

export const orchestratorPlanJsonSchema = z.toJSONSchema(orchestratorPlanSchema, {
  target: "draft-07",
});

export function validateVerificationCommand(command: VerificationCommand): VerificationCommand {
  return verificationCommandSchema.parse(command);
}

export function parseOrchestratorPlan(value: unknown): OrchestratorPlan {
  return orchestratorPlanSchema.parse(value);
}

export function topologicalTaskIds(plan: OrchestratorPlan): string[] {
  const parsed = parseOrchestratorPlan(plan);
  const completed = new Set<string>();
  const ordered: string[] = [];
  while (ordered.length < parsed.tasks.length) {
    const ready = parsed.tasks.find(
      (task) => !completed.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (!ready) throw new Error("task dependency graph contains a cycle");
    completed.add(ready.id);
    ordered.push(ready.id);
  }
  return ordered;
}

function normalizedScope(scope: string): string {
  return scope.replace(/\/+$/, "");
}

function scopesOverlap(leftValue: string, rightValue: string): boolean {
  const left = normalizedScope(leftValue);
  const right = normalizedScope(rightValue);
  if (GLOB_MARKER.test(left) || GLOB_MARKER.test(right)) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function taskDependsOn(
  tasks: ReadonlyMap<string, OrchestratorTaskPlan>,
  taskId: string,
  dependencyId: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(taskId)) return false;
  visited.add(taskId);
  const task = tasks.get(taskId);
  if (!task) return false;
  if (task.dependsOn.includes(dependencyId)) return true;
  return task.dependsOn.some((dependency) => taskDependsOn(tasks, dependency, dependencyId, visited));
}

export function serializeOverlappingTasks(plan: OrchestratorPlan): OrchestratorPlan {
  const parsed = parseOrchestratorPlan(plan);
  const tasks = parsed.tasks.map((task) => ({
    ...task,
    dependsOn: [...task.dependsOn],
    expectedFiles: [...task.expectedFiles],
    acceptanceCriteria: [...task.acceptanceCriteria],
    verificationCommands: task.verificationCommands.map((item) => ({ ...item, args: [...item.args] })),
  }));
  for (let laterIndex = 1; laterIndex < tasks.length; laterIndex += 1) {
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      const earlier = tasks[earlierIndex]!;
      const later = tasks[laterIndex]!;
      const overlaps = earlier.expectedFiles.some((left) =>
        later.expectedFiles.some((right) => scopesOverlap(left, right)),
      );
      if (!overlaps) continue;
      const byId = new Map(tasks.map((task) => [task.id, task]));
      if (taskDependsOn(byId, later.id, earlier.id) || taskDependsOn(byId, earlier.id, later.id)) continue;
      later.dependsOn.push(earlier.id);
    }
  }
  return parseOrchestratorPlan({ ...parsed, tasks });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function fingerprintPlan(input: Omit<PlanDraft, "fingerprint" | "createdAt">): string {
  return createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}
