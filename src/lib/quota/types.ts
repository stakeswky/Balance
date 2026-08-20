export type AgentId = "claude" | "codex" | "grok";

export type ClaudeModelId = "fable" | "opus" | "sonnet" | "haiku";
export type CodexModelId = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.4";
export type GrokModelId = "grok-4.6" | "grok-4.5";
export type ModelId = ClaudeModelId | CodexModelId | GrokModelId;

export interface UsageEvent {
  id: string;
  agent: AgentId;
  model: ModelId;
  /** Original model id from the client log; used for price lookup. */
  modelRaw?: string;
  ts: number;
  sessionId: string;
  task: string;
  /** Uncached input tokens. Mutually exclusive with cacheRead. */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  /** 5-minute cache write tokens (Claude); other agents use this for undifferentiated writes. */
  cacheWrite: number;
  cacheWrite1h?: number;
  /** True when Claude only had a combined cache-write total, billed as 5m. */
  cacheWriteUnsplit?: boolean;
  reasoningMin: number;
  reportedCostTicks?: number | null;
  reportedCostByModel?: Record<string, number>;
}

export interface SessionState {
  id: string;
  task: string;
  model: ModelId;
  modelRaw?: string;
  startedAt: number;
  events: number;
  tokens: number;
}

export interface AgentLiveInfo {
  sessionId: string;
  cwd: string;
  task: string;
  writing: boolean;
  lastTs: number;
  startedAt: number;
  turns: number;
}

export type ClaudeLiveInfo = AgentLiveInfo;

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
  modelWeekLimitPct?: Partial<Record<ModelId, number>>;
  kind: "subscription" | "api";
}

export interface ModelWeekLimitSnapshot {
  model: ModelId;
  limitPctOfWeek: number;
  weightedTokens: number;
  budget: number;
  usedPct: number;
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
  label: string;
  tokens: number;
  pct: number;
  events: number;
}

export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
