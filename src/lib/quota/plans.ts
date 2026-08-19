import type { AgentId, ModelId, PlanDef } from "./types";

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
    blurb: "约 8.8 万加权 token / 5 小时，日常主力开发档。",
    windowTokenBudget: 88_000,
    weekTokenBudget: 2_200_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
    kind: "subscription",
  },
  {
    id: "claude-max-20x",
    agent: "claude",
    name: "Claude Max 20×",
    priceUsd: 200,
    blurb: "约 22 万加权 token / 5 小时，全天 Agent 不中断。",
    windowTokenBudget: 220_000,
    weekTokenBudget: 8_800_000,
    windowReasoningMin: 0,
    weekReasoningMin: 0,
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
    blurb: "约 40 分钟推理 / 5 小时窗，外加周额度。",
    windowTokenBudget: 180_000,
    weekTokenBudget: 1_200_000,
    windowReasoningMin: 40,
    weekReasoningMin: 180,
    kind: "subscription",
  },
  {
    id: "chatgpt-pro",
    agent: "codex",
    name: "ChatGPT Pro",
    priceUsd: 200,
    blurb: "约 5× Plus 窗口，适合全天 Codex CLI。",
    windowTokenBudget: 900_000,
    weekTokenBudget: 6_000_000,
    windowReasoningMin: 200,
    weekReasoningMin: 900,
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

export const ALL_PLANS: PlanDef[] = [...CLAUDE_PLANS, ...CODEX_PLANS];

export function planById(id: string): PlanDef {
  const found = ALL_PLANS.find((p) => p.id === id);
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
  opus: { label: "Opus 4.7", agent: "claude", weight: 5, inPerM: 15, outPerM: 75 },
  sonnet: { label: "Sonnet 4.6", agent: "claude", weight: 1, inPerM: 3, outPerM: 15 },
  haiku: { label: "Haiku 4.5", agent: "claude", weight: 0.2, inPerM: 1, outPerM: 5 },
  "gpt-5.4": { label: "GPT-5.4", agent: "codex", weight: 2.2, inPerM: 10, outPerM: 30 },
  "gpt-5.3-codex": { label: "GPT-5.3 Codex", agent: "codex", weight: 1, inPerM: 5, outPerM: 15 },
  "gpt-5-codex-mini": { label: "Codex Mini", agent: "codex", weight: 0.35, inPerM: 1.5, outPerM: 6 },
};

export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;
