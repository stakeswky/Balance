export type AntigravityQuotaGroup = "gemini" | "claude-gpt";
export type AntigravityPricingSemantics =
  | "google-api-equivalent"
  | "anthropic-api-estimate"
  | "unpriced";

export interface AntigravityUsageEvent {
  ts: number;
  model: string;
  quotaGroup: AntigravityQuotaGroup;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  thinkingTokens: number;
  responseTokens: number;
}

export interface AntigravityUsageScanResult {
  events: AntigravityUsageEvent[];
  databasesRead: number;
  filesSkipped: number;
  truncated: boolean;
  fetchedAt: number;
  source: "antigravity-conversation-db";
}

export function antigravityQuotaGroup(model: string): AntigravityQuotaGroup {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gemini-") ? "gemini" : "claude-gpt";
}

export interface AntigravityUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  responseTokens: number;
  totalTokens: number;
  pricedTokens: number;
  apiEquivalentUsd: number;
  pricingCoverage: number;
}

export interface AntigravityModelUsage extends AntigravityUsageTotals {
  model: string;
  quotaGroup: AntigravityQuotaGroup;
  pricingSemantics: AntigravityPricingSemantics;
}

export interface AntigravityGroupUsage extends AntigravityUsageTotals {
  group: AntigravityQuotaGroup;
  models: AntigravityModelUsage[];
}

export interface AntigravityUsageSummary extends AntigravityUsageTotals {
  groups: AntigravityGroupUsage[];
  models: AntigravityModelUsage[];
}

interface PriceRate {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  semantics: Exclude<AntigravityPricingSemantics, "unpriced">;
}

interface PricedEvent {
  usd: number;
  pricedTokens: number;
  semantics: AntigravityPricingSemantics;
}

const MILLION = 1_000_000;
const GEMINI_FLASH_PRICE_CHANGE = Date.parse("2027-01-01T00:00:00Z");

function priceRate(event: AntigravityUsageEvent): PriceRate | null {
  const model = event.model.toLowerCase();
  if (model.startsWith("gemini-3.7-flash-") || model.startsWith("gemini-3.6-flash-")) {
    return event.ts < GEMINI_FLASH_PRICE_CHANGE
      ? { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075, semantics: "google-api-equivalent" }
      : { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15, semantics: "google-api-equivalent" };
  }
  if (model.startsWith("gemini-3.5-flash-")) {
    return { inputPerM: 1.5, outputPerM: 9, cacheReadPerM: 0.15, semantics: "google-api-equivalent" };
  }
  if (model.startsWith("gemini-3.1-pro-")) {
    const context = event.tokensIn + event.cacheRead + event.cacheWrite;
    return context > 200_000
      ? { inputPerM: 4, outputPerM: 18, cacheReadPerM: 0.4, semantics: "google-api-equivalent" }
      : { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2, semantics: "google-api-equivalent" };
  }
  if (model === "claude-sonnet-4-6") {
    return { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, semantics: "anthropic-api-estimate" };
  }
  if (model === "claude-opus-4-6-thinking" || model === "claude-opus-4-6") {
    return { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, semantics: "anthropic-api-estimate" };
  }
  return null;
}

function price(event: AntigravityUsageEvent): PricedEvent {
  const rate = priceRate(event);
  if (!rate) return { usd: 0, pricedTokens: 0, semantics: "unpriced" };
  return {
    usd:
      event.tokensIn * rate.inputPerM / MILLION
      + event.tokensOut * rate.outputPerM / MILLION
      + event.cacheRead * rate.cacheReadPerM / MILLION,
    pricedTokens: event.tokensIn + event.tokensOut + event.cacheRead,
    semantics: rate.semantics,
  };
}

function emptyTotals(): AntigravityUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    pricedTokens: 0,
    apiEquivalentUsd: 0,
    pricingCoverage: 1,
  };
}

function addEvent(target: AntigravityUsageTotals, event: AntigravityUsageEvent): boolean {
  if (!Number.isSafeInteger(event.ts) || event.ts < 0) return false;
  const priced = price(event);
  const values = [
    event.tokensIn,
    event.tokensOut,
    event.cacheRead,
    event.cacheWrite,
    event.thinkingTokens,
    event.responseTokens,
    priced.pricedTokens,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  const eventTotal = event.tokensIn + event.tokensOut + event.cacheRead + event.cacheWrite;
  const next = {
    calls: target.calls + 1,
    inputTokens: target.inputTokens + event.tokensIn,
    outputTokens: target.outputTokens + event.tokensOut,
    cacheReadTokens: target.cacheReadTokens + event.cacheRead,
    cacheWriteTokens: target.cacheWriteTokens + event.cacheWrite,
    thinkingTokens: target.thinkingTokens + event.thinkingTokens,
    responseTokens: target.responseTokens + event.responseTokens,
    totalTokens: target.totalTokens + eventTotal,
    pricedTokens: target.pricedTokens + priced.pricedTokens,
  };
  if (!Number.isSafeInteger(eventTotal) || Object.values(next).some((value) => !Number.isSafeInteger(value))) {
    return false;
  }
  const nextUsd = target.apiEquivalentUsd + priced.usd;
  if (!Number.isFinite(nextUsd) || nextUsd < 0) return false;
  Object.assign(target, next, { apiEquivalentUsd: nextUsd });
  target.pricingCoverage = target.totalTokens > 0 ? target.pricedTokens / target.totalTokens : 1;
  return true;
}

function addTotals(target: AntigravityUsageTotals, source: AntigravityUsageTotals): void {
  target.calls += source.calls;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.thinkingTokens += source.thinkingTokens;
  target.responseTokens += source.responseTokens;
  target.totalTokens += source.totalTokens;
  target.pricedTokens += source.pricedTokens;
  target.apiEquivalentUsd += source.apiEquivalentUsd;
  target.pricingCoverage = target.totalTokens > 0 ? target.pricedTokens / target.totalTokens : 1;
}

export function aggregateAntigravityUsage(
  events: AntigravityUsageEvent[],
  since: number,
): AntigravityUsageSummary {
  const byModel = new Map<string, AntigravityModelUsage>();
  const totals = emptyTotals();
  for (const event of events) {
    if (event.ts < since) continue;
    if (!addEvent(totals, event)) continue;
    let model = byModel.get(event.model);
    if (!model) {
      const priced = price(event);
      model = {
        ...emptyTotals(),
        model: event.model,
        quotaGroup: event.quotaGroup,
        pricingSemantics: priced.semantics,
      };
      byModel.set(event.model, model);
    }
    addEvent(model, event);
  }
  const models = Array.from(byModel.values()).sort((left, right) => left.model.localeCompare(right.model));
  const groups: AntigravityGroupUsage[] = (["gemini", "claude-gpt"] as const).map((group) => {
    const groupModels = models.filter((model) => model.quotaGroup === group);
    const totals = emptyTotals();
    for (const model of groupModels) addTotals(totals, model);
    return { ...totals, group, models: groupModels };
  });
  return { ...totals, groups, models };
}

export function antigravityModelLabel(model: string): string {
  const labels: Record<string, string> = {
    "gemini-3.7-flash-high": "Gemini 3.7 Flash · High",
    "gemini-3.7-flash-medium": "Gemini 3.7 Flash · Medium",
    "gemini-3.7-flash-low": "Gemini 3.7 Flash · Low",
    "gemini-3.6-flash-high": "Gemini 3.6 Flash · High",
    "gemini-3.6-flash-medium": "Gemini 3.6 Flash · Medium",
    "gemini-3.6-flash-low": "Gemini 3.6 Flash · Low",
    "gemini-3.5-flash-high": "Gemini 3.5 Flash · High",
    "gemini-3.5-flash-medium": "Gemini 3.5 Flash · Medium",
    "gemini-3.5-flash-low": "Gemini 3.5 Flash · Low",
    "gemini-3.1-pro-high": "Gemini 3.1 Pro · High",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro · Low",
    "claude-sonnet-4-6": "Claude Sonnet 4.6 · Thinking",
    "claude-opus-4-6": "Claude Opus 4.6",
    "claude-opus-4-6-thinking": "Claude Opus 4.6 · Thinking",
    "gpt-oss-120b-medium": "GPT-OSS 120B · Medium",
  };
  return labels[model] ?? model;
}
