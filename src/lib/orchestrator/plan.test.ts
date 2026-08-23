import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestratorPlan, PlanDraft, VerificationCommand } from "./types.ts";
import {
  fingerprintPlan,
  orchestratorPlanJsonSchema,
  parseOrchestratorPlan,
  serializeOverlappingTasks,
  topologicalTaskIds,
  validateVerificationCommand,
} from "./plan.ts";

function command(
  executable: VerificationCommand["executable"] = "npm",
  args: string[] = ["run", "test"],
): VerificationCommand {
  return { executable, args };
}

function validPlan(): OrchestratorPlan {
  return {
    title: "实现额度调度",
    summary: "拆分公共契约与界面接线。",
    tasks: [
      {
        id: "core",
        title: "实现核心",
        description: "实现可验证的调度核心。",
        size: "medium",
        dependsOn: [],
        expectedFiles: ["src/lib/orchestrator/core.ts"],
        acceptanceCriteria: ["核心单元测试通过"],
        verificationCommands: [command()],
        preferredAgent: "codex",
      },
      {
        id: "ui",
        title: "接入界面",
        description: "把核心状态接入调度页。",
        size: "small",
        dependsOn: ["core"],
        expectedFiles: ["src/components/balance/orchestrator-panel.tsx"],
        acceptanceCriteria: ["页面能显示任务状态"],
        verificationCommands: [command("npm", ["run", "typecheck"])],
        preferredAgent: null,
      },
    ],
  };
}

function expectInvalid(mutator: (value: Record<string, unknown>) => void): void {
  const value = structuredClone(validPlan()) as unknown as Record<string, unknown>;
  mutator(value);
  assert.throws(() => parseOrchestratorPlan(value));
}

test("parses a strict valid plan and rejects unknown fields", () => {
  assert.deepEqual(parseOrchestratorPlan(validPlan()), validPlan());
  expectInvalid((value) => {
    value.extra = true;
  });
  expectInvalid((value) => {
    const tasks = value.tasks as Array<Record<string, unknown>>;
    tasks[0]!.extra = true;
  });
});

test("enforces task count, identifiers, text and required arrays", () => {
  expectInvalid((value) => {
    value.tasks = [];
  });
  expectInvalid((value) => {
    const task = (value.tasks as unknown[])[0]!;
    value.tasks = Array.from({ length: 13 }, (_, index) => ({
      ...(task as object),
      id: `task-${index}`,
    }));
  });
  expectInvalid((value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.id = "Bad_ID";
  });
  expectInvalid((value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.acceptanceCriteria = [];
  });
  expectInvalid((value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.verificationCommands = [];
  });
});

test("rejects unknown, self and cyclic dependencies", () => {
  expectInvalid((value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.dependsOn = ["missing"];
  });
  expectInvalid((value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.dependsOn = ["core"];
  });
  expectInvalid((value) => {
    const tasks = value.tasks as Array<Record<string, unknown>>;
    tasks[0]!.dependsOn = ["ui"];
    tasks[1]!.dependsOn = ["core"];
  });
});

test("rejects unsafe expected file paths", () => {
  for (const file of ["/etc/passwd", "../secret", "src/../../secret", "C:/secret", "src\\secret"]) {
    expectInvalid((value) => {
      (value.tasks as Array<Record<string, unknown>>)[0]!.expectedFiles = [file];
    });
  }
});

test("accepts only the verification executable allowlist and bounded arguments", () => {
  assert.throws(() =>
    validateVerificationCommand({ executable: "bash", args: ["-lc", "echo bad"] } as never),
  );
  assert.throws(() => validateVerificationCommand(command("npm", ["run", "bad\ncommand"])));
  assert.throws(() => validateVerificationCommand(command("npm", Array.from({ length: 31 }, () => "x"))));
  assert.throws(() => validateVerificationCommand(command("npm", ["x".repeat(501)])));
  assert.deepEqual(validateVerificationCommand(command()), command());
});

test("uses a closed grammar for git verification", () => {
  const allowed: VerificationCommand[] = [
    command("git", ["diff", "--check"]),
    command("git", ["status", "--short"]),
    command("git", ["rev-parse", "--verify", "HEAD"]),
    command("git", ["show", "--stat", "--oneline", "HEAD"]),
  ];
  for (const item of allowed) assert.deepEqual(validateVerificationCommand(item), item);

  const rejected = [
    ["-c", "core.hooksPath=/tmp/hooks", "diff"],
    ["--config-env", "credential.helper=HELPER", "status"],
    ["diff", "--ext-diff"],
    ["diff", "--no-index", "a", "b"],
    ["push"],
    ["reset", "--hard"],
    ["clean", "-fdx"],
    ["checkout", "--", "file"],
    ["restore", "file"],
    ["rebase", "main"],
    ["merge", "main"],
    ["show", "other-ref"],
  ];
  for (const args of rejected) {
    assert.throws(() => validateVerificationCommand(command("git", args)), args.join(" "));
  }
});

test("rejects interpreter eval and dependency or publishing mutations", () => {
  for (const item of [
    command("node", ["-e", "process.exit()"]),
    command("node", ["--eval", "process.exit()"]),
    command("python3", ["-c", "print(1)"]),
    command("npm", ["install", "pkg"]),
    command("npm", ["publish"]),
    command("pnpm", ["add", "pkg"]),
    command("yarn", ["dlx", "pkg"]),
    command("bun", ["install"]),
  ]) {
    assert.throws(() => validateVerificationCommand(item));
  }
  assert.deepEqual(validateVerificationCommand(command("cargo", ["test"])), command("cargo", ["test"]));
});

test("serializes overlapping exact, directory and glob scopes deterministically", () => {
  const plan = validPlan();
  plan.tasks[1]!.dependsOn = [];
  plan.tasks[0]!.expectedFiles = ["src/lib/orchestrator"];
  plan.tasks[1]!.expectedFiles = ["src/lib/orchestrator/client.ts"];
  const serialized = serializeOverlappingTasks(plan);
  assert.deepEqual(serialized.tasks[1]!.dependsOn, ["core"]);
  assert.deepEqual(topologicalTaskIds(serialized), ["core", "ui"]);

  const glob = validPlan();
  glob.tasks[1]!.dependsOn = [];
  glob.tasks[0]!.expectedFiles = ["src/**/*.ts"];
  assert.deepEqual(serializeOverlappingTasks(glob).tasks[1]!.dependsOn, ["core"]);
});

test("does not add a cycle when an existing dependency already serializes overlap", () => {
  const plan = validPlan();
  plan.tasks[0]!.dependsOn = ["ui"];
  plan.tasks[1]!.dependsOn = [];
  plan.tasks[0]!.expectedFiles = ["src/shared.ts"];
  plan.tasks[1]!.expectedFiles = ["src/shared.ts"];
  const serialized = serializeOverlappingTasks(plan);
  assert.deepEqual(serialized.tasks[0]!.dependsOn, ["ui"]);
  assert.deepEqual(serialized.tasks[1]!.dependsOn, []);
  assert.deepEqual(topologicalTaskIds(serialized), ["ui", "core"]);
});

test("exports strict JSON Schema generated from the plan contract", () => {
  const schema = orchestratorPlanJsonSchema as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["title", "summary", "tasks"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.tasks!.type, "array");
  assert.equal(properties.tasks!.minItems, 1);
  assert.equal(properties.tasks!.maxItems, 12);
});

test("computes a stable fingerprint over the complete confirmed draft", () => {
  const base = {
    runId: "run_20260823120000_012345abcdef",
    repositoryPath: "/tmp/repository",
    repositoryDevice: 1,
    repositoryInode: 2,
    repositoryDirtyAtAnalysis: false,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    coordinator: "codex" as const,
    prompt: "实现功能",
    plan: validPlan(),
    assignedTasks: validPlan().tasks.map((task) => ({ ...task, assignedAgent: "codex" as const })),
  } satisfies Omit<PlanDraft, "fingerprint" | "createdAt">;
  const first = fingerprintPlan(base);
  const reordered = {
    coordinator: base.coordinator,
    assignedTasks: base.assignedTasks,
    plan: base.plan,
    prompt: base.prompt,
    baseSha: base.baseSha,
    baseBranch: base.baseBranch,
    repositoryDirtyAtAnalysis: base.repositoryDirtyAtAnalysis,
    repositoryInode: base.repositoryInode,
    repositoryDevice: base.repositoryDevice,
    repositoryPath: base.repositoryPath,
    runId: base.runId,
  };
  assert.equal(fingerprintPlan(reordered), first);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(fingerprintPlan({ ...base, prompt: "另一个计划" }), first);
});
