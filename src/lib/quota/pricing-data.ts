export interface ModelPricing {
  model: string;
  source: string;
  version: string;
  effectiveAt: number | null;
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheWrite5mPerToken: number;
  cacheWrite1hPerToken: number;
  imageInputPerToken: number | null;
  imageOutputPerToken: number | null;
  priorityInputPerToken: number | null;
  priorityOutputPerToken: number | null;
  priorityCacheReadPerToken: number | null;
  longContextThreshold: number | null;
  longContextInputMultiplier: number;
  longContextOutputMultiplier: number;
  creditsPerUsd: number | null;
}

/** Frozen snapshot so offline preview is reproducible. Prices are USD per token. */
export const PRICING_VERSION = "2026-08-21-balance-2";
export const OPENAI_CREDITS_PER_USD = 25;

function perM(
  input: number,
  output: number,
  opts?: {
    cacheRead?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    imageInput?: number;
    imageOutput?: number;
    longCtx?: number;
    longIn?: number;
    longOut?: number;
    creditsPerUsd?: number;
  },
): ModelPricing {
  const inputPerToken = input / 1_000_000;
  const outputPerToken = output / 1_000_000;
  const cacheRead = (opts?.cacheRead ?? input * 0.1) / 1_000_000;
  const cacheWrite5m = (opts?.cacheWrite5m ?? 0) / 1_000_000;
  const cacheWrite1h = (opts?.cacheWrite1h ?? 0) / 1_000_000;
  return {
    model: "",
    source: "balance-snapshot",
    version: PRICING_VERSION,
    effectiveAt: Date.parse("2026-08-20T00:00:00Z"),
    inputPerToken,
    outputPerToken,
    cacheReadPerToken: cacheRead,
    cacheWrite5mPerToken: cacheWrite5m,
    cacheWrite1hPerToken: cacheWrite1h,
    imageInputPerToken: opts?.imageInput == null ? null : opts.imageInput / 1_000_000,
    imageOutputPerToken: opts?.imageOutput == null ? null : opts.imageOutput / 1_000_000,
    priorityInputPerToken: null,
    priorityOutputPerToken: null,
    priorityCacheReadPerToken: null,
    longContextThreshold: opts?.longCtx ?? null,
    longContextInputMultiplier: opts?.longIn ?? 1,
    longContextOutputMultiplier: opts?.longOut ?? 1,
    creditsPerUsd: opts?.creditsPerUsd ?? null,
  };
}

function named(model: string, base: ModelPricing): ModelPricing {
  return { ...base, model };
}

const fable = perM(10, 50, { cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 });
const opus = perM(5, 25, { cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 });
const sonnet5 = perM(2, 10, { cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 });
const sonnet46 = perM(3, 15, { cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 });
const haiku = perM(1, 5, { cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 });
const codexLongContext = {
  creditsPerUsd: OPENAI_CREDITS_PER_USD,
  longCtx: 272_000,
  longIn: 2,
  longOut: 1.5,
} as const;
const sol = perM(5, 30, codexLongContext);
const terra = perM(2, 12, { cacheRead: 0.2, ...codexLongContext });
const luna = perM(0.2, 1.2, { cacheRead: 0.02, ...codexLongContext });
const gpt54 = perM(2.5, 15, { cacheRead: 0.25, ...codexLongContext });
const grok46 = perM(2, 6, { cacheRead: 0.5, longCtx: 200_000, longIn: 2, longOut: 2 });
const grok45 = perM(2, 6, { cacheRead: 0.3, longCtx: 200_000, longIn: 2, longOut: 2 });
const grokBuild01 = perM(1, 2, { cacheRead: 0.2, longCtx: 200_000, longIn: 2, longOut: 2 });

export const PRICING_TABLE: ModelPricing[] = [
  named("claude-fable-5", fable),
  named("claude-mythos-5", fable),
  named("claude-opus-5", opus),
  named("claude-opus-4-8", opus),
  named("claude-opus-4-7", opus),
  named("claude-opus-4-6", opus),
  named("claude-sonnet-5", sonnet5),
  named("claude-sonnet-4-6", sonnet46),
  named("claude-haiku-4-5", haiku),
  named("claude-haiku-4-5-20251001", haiku),
  named("gpt-5.6-sol", sol),
  named("gpt-5.6-terra", terra),
  named("gpt-5.6-luna", luna),
  named("gpt-5.4", gpt54),
  named("grok-4.6", grok46),
  named("grok-4.5", grok45),
  named("grok-build-0.1", grokBuild01),
];

export const MODEL_ALIASES: Record<string, string> = {
  "claude-fable-5-20260609": "claude-fable-5",
  "claude-opus-5-20260724": "claude-opus-5",
  "claude-sonnet-5-20260601": "claude-sonnet-5",
  "grok-4.6-build": "grok-4.6",
  "grok-build-latest": "grok-4.5",
};

export const FAMILY_FALLBACK: Record<string, string> = {
  fable: "claude-fable-5",
  mythos: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.4": "gpt-5.4",
  "grok-4.6": "grok-4.6",
  "grok-4.5": "grok-4.5",
};
