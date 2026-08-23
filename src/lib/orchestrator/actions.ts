import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertOrchestratorRequestAllowed } from "./request-guard.server.ts";
import { orchestratorSettingsSchema, quotaCapacityEvidenceSchema } from "./schemas.ts";
import { getOrchestratorSupervisor } from "./supervisor.server.ts";

const authorizationSchema = z.string().min(1).max(128);
const agentSchema = z.enum(["claude", "codex", "grok"]);
const runIdSchema = z.string().regex(/^run_[0-9]{14}_[a-f0-9]{12}$/);
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "repository path must not contain NUL")
  .refine((value) => value.startsWith("/"), "repository path must be absolute");
const baseShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

const authorizedInputSchema = z
  .object({
    authorization: authorizationSchema,
  })
  .strict();

const saveSettingsInputSchema = z
  .object({
    authorization: authorizationSchema,
    settings: orchestratorSettingsSchema,
  })
  .strict();

const validateRepositoryInputSchema = z
  .object({
    authorization: authorizationSchema,
    repoPath: repositoryPathSchema,
  })
  .strict();

const quotaEvidenceByAgentSchema = z
  .object({
    claude: quotaCapacityEvidenceSchema,
    codex: quotaCapacityEvidenceSchema,
    grok: quotaCapacityEvidenceSchema,
  })
  .strict();

const analyzePlanInputSchema = z
  .object({
    authorization: authorizationSchema,
    repositoryPath: repositoryPathSchema,
    prompt: z.string().trim().min(1).max(20_000),
    coordinator: z.union([z.literal("auto"), agentSchema]),
    quotaEvidence: quotaEvidenceByAgentSchema,
  })
  .strict();

const confirmedRepositorySchema = z
  .object({
    path: repositoryPathSchema,
    device: z.number().int().nonnegative().safe(),
    inode: z.number().int().nonnegative().safe(),
    baseSha: baseShaSchema,
  })
  .strict();

const startRunInputSchema = z
  .object({
    authorization: authorizationSchema,
    runId: runIdSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    trustedRepository: z.literal(true),
    confirmedRepository: confirmedRepositorySchema,
  })
  .strict();

const getRunInputSchema = z
  .object({
    authorization: authorizationSchema,
    runId: runIdSchema,
    afterSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

const runInputSchema = z
  .object({
    authorization: authorizationSchema,
    runId: runIdSchema,
  })
  .strict();

export const orchestratorActionInputSchemas = {
  getSettings: authorizedInputSchema,
  saveSettings: saveSettingsInputSchema,
  detectRuntimes: authorizedInputSchema,
  validateRepository: validateRepositoryInputSchema,
  analyzePlan: analyzePlanInputSchema,
  startRun: startRunInputSchema,
  getRun: getRunInputSchema,
  cancelRun: runInputSchema,
  listRuns: authorizedInputSchema,
} as const;

export const getNativeAgentSettings = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.getSettings.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.getSettings();
  });

export const saveNativeAgentSettings = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.saveSettings.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.saveSettings(data.settings);
  });

export const detectNativeAgentRuntimes = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.detectRuntimes.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.detectRuntimes();
  });

export const validateRepository = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.validateRepository.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.validateRepository(data.repoPath);
  });

export const analyzeOrchestratorPlan = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.analyzePlan.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.analyze({
      repositoryPath: data.repositoryPath,
      prompt: data.prompt,
      coordinator: data.coordinator,
      quotaEvidence: data.quotaEvidence,
    });
  });

export const startOrchestratorRun = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.startRun.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.start({
      runId: data.runId,
      fingerprint: data.fingerprint,
      trustedRepository: data.trustedRepository,
      confirmedRepository: data.confirmedRepository,
    });
  });

export const getOrchestratorRun = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.getRun.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.get(data.runId, data.afterSeq);
  });

export const cancelOrchestratorRun = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.cancelRun.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.cancel(data.runId);
  });

export const listOrchestratorRuns = createServerFn({ method: "POST" })
  .validator((value: unknown) => orchestratorActionInputSchemas.listRuns.parse(value))
  .handler(async ({ data }) => {
    assertOrchestratorRequestAllowed(data.authorization);
    const supervisor = await getOrchestratorSupervisor();
    return supervisor.list();
  });
