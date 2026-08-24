import { z } from "zod";
import { QUOTA_CLOCK_SKEW_MS, QUOTA_RESET_MAX_FUTURE_MS } from "./quota-policy.ts";
import type {
  ClientQuotaEvidence,
  NativeAgentId,
  OrchestratorSettings,
  QuotaCapacityEvidence,
} from "./types.ts";

const observedTimestamp = z.number().int().nonnegative().safe().refine(
  (value) => value <= Date.now() + QUOTA_CLOCK_SKEW_MS,
  "observation timestamp is too far in the future",
);
const resetTimestamp = z.number().int().nonnegative().safe().refine(
  (value) => value <= Date.now() + QUOTA_RESET_MAX_FUTURE_MS,
  "reset timestamp is implausibly far in the future",
);
const sourceSchema = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/i);

const clientQuotaEvidenceShape = {
    officialRemainingPct: z.number().finite().min(0).max(100).nullable(),
    officialObservedAt: observedTimestamp.nullable(),
    officialResetsAt: resetTimestamp.nullable(),
    officialFresh: z.boolean(),
    officialSource: sourceSchema.nullable(),
    l3RemainingPct: z.number().finite().min(0).max(100).nullable(),
    l3Confidence: z.enum(["none", "low", "medium", "high"]),
    l3ObservedAt: observedTimestamp.nullable(),
} as const;

function refineClientQuotaEvidence(
  value: ClientQuotaEvidence,
  context: z.RefinementCtx,
): void {
  if (
    value.officialFresh
    && (value.officialRemainingPct === null || value.officialObservedAt === null || value.officialSource === null)
  ) {
    context.addIssue({ code: "custom", message: "fresh official evidence requires percentage, observation and source" });
  }
  if (
    value.l3Confidence !== "none"
    && (value.l3RemainingPct === null || value.l3ObservedAt === null)
  ) {
    context.addIssue({ code: "custom", message: "L3 confidence requires percentage and observation" });
  }
}

export const clientQuotaEvidenceSchema: z.ZodType<ClientQuotaEvidence> = z
  .object(clientQuotaEvidenceShape)
  .strict()
  .superRefine(refineClientQuotaEvidence);

export const quotaCapacityEvidenceSchema: z.ZodType<QuotaCapacityEvidence> = z.object({
    ...clientQuotaEvidenceShape,
    l3Trusted: z.boolean(),
    computedExecutionUnits: z.number().int().min(0).max(10),
    admissionSource: z.enum(["official", "l3-fallback", "unknown-allowed", "excluded"]),
    diagnostics: z.array(z.string().min(1).max(1_000)).max(50),
  }).strict().superRefine(refineClientQuotaEvidence);

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
