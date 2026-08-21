import type { UsageAnomaly, UsageSpeed } from "./types.ts";

export function usageSpeed(raw: unknown): UsageSpeed {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  if (value === "fast") return "fast";
  if (value === "standard") return "standard";
  return "unknown";
}

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
  anomalies: UsageAnomaly[];
} {
  const nested = usage.cache_creation;
  if (nested && typeof nested === "object") {
    const value = nested as Record<string, unknown>;
    const fiveMinute = normalizeToken(
      value.ephemeral_5m_input_tokens,
      "cache_creation.ephemeral_5m_input_tokens",
    );
    const oneHour = normalizeToken(
      value.ephemeral_1h_input_tokens,
      "cache_creation.ephemeral_1h_input_tokens",
    );
    if (fiveMinute.value > 0 || oneHour.value > 0 || fiveMinute.anomalies.length || oneHour.anomalies.length) {
      return {
        cacheWrite5mTokens: fiveMinute.value,
        cacheWrite1hTokens: oneHour.value,
        splitUnknown: false,
        anomalies: [...fiveMinute.anomalies, ...oneHour.anomalies],
      };
    }
  }
  const totalRaw = usage.cache_creation_input_tokens ?? usage.cache_write ?? usage.cacheWrite;
  const total = normalizeToken(totalRaw, "cache_creation_input_tokens");
  return {
    cacheWrite5mTokens: total.value,
    cacheWrite1hTokens: 0,
    splitUnknown: total.value > 0,
    anomalies: total.anomalies,
  };
}

export function optionalModel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value || undefined;
}

export function normalizeImageTokens(
  inputRaw: unknown,
  outputRaw: unknown,
): {
  imageInputTokens: number;
  imageOutputTokens: number;
  anomalies: UsageAnomaly[];
} {
  const input = normalizeToken(inputRaw, "image_input_tokens");
  const output = normalizeToken(outputRaw, "image_output_tokens");
  return {
    imageInputTokens: input.value,
    imageOutputTokens: output.value,
    anomalies: [...input.anomalies, ...output.anomalies],
  };
}

export function rawExclusiveTokens(e: {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  imageInputTokens?: number;
  imageOutputTokens?: number;
}): number {
  return (
    finiteNonNeg(e.tokensIn) +
    finiteNonNeg(e.tokensOut) +
    finiteNonNeg(e.cacheRead) +
    finiteNonNeg(e.cacheWrite) +
    finiteNonNeg(e.cacheWrite1h ?? 0) +
    finiteNonNeg(e.imageInputTokens ?? 0) +
    finiteNonNeg(e.imageOutputTokens ?? 0)
  );
}
