import type { GrokModelId, ProviderReportedCost, UsageAnomaly, UsageEvent } from "./types.ts";
import { clipTask } from "./claude-jsonl.ts";
import { exclusiveCachedInput, normalizeImageTokens, normalizeToken, optionalModel, usageSpeed } from "./tokens.ts";

export const GROK_TICK_DIVISORS: Readonly<Record<string, number>> = {
  "grok-cli-1.0.0": 10_000_000_000,
};

export function grokReportedCost(
  totalRawValue: number,
  byModelRawValue: Record<string, number>,
  schemaVersion: string | null,
): ProviderReportedCost {
  const divisor = schemaVersion ? GROK_TICK_DIVISORS[schemaVersion] ?? null : null;
  const validTotal = Number.isFinite(totalRawValue) && totalRawValue >= 0;
  const validModels = Object.values(byModelRawValue).every(
    (value) => Number.isFinite(value) && value >= 0,
  );
  const modelTotal = Object.values(byModelRawValue).reduce((sum, value) => sum + value, 0);
  const reconciles = !Object.keys(byModelRawValue).length || Math.abs(modelTotal - totalRawValue) <= 1;
  const verified = divisor != null && validTotal && validModels && reconciles;
  return {
    totalRawValue,
    byModelRawValue,
    rawUnit: "usd-ticks",
    usdValue: verified ? totalRawValue / divisor : null,
    divisor: verified ? divisor : null,
    sourceField: "usage.costUsdTicks",
    schemaVersion,
    semantics: verified ? "api-equivalent" : "unverified",
  };
}

export interface GrokSessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  model?: string;
}

export function asGrokModel(raw: string): GrokModelId {
  const value = (raw || "").toLowerCase();
  if (value.includes("4.20")) return "grok-4.20";
  if (value.includes("4.6")) return "grok-4.6";
  if (value.includes("4.5")) return "grok-4.5";
  if (value.includes("4.3")) return "grok-4.3";
  return "grok-4.6";
}

export function parseGrokTs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 1e9) return parseGrokTs(asNum);
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function usageFrom(u: Record<string, unknown>): {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  anomalies: UsageAnomaly[];
} {
  const split = exclusiveCachedInput(
    u.inputTokens ?? u.input_tokens ?? u.tokensIn,
    u.cachedReadTokens ?? u.cache_read_input_tokens ?? u.cacheRead,
  );
  const output = normalizeToken(
    u.outputTokens ?? u.output_tokens ?? u.tokensOut,
    "output_tokens",
  );
  const write = normalizeToken(
    u.cacheCreationTokens ?? u.cache_creation_input_tokens ?? u.cacheWrite,
    "cache_creation_input_tokens",
  );
  const images = normalizeImageTokens(
    u.image_input_tokens ?? u.imageInputTokens,
    u.image_output_tokens ?? u.imageOutputTokens,
  );
  return {
    tokensIn: split.uncachedInputTokens,
    tokensOut: output.value,
    cacheRead: split.cacheReadTokens,
    cacheWrite: write.value,
    imageInputTokens: images.imageInputTokens,
    imageOutputTokens: images.imageOutputTokens,
    anomalies: [...split.anomalies, ...output.anomalies, ...write.anomalies, ...images.anomalies],
  };
}

function modelFromUsage(usage: Record<string, unknown>, fallback: string | undefined): string | undefined {
  const models = usage.modelUsage;
  if (models && typeof models === "object") {
    const keys = Object.keys(models as Record<string, unknown>);
    if (keys[0]) return keys[0];
  }
  return fallback;
}

export function parseGrokUpdateLine(line: string, meta: GrokSessionMeta): UsageEvent | null {
  const t = line.trim();
  if (!t) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  const params = (obj.params && typeof obj.params === "object" ? obj.params : obj) as Record<string, unknown>;
  const update = (params.update && typeof params.update === "object" ? params.update : params) as Record<
    string,
    unknown
  >;
  if (update.sessionUpdate !== "turn_completed") return null;
  const usageRaw = update.usage;
  if (!usageRaw || typeof usageRaw !== "object") return null;
  const usage = usageRaw as Record<string, unknown>;
  const speed = usageSpeed(usage.speed);
  const counts = usageFrom(usage);
  if (
    counts.tokensIn + counts.tokensOut + counts.cacheRead + counts.cacheWrite
      + counts.imageInputTokens + counts.imageOutputTokens <= 0
    && counts.anomalies.length === 0
  ) return null;

  const metaBlock = (params._meta && typeof params._meta === "object" ? params._meta : obj._meta) as
    | Record<string, unknown>
    | undefined;
  const ts =
    parseGrokTs(metaBlock?.agentTimestampMs) ?? parseGrokTs(obj.timestamp) ?? parseGrokTs(update.timestamp) ?? Date.now();
  const sessionId = String(params.sessionId ?? meta.sessionId);
  const promptId = String(update.prompt_id ?? metaBlock?.eventId ?? `${sessionId}:${ts}`);
  const modelRaw = modelFromUsage(usage, optionalModel(meta.model));
  const ticksRaw = usage.costUsdTicks;
  const ticks = typeof ticksRaw === "number" ? ticksRaw : null;
  const byModel: Record<string, number> = {};
  const models = usage.modelUsage;
  if (models && typeof models === "object") {
    for (const [key, val] of Object.entries(models as Record<string, unknown>)) {
      if (val && typeof val === "object" && typeof (val as { costUsdTicks?: unknown }).costUsdTicks === "number") {
        byModel[key] = (val as { costUsdTicks: number }).costUsdTicks;
      }
    }
  }
  const schemaVersionRaw = usage.schemaVersion ?? update.schemaVersion ?? obj.schemaVersion;
  const schemaVersion =
    typeof schemaVersionRaw === "string" && schemaVersionRaw ? schemaVersionRaw : null;
  const reportedCost = ticks == null
    ? undefined
    : grokReportedCost(ticks, byModel, schemaVersion);
  return {
    id: promptId,
    agent: "grok",
    model: asGrokModel(modelRaw ?? ""),
    modelRaw,
    ts,
    sessionId,
    task: clipTask(meta.title || meta.cwd || sessionId),
    ...counts,
    reasoningMin: 0,
    reportedCost,
    speed,
    anomalies: counts.anomalies.length ? counts.anomalies : undefined,
  };
}

export function foldGrokTurns(events: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const ev of events) map.set(ev.id, ev);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
