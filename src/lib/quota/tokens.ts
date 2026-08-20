export function finiteNonNeg(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** OpenAI / Grok Responses: input_tokens includes cached_input_tokens. */
export function exclusiveCachedInput(inputTokens: number, cachedInputTokens: number): {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cachedExceedsInput: boolean;
} {
  const input = finiteNonNeg(inputTokens);
  const cached = finiteNonNeg(cachedInputTokens);
  const cachedExceedsInput = cached > input && input > 0;
  const cacheReadTokens = Math.min(cached, input);
  return {
    uncachedInputTokens: Math.max(0, input - cacheReadTokens),
    cacheReadTokens,
    cachedExceedsInput,
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
