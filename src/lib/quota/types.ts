export type AgentId = "claude" | "codex";

export type ClaudeModelId = "opus" | "sonnet" | "haiku";
export type CodexModelId = "gpt-5.4" | "gpt-5.3-codex" | "gpt-5-codex-mini";
export type ModelId = ClaudeModelId | CodexModelId;

export interface UsageEvent {
  id: string;
  agent: AgentId;
  model: ModelId;
  ts: number;
  sessionId: string;
  task: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningMin: number;
}

export interface SessionState {
  id: string;
  task: string;
  model: ModelId;
  startedAt: number;
  events: number;
  tokens: number;
}

export interface PlanDef {
  id: string;
  agent: AgentId;
  name: string;
  priceUsd: number;
  blurb: string;
  windowTokenBudget: number;
  weekTokenBudget: number;
  windowReasoningMin: number;
  weekReasoningMin: number;
  kind: "subscription" | "api";
}

export interface MeterSnapshot {
  agent: AgentId;
  windowPct: number;
  weekPct: number;
  windowTokens: number;
  weekTokens: number;
  windowReasoningMin: number;
  weekReasoningMin: number;
  windowBudget: number;
  weekBudget: number;
  windowResetsAt: number;
  weekResetsAt: number;
  burnPctPerHour: number;
  etaMs: number | null;
  apiUsdWindow: number;
  apiUsdWeek: number;
  status: "ok" | "watch" | "critical";
}

export interface ModelShare {
  model: ModelId;
  tokens: number;
  pct: number;
  events: number;
}

export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
