import { z } from "zod";
import type { NativeAgentId, OrchestratorSettings, QuotaCapacityEvidence } from "./types.ts";

const finiteNonnegative = z.number().finite().nonnegative();

export const quotaCapacityEvidenceSchema: z.ZodType<QuotaCapacityEvidence> = z
  .object({
    remainingLowUsd: finiteNonnegative.nullable(),
    totalHighUsd: finiteNonnegative.nullable(),
    valueConfidence: z.enum(["none", "low", "medium", "high"]),
    officialRemainingPct: z.number().finite().min(0).max(100).nullable(),
  })
  .strict();

const nativeAgentSettingSchema = (agent: NativeAgentId) =>
  z
    .object({
      agent: z.literal(agent),
      enabled: z.boolean(),
      binaryPath: z.string().min(1).max(4_096).nullable(),
      allowUnknownQuota: z.boolean(),
    })
    .strict();

export const orchestratorSettingsSchema: z.ZodType<OrchestratorSettings> = z
  .object({
    globalMaxConcurrency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    agents: z
      .object({
        claude: nativeAgentSettingSchema("claude"),
        codex: nativeAgentSettingSchema("codex"),
        grok: nativeAgentSettingSchema("grok"),
      })
      .strict(),
  })
  .strict();
