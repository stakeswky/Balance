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
  recomputedUsd: number;
  reportedUsd: number | null;
  costSource: "token-recomputed" | "provider-reported";
  aggregatedTurnTierUncertain: boolean;
  pricedTokens: number;
  fullyPriced: boolean;
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
      recomputedUsd: 0,
      reportedUsd: null,
      costSource: "token-recomputed",
      aggregatedTurnTierUncertain: false,
      pricedTokens: 0,
      fullyPriced: false,
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
  const rawModel = event.modelRaw?.trim();
  const hit = rawModel
    ? lookupPricing(rawModel, event.model, event.ts)
    : { pricing: null, quality: "unknown" as const, resolvedModel: null };
  if (!hit.pricing || hit.quality === "unknown") {
    return {
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      imageUsd: 0,
      totalUsd: 0,
      recomputedUsd: 0,
      reportedUsd: null,
      costSource: "token-recomputed",
      aggregatedTurnTierUncertain: false,
      pricedTokens: 0,
      fullyPriced: false,
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
  const fast = event.speed === "fast";
  const apiMultiplier = fast ? p.fastApiMultiplier ?? 1 : 1;
  inputUsd *= apiMultiplier;
  outputUsd *= apiMultiplier;
  cacheReadUsd *= apiMultiplier;
  cacheWriteUsd *= apiMultiplier;
  const imageInput = finiteNonNeg(event.imageInputTokens ?? 0);
  const imageOutput = finiteNonNeg(event.imageOutputTokens ?? 0);
  const imageInputPriced = imageInput === 0 || p.imageInputPerToken != null;
  const imageOutputPriced = imageOutput === 0 || p.imageOutputPerToken != null;
  const imageUsd =
    imageInput * (p.imageInputPerToken ?? 0) +
    imageOutput * (p.imageOutputPerToken ?? 0);
  const uncertainWriteTokens = event.cacheWriteUnsplit ? w5 : 0;
  const pricedTokens =
    uncached + output + cacheRead + w5 + w1 - uncertainWriteTokens +
    (imageInputPriced ? imageInput : 0) +
    (imageOutputPriced ? imageOutput : 0);
  let fullyPriced = imageInputPriced && imageOutputPriced && uncertainWriteTokens === 0;
  const recomputedUsd = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd + imageUsd;
  const reportedUsd = event.reportedCost?.semantics === "api-equivalent"
    ? event.reportedCost.usdValue
    : null;
  const useReported = event.agent === "grok" && reportedUsd != null;
  const totalUsd = useReported ? reportedUsd : recomputedUsd;
  const costSource = useReported ? "provider-reported" as const : "token-recomputed" as const;
  const aggregatedTurnTierUncertain = event.agent === "grok"
    && p.longContextThreshold != null
    && contextTokens > p.longContextThreshold
    && !useReported;
  if (aggregatedTurnTierUncertain) fullyPriced = false;
  const creditMultiplier = fast ? p.fastCreditMultiplier ?? 1 : 1;
  const openAiCredits =
    event.agent === "codex" && p.creditsPerUsd != null
      ? totalUsd * p.creditsPerUsd * creditMultiplier
      : null;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    imageUsd,
    totalUsd,
    recomputedUsd,
    reportedUsd,
    costSource,
    aggregatedTurnTierUncertain,
    pricedTokens,
    fullyPriced,
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
