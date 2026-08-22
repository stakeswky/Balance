// quota-cache.ts —— 同构模块：schema + identity + hydrate。禁止 node 内建 import。
import { z } from "zod";
import type {
  AgentId,
  ModelId,
  UsageAnomalyCode,
  UsageEvent,
  UsageSpeed,
} from "./types.ts";

const modelRawPattern = /^[A-Za-z0-9._:/-]{1,128}$/;

export function isSafeModelRaw(value: string): boolean {
  return modelRawPattern.test(value)
    && !value.startsWith("/")
    && !value.includes("..")
    && !value.includes("\\");
}

const safeModelRawSchema = z.string().refine(isSafeModelRaw, "unsafe model identifier");

const cachedQuotaEventSchema = z.object({
  idHash: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.enum(["claude", "codex", "grok"]),
  model: safeModelRawSchema,
  modelRaw: safeModelRawSchema.optional(),
  ts: z.number().finite().nonnegative(),
  tokensIn: z.number().finite().nonnegative(),
  tokensOut: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  cacheWrite: z.number().finite().nonnegative(),
  cacheWrite1h: z.number().finite().nonnegative().optional(),
  cacheWriteUnsplit: z.boolean().optional(),
  imageInputTokens: z.number().finite().nonnegative().optional(),
  imageOutputTokens: z.number().finite().nonnegative().optional(),
  speed: z.enum(["standard", "fast", "unknown"]).optional(),
  anomalyCodes: z.array(z.enum([
    "negative-token",
    "non-finite-token",
    "fractional-token",
    "cached-input-exceeds-input",
  ])).max(8).optional(),
  reportedUsd: z.number().finite().nonnegative().optional(),
  reportedCostSchema: z.literal("grok-cli-1.0.0").optional(),
}).strict().superRefine((value, context) => {
  if ((value.reportedUsd == null) !== (value.reportedCostSchema == null)) {
    context.addIssue({ code: "custom", message: "reported cost fields must appear together" });
  }
});

const cachedLogCursorSchema = z.object({
  pathHash: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.enum(["claude", "codex", "grok"]),
  modelRaw: safeModelRawSchema.optional(),
  resumeOffset: z.number().int().nonnegative(),
  observedSize: z.number().int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
  ctimeMs: z.number().finite().nonnegative(),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.resumeOffset > value.observedSize) {
    context.addIssue({ code: "custom", message: "resumeOffset exceeds observedSize" });
  }
});

export const quotaCacheSnapshotSchema = z.object({
  version: z.literal(2),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  savedAt: z.number().finite().nonnegative(),
  historyTruncated: z.boolean(),
  truncatedBeforeMs: z.number().finite().nonnegative().nullable(),
  cursorSetComplete: z.boolean(),
  cursors: z.array(cachedLogCursorSchema).max(20_000),
  events: z.array(cachedQuotaEventSchema).max(100_000),
}).strict().superRefine((value, context) => {
  if (value.historyTruncated !== (value.truncatedBeforeMs != null)) {
    context.addIssue({
      code: "custom",
      message: "historyTruncated and truncatedBeforeMs must agree",
    });
  }
});

export function quotaEventIdentity(event: UsageEvent): string {
  return event.cacheIdentity ?? `import:${event.agent}:${event.id}`;
}

export interface CachedQuotaEvent {
  idHash: string;
  agent: AgentId;
  /** 未知未来值允许读取；hydrate 时保留安全标签并显式禁用计价。 */
  model: string;
  modelRaw?: string;
  ts: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cacheWriteUnsplit?: boolean;
  imageInputTokens?: number;
  imageOutputTokens?: number;
  speed?: UsageSpeed;
  anomalyCodes?: UsageAnomalyCode[];
  reportedUsd?: number;
  reportedCostSchema?: "grok-cli-1.0.0";
}

export interface CachedLogCursor {
  pathHash: string;
  agent: AgentId;
  modelRaw?: string;
  resumeOffset: number;
  observedSize: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

export interface QuotaCacheSnapshot {
  version: 2;
  snapshotId: string;
  savedAt: number;
  historyTruncated: boolean;
  truncatedBeforeMs: number | null;
  cursorSetComplete: boolean;
  cursors: CachedLogCursor[];
  events: CachedQuotaEvent[];
}

const knownCachedModels = new Set<ModelId>([
  "fable", "opus", "sonnet", "haiku",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  "gpt-5.4", "gpt-5.4-mini", "daybreak-blue", "daybreak-red",
  "grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20",
]);

const fallbackCachedModel: Record<AgentId, ModelId> = {
  claude: "sonnet",
  codex: "gpt-5.6-sol",
  grok: "grok-4.6",
};

export function hydrateCachedEvent(event: CachedQuotaEvent): UsageEvent {
  const divisor = 10_000_000_000;
  const modelKnown = knownCachedModels.has(event.model as ModelId);
  const model = modelKnown
    ? event.model as ModelId
    : fallbackCachedModel[event.agent];
  return {
    id: `quota-cache:${event.idHash}`,
    cacheIdentity: event.idHash,
    agent: event.agent,
    model,
    modelRaw: modelKnown ? event.modelRaw : event.model,
    pricingDisabled: !modelKnown,
    ts: event.ts,
    sessionId: "quota-cache",
    task: "历史额度缓存",
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    cacheWrite1h: event.cacheWrite1h,
    cacheWriteUnsplit: event.cacheWriteUnsplit,
    imageInputTokens: event.imageInputTokens,
    imageOutputTokens: event.imageOutputTokens,
    speed: event.speed,
    reasoningMin: 0,
    anomalies: event.anomalyCodes?.map((code) => ({
      code,
      field: "redacted",
      rawValue: "redacted",
    })),
    reportedCost: event.reportedUsd == null
      ? undefined
      : {
          totalRawValue: event.reportedUsd * divisor,
          byModelRawValue: {},
          rawUnit: "usd-ticks",
          usdValue: event.reportedUsd,
          divisor,
          sourceField: "sanitized-quota-cache",
          schemaVersion: event.reportedCostSchema ?? null,
          semantics: "api-equivalent",
        },
  };
}
