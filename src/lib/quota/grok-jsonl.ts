import type { GrokModelId, UsageAnomaly, UsageEvent } from "./types.ts";
import { clipTask } from "./claude-jsonl.ts";
import { exclusiveCachedInput, normalizeToken, optionalModel } from "./tokens.ts";

export interface GrokSessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  model?: string;
}

export function asGrokModel(raw: string): GrokModelId {
  const s = (raw || "").toLowerCase();
  if (s.includes("4.5")) return "grok-4.5";
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
  return {
    tokensIn: split.uncachedInputTokens,
    tokensOut: output.value,
    cacheRead: split.cacheReadTokens,
    cacheWrite: write.value,
    anomalies: [...split.anomalies, ...output.anomalies, ...write.anomalies],
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
  const counts = usageFrom(usage);
  if (
    counts.tokensIn + counts.tokensOut + counts.cacheRead + counts.cacheWrite <= 0
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
  const ticks = typeof usage.costUsdTicks === "number" ? usage.costUsdTicks : null;
  const byModel: Record<string, number> = {};
  const models = usage.modelUsage;
  if (models && typeof models === "object") {
    for (const [key, val] of Object.entries(models as Record<string, unknown>)) {
      if (val && typeof val === "object" && typeof (val as { costUsdTicks?: unknown }).costUsdTicks === "number") {
        byModel[key] = (val as { costUsdTicks: number }).costUsdTicks;
      }
    }
  }
  return {
    id: promptId,
    agent: "grok",
    model: asGrokModel(modelRaw ?? ""),
    modelRaw,
    ts,
    sessionId,
    task: clipTask(meta.title || meta.cwd || sessionId),
    tokensIn: counts.tokensIn,
    tokensOut: counts.tokensOut,
    cacheRead: counts.cacheRead,
    cacheWrite: counts.cacheWrite,
    reasoningMin: 0,
    reportedCostTicks: ticks,
    reportedCostByModel: Object.keys(byModel).length ? byModel : undefined,
    anomalies: counts.anomalies.length ? counts.anomalies : undefined,
  };
}

export function foldGrokTurns(events: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const ev of events) map.set(ev.id, ev);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
