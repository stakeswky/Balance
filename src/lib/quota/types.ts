export type AgentId = "claude" | "codex" | "grok";

export type ClaudeModelId = "fable" | "opus" | "sonnet" | "haiku";
export type CodexModelId = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.4";
export type GrokModelId = "grok-4.6" | "grok-4.5";
export type ModelId = ClaudeModelId | CodexModelId | GrokModelId;
export type ActorKind = "subagent" | "workflow-subagent";

export interface UsageEvent {
  id: string;
  agent: AgentId;
  model: ModelId;
  /** Original model id from the client log; used for price lookup. */
  modelRaw?: string;
  ts: number;
  sessionId: string;
  actorId?: string;
  actorKind?: ActorKind;
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
  actorId?: string;
  actorKind?: ActorKind;
  cwd: string;
  task: string;
  writing: boolean;
  lastTs: number;
  startedAt: number;
  turns: number;
}

export type ClaudeLiveInfo = AgentLiveInfo;

export function activityIdOf(event: Pick<UsageEvent, "sessionId" | "actorId">): string {
  return event.actorId ?? event.sessionId;
}

export function latestActivities(candidates: AgentLiveInfo[]): { live: AgentLiveInfo | null; active: AgentLiveInfo[] } {
  const sorted = [...candidates].sort((left, right) => right.lastTs - left.lastTs);
  const merged = new Map<string, AgentLiveInfo>();
  for (const item of sorted) {
    const key = item.actorId ?? item.sessionId;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...item });
      continue;
    }
    current.writing ||= item.writing;
    current.startedAt = Math.min(current.startedAt, item.startedAt);
    current.lastTs = Math.max(current.lastTs, item.lastTs);
    current.turns = Math.max(current.turns, item.turns);
  }
  const recent = [...merged.values()].sort((left, right) => right.lastTs - left.lastTs);
  return {
    live: recent[0] ?? null,
    active: recent.filter((item) => item.writing),
  };
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
  modelWeekLimitPct?: Partial<Record<ModelId, number>>;
  kind: "subscription" | "api";
}

export interface ModelWeekLimitSnapshot {
  model: ModelId;
  limitPctOfWeek: number;
  usedPct: number;
  resetsAt: number | null;
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
