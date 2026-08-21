import type { UsageAnomaly } from "./types.ts";

export function finiteNonNeg(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export interface NormalizedToken {
  value: number;
  anomalies: UsageAnomaly[];
}

export function normalizeToken(raw: unknown, field: string): NormalizedToken {
  if (raw == null || raw === "") return { value: 0, anomalies: [] };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return {
      value: 0,
      anomalies: [{ code: "non-finite-token", field, rawValue: String(raw) }],
    };
  }
  if (value < 0) {
    return {
      value: 0,
      anomalies: [{ code: "negative-token", field, rawValue: String(raw) }],
    };
  }
  if (!Number.isInteger(value)) {
    return {
      value: 0,
      anomalies: [{ code: "fractional-token", field, rawValue: String(raw) }],
    };
  }
  return { value, anomalies: [] };
}

/** OpenAI / Grok Responses: input_tokens includes cached_input_tokens. */
export function exclusiveCachedInput(inputRaw: unknown, cachedRaw: unknown): {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cachedExceedsInput: boolean;
  anomalies: UsageAnomaly[];
} {
  const input = normalizeToken(inputRaw, "input_tokens");
  const cached = normalizeToken(cachedRaw, "cached_input_tokens");
  const cachedExceedsInput = cached.value > input.value;
  const cacheReadTokens = Math.min(cached.value, input.value);
  const anomalies = [...input.anomalies, ...cached.anomalies];
  if (cachedExceedsInput) {
    anomalies.push({
      code: "cached-input-exceeds-input",
      field: "cached_input_tokens",
      rawValue: String(cachedRaw),
    });
  }
  return {
    uncachedInputTokens: Math.max(0, input.value - cacheReadTokens),
    cacheReadTokens,
    cachedExceedsInput,
    anomalies,
  };
}

export function claudeCacheWrites(usage: Record<string, unknown>): {
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  splitUnknown: boolean;
} {
  const nested = usage.cache_creation;
  if (nested && typeof nested === "object") {
    const o = nested as Record<string, unknown>;
    const w5 = finiteNonNeg(Number(o.ephemeral_5m_input_tokens ?? 0));
    const w1 = finiteNonNeg(Number(o.ephemeral_1h_input_tokens ?? 0));
    if (w5 > 0 || w1 > 0) return { cacheWrite5mTokens: w5, cacheWrite1hTokens: w1, splitUnknown: false };
  }
  const total = finiteNonNeg(
    Number(usage.cache_creation_input_tokens ?? usage.cache_write ?? usage.cacheWrite ?? 0),
  );
  return { cacheWrite5mTokens: total, cacheWrite1hTokens: 0, splitUnknown: total > 0 };
}

export function rawExclusiveTokens(e: {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}): number {
  return (
    finiteNonNeg(e.tokensIn) +
    finiteNonNeg(e.tokensOut) +
    finiteNonNeg(e.cacheRead) +
    finiteNonNeg(e.cacheWrite) +
    finiteNonNeg(e.cacheWrite1h ?? 0)
  );
}
