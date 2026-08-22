import type { AgentId, ModelId, PlanDef } from "./types.ts";

export const CLAUDE_PLANS: PlanDef[] = [
  {
    id: "claude-pro",
    agent: "claude",
    name: "Claude Pro",
    priceUsd: 20,
    blurb: "约 4.4 万加权 token / 5 小时，适合偶尔的深度会话。",
    windowTokenBudget: 44_000,
    weekTokenBudget: 440_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "subscription",
  },
  {
    id: "claude-max-5x",
    agent: "claude",
    name: "Claude Max 5×",
    priceUsd: 100,
    blurb: "约 8.8 万加权 token / 5 小时，日常主力开发档；Fable 5 另有本周 50% 子上限。",
    windowTokenBudget: 88_000,
    weekTokenBudget: 2_200_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    modelWeekLimitPct: { fable: 50 },
    kind: "subscription",
  },
  {
    id: "claude-max-20x",
    agent: "claude",
    name: "Claude Max 20×",
    priceUsd: 200,
    blurb: "约 22 万加权 token / 5 小时，全天 Agent 不中断；Fable 5 另有本周 50% 子上限。",
    windowTokenBudget: 220_000,
    weekTokenBudget: 8_800_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    modelWeekLimitPct: { fable: 50 },
    kind: "subscription",
  },
  {
    id: "claude-api",
    agent: "claude",
    name: "Anthropic API",
    priceUsd: 0,
    blurb: "按量计费，无 5 小时窗；额度按本周 API 成本估算。",
    windowTokenBudget: 2_000_000,
    weekTokenBudget: 8_000_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "api",
  },
];

export const CODEX_PLANS: PlanDef[] = [
  {
    id: "chatgpt-plus",
    agent: "codex",
    name: "ChatGPT Plus",
    priceUsd: 20,
    blurb: "Codex 1× 档。短会话够用，长 Agent 循环很快顶到周额度。",
    windowTokenBudget: 180_000,
    weekTokenBudget: 1_200_000,
    windowReasoningMin: 40,
    weekReasoningMin: 180,
    kind: "subscription",
  },
  {
    id: "chatgpt-pro-5x",
    agent: "codex",
    name: "ChatGPT Pro 5×",
    priceUsd: 100,
    blurb: "Codex 用量约 Plus 的 5 倍。官方 plan_type 仍是 pro，要和 20× 分开。",
    windowTokenBudget: 900_000,
    weekTokenBudget: 6_000_000,
    windowReasoningMin: 200,
    weekReasoningMin: 900,
    kind: "subscription",
  },
  {
    id: "chatgpt-pro-20x",
    agent: "codex",
    name: "ChatGPT Pro 20×",
    priceUsd: 200,
    blurb: "Codex 用量约 Plus 的 20 倍。全天多会话不中断的档。",
    windowTokenBudget: 3_600_000,
    weekTokenBudget: 24_000_000,
    windowReasoningMin: 800,
    weekReasoningMin: 3600,
    kind: "subscription",
  },
  {
    id: "chatgpt-team",
    agent: "codex",
    name: "ChatGPT Business",
    priceUsd: 30,
    blurb: "席位制，窗口介于 Plus 与 Pro 之间。",
    windowTokenBudget: 360_000,
    weekTokenBudget: 2_400_000,
    windowReasoningMin: 80,
    weekReasoningMin: 360,
    kind: "subscription",
  },
  {
    id: "openai-api",
    agent: "codex",
    name: "OpenAI API",
    priceUsd: 0,
    blurb: "按量计费 + 可选额度包，无订阅窗。",
    windowTokenBudget: 2_000_000,
    weekTokenBudget: 10_000_000,
    windowReasoningMin: 600,
    weekReasoningMin: 3000,
    kind: "api",
  },
];

export const GROK_PLANS: PlanDef[] = [
  {
    id: "grok-free",
    agent: "grok",
    name: "Grok",
    priceUsd: 0,
    blurb: "免费档，短会话够用；长 Agent 循环很快会顶到窗。",
    windowTokenBudget: 400_000,
    weekTokenBudget: 2_000_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "subscription",
  },
  {
    id: "grok-super",
    agent: "grok",
    name: "SuperGrok",
    priceUsd: 30,
    blurb: "日常 Grok CLI / Grok Build，按约 200 万加权 token / 5 小时估。",
    windowTokenBudget: 2_000_000,
    weekTokenBudget: 12_000_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "subscription",
  },
  {
    id: "grok-heavy",
    agent: "grok",
    name: "SuperGrok Heavy",
    priceUsd: 300,
    blurb: "全天多会话不中断，窗大约是 SuperGrok 的 4 倍。",
    windowTokenBudget: 8_000_000,
    weekTokenBudget: 48_000_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "subscription",
  },
  {
    id: "grok-api",
    agent: "grok",
    name: "xAI API",
    priceUsd: 0,
    blurb: "按量计费，无订阅窗；额度按本周 API 成本估算。",
    windowTokenBudget: 20_000_000,
    weekTokenBudget: 80_000_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "api",
  },
];

export const ALL_PLANS: PlanDef[] = [...CLAUDE_PLANS, ...CODEX_PLANS, ...GROK_PLANS];

export function planById(id: string): PlanDef {
  const resolved = id === "chatgpt-pro" ? "chatgpt-pro-20x" : id;
  const found = ALL_PLANS.find((p) => p.id === resolved);
  if (!found) throw new Error(`Unknown plan: ${id}`);
  return found;
}

export function plansFor(agent: AgentId): PlanDef[] {
  return ALL_PLANS.filter((p) => p.agent === agent);
}

export const MODEL_META: Record<
  ModelId,
  { label: string; agent: AgentId; weight: number; inPerM: number; outPerM: number }
> = {
  fable: { label: "Fable 5", agent: "claude", weight: 8, inPerM: 10, outPerM: 50 },
  opus: { label: "Opus 5", agent: "claude", weight: 5, inPerM: 5, outPerM: 25 },
  sonnet: { label: "Sonnet 5", agent: "claude", weight: 1, inPerM: 2, outPerM: 10 },
  haiku: { label: "Haiku 4.5", agent: "claude", weight: 0.2, inPerM: 1, outPerM: 5 },
  "gpt-5.6-sol": { label: "GPT-5.6 Sol", agent: "codex", weight: 5, inPerM: 5, outPerM: 30 },
  "gpt-5.6-terra": { label: "GPT-5.6 Terra", agent: "codex", weight: 2, inPerM: 2, outPerM: 12 },
  "gpt-5.6-luna": { label: "GPT-5.6 Luna", agent: "codex", weight: 0.6, inPerM: 0.2, outPerM: 1.2 },
  "gpt-5.5": { label: "GPT-5.5", agent: "codex", weight: 4, inPerM: 5, outPerM: 30 },
  "gpt-5.4": { label: "GPT-5.4", agent: "codex", weight: 2.2, inPerM: 2.5, outPerM: 15 },
  "gpt-5.4-mini": { label: "GPT-5.4 Mini", agent: "codex", weight: 0.7, inPerM: 0.75, outPerM: 4.5 },
  "daybreak-blue": { label: "Daybreak Blue", agent: "codex", weight: 4, inPerM: 5, outPerM: 30 },
  "daybreak-red": { label: "Daybreak Red", agent: "codex", weight: 8, inPerM: 12.5, outPerM: 75 },
  "grok-4.3": { label: "Grok 4.3", agent: "grok", weight: 0.8, inPerM: 1.25, outPerM: 2.5 },
  "grok-4.20": { label: "Grok 4.20", agent: "grok", weight: 0.8, inPerM: 1.25, outPerM: 2.5 },
  "grok-4.6": { label: "Grok 4.6", agent: "grok", weight: 1, inPerM: 2, outPerM: 6 },
  "grok-4.5": { label: "Grok 4.5", agent: "grok", weight: 1, inPerM: 2, outPerM: 6 },
};

export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;
