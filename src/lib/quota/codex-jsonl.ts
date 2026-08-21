import type { CodexModelId, UsageAnomaly, UsageEvent } from "./types.ts";
import { clipTask } from "./claude-jsonl.ts";
import { parseCodexRateLimits, type OfficialSlice } from "./official.ts";
import { exclusiveCachedInput, normalizeToken } from "./tokens.ts";

export interface CodexSessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  model: string;
}

export function asCodexModel(raw: string): CodexModelId {
  const s = (raw || "").toLowerCase();
  if (s.includes("luna") || s.includes("mini") || s.includes("spark")) return "gpt-5.6-luna";
  if (s.includes("terra")) return "gpt-5.6-terra";
  if (s.includes("sol") || s.includes("5.6")) return "gpt-5.6-sol";
  if (s.includes("5.4")) return "gpt-5.4";
  return "gpt-5.6-sol";
}

export function parseCodexTs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw) {
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function applyCodexMetaLine(obj: Record<string, unknown>, meta: CodexSessionMeta): void {
  const payload = (obj.payload && typeof obj.payload === "object" ? obj.payload : obj) as Record<string, unknown>;
  const typ = obj.type;
  if (typ === "session_meta") {
    if (typeof payload.session_id === "string" && payload.session_id) meta.sessionId = payload.session_id;
    else if (typeof payload.id === "string" && payload.id) meta.sessionId = payload.id;
    if (typeof payload.cwd === "string" && payload.cwd) meta.cwd = payload.cwd;
    const nick = payload.agent_nickname;
    if (typeof nick === "string" && nick) meta.title = nick;
  }
  if (typ === "turn_context") {
    if (typeof payload.model === "string" && payload.model) meta.model = payload.model;
    if (typeof payload.cwd === "string" && payload.cwd) meta.cwd = payload.cwd;
  }
}

function usageFromLast(last: Record<string, unknown>): {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningMin: number;
  anomalies: UsageAnomaly[];
} {
  const split = exclusiveCachedInput(last.input_tokens, last.cached_input_tokens);
  const output = normalizeToken(last.output_tokens, "output_tokens");
  const cacheWrite = normalizeToken(last.cache_write_input_tokens, "cache_write_input_tokens");
  const reasoning = normalizeToken(last.reasoning_output_tokens, "reasoning_output_tokens");
  return {
    tokensIn: split.uncachedInputTokens,
    tokensOut: output.value,
    cacheRead: split.cacheReadTokens,
    cacheWrite: cacheWrite.value,
    reasoningMin: reasoning.value > 0 ? reasoning.value / 800 : 0,
    anomalies: [...split.anomalies, ...output.anomalies, ...cacheWrite.anomalies, ...reasoning.anomalies],
  };
}

export function parseCodexJsonlLine(
  line: string,
  meta: CodexSessionMeta,
): { event: UsageEvent | null; official: OfficialSlice | null } {
  const t = line.trim();
  if (!t) return { event: null, official: null };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return { event: null, official: null };
  }
  applyCodexMetaLine(obj, meta);
  const payload = (obj.payload && typeof obj.payload === "object" ? obj.payload : {}) as Record<string, unknown>;
  if (payload.type !== "token_count") return { event: null, official: null };
  const info = (payload.info && typeof payload.info === "object" ? payload.info : {}) as Record<string, unknown>;
  const last = (info.last_token_usage && typeof info.last_token_usage === "object"
    ? info.last_token_usage
    : null) as Record<string, unknown> | null;
  const ts = parseCodexTs(obj.timestamp) ?? Date.now();
  const sessionId = meta.sessionId;
  let official: OfficialSlice | null = null;
  if (payload.rate_limits && typeof payload.rate_limits === "object") {
    const rl = payload.rate_limits as Record<string, unknown>;
    official = parseCodexRateLimits(rl, {
      fetchedAt: ts,
      source: "session-rate-limits",
      planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
    });
  }
  if (!last) return { event: null, official };
  const counts = usageFromLast(last);
  if (
    counts.tokensIn + counts.tokensOut + counts.cacheRead + counts.cacheWrite <= 0
    && counts.anomalies.length === 0
  ) {
    return { event: null, official };
  }

  const event: UsageEvent = {
    id: `${sessionId}:${ts}`,
    agent: "codex",
    model: asCodexModel(meta.model),
    modelRaw: meta.model,
    ts,
    sessionId,
    task: clipTask(meta.title || meta.cwd || sessionId),
    tokensIn: counts.tokensIn,
    tokensOut: counts.tokensOut,
    cacheRead: counts.cacheRead,
    cacheWrite: counts.cacheWrite,
    reasoningMin: counts.reasoningMin,
    anomalies: counts.anomalies.length ? counts.anomalies : undefined,
  };
  return { event, official };
}

export function foldCodexTurns(events: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const ev of events) map.set(ev.id, ev);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
