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
