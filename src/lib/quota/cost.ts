import { lookupPricing, PRICING_VERSION, type PricingQuality } from "./pricing.ts";
import { finiteNonNeg, rawExclusiveTokens } from "./tokens.ts";
import type { UsageEvent } from "./types.ts";

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  imageUsd: number;
  totalUsd: number;
  pricingModel: string | null;
  pricingVersion: string | null;
  pricingQuality: PricingQuality;
  priced: boolean;
  openAiCredits: number | null;
}

export function costBreakdown(event: UsageEvent): CostBreakdown {
  if (event.anomalies?.length) {
    return {
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      imageUsd: 0,
      totalUsd: 0,
      pricingModel: null,
      pricingVersion: PRICING_VERSION,
      pricingQuality: "unknown",
      priced: false,
      openAiCredits: null,
    };
  }
  const uncached = finiteNonNeg(event.tokensIn);
  const output = finiteNonNeg(event.tokensOut);
  const cacheRead = finiteNonNeg(event.cacheRead);
  const w5 = finiteNonNeg(event.cacheWrite);
  const w1 = finiteNonNeg(event.cacheWrite1h ?? 0);
  const hit = lookupPricing(event.modelRaw, event.model);
  if (!hit.pricing || hit.quality === "unknown") {
    return {
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      imageUsd: 0,
      totalUsd: 0,
      pricingModel: null,
      pricingVersion: PRICING_VERSION,
      pricingQuality: "unknown",
      priced: false,
      openAiCredits: null,
    };
  }
  const p = hit.pricing;
  let quality = hit.quality;
  if (event.cacheWriteUnsplit && quality === "exact") quality = "family-fallback";
  let inputUsd = uncached * p.inputPerToken;
  let outputUsd = output * p.outputPerToken;
  let cacheReadUsd = cacheRead * p.cacheReadPerToken;
  let cacheWriteUsd = w5 * p.cacheWrite5mPerToken + w1 * p.cacheWrite1hPerToken;
  const contextTokens = uncached + cacheRead + w5 + w1;
  if (p.longContextThreshold != null && contextTokens > p.longContextThreshold) {
    inputUsd *= p.longContextInputMultiplier;
    cacheReadUsd *= p.longContextInputMultiplier;
    cacheWriteUsd *= p.longContextInputMultiplier;
    outputUsd *= p.longContextOutputMultiplier;
  }
  const imageUsd = 0;
  const totalUsd = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd + imageUsd;
  const openAiCredits =
    event.agent === "codex" && p.creditsPerUsd != null ? totalUsd * p.creditsPerUsd : null;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    imageUsd,
    totalUsd,
    pricingModel: hit.resolvedModel,
    pricingVersion: p.version,
    pricingQuality: quality,
    priced: Number.isFinite(totalUsd),
    openAiCredits,
  };
}

export function eventRawTokens(event: UsageEvent): number {
  return rawExclusiveTokens(event);
}
