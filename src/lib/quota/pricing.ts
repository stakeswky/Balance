import {
  FAMILY_FALLBACK,
  MODEL_ALIASES,
  PRICING_TABLE,
  PRICING_VERSION,
  OPENAI_CREDITS_PER_USD,
  type ModelPricing,
} from "./pricing-data.ts";

export type { ModelPricing };

export type PricingQuality = "exact" | "family-fallback" | "unknown";

export interface PricingHit {
  pricing: ModelPricing | null;
  quality: PricingQuality;
  resolvedModel: string | null;
}

const byModel = new Map(PRICING_TABLE.map((p) => [p.model.toLowerCase(), p]));

const DATED_ID = /-\d{8}$/;

function knownDatedBase(raw: string): ModelPricing | null {
  const match = raw.toLowerCase().match(/^(.+)-\d{8}$/);
  if (!match) return null;
  return byModel.get(match[1]!) ?? null;
}

function activeAt(pricing: ModelPricing, atMs: number): boolean {
  return pricing.retiredAt == null || atMs < pricing.retiredAt;
}

export function lookupPricing(
  modelRaw: string | null | undefined,
  modelFamily?: string | null,
  atMs = Date.now(),
): PricingHit {
  const raw = (modelRaw ?? "").trim();
  const rawLc = raw.toLowerCase();
  if (raw) {
    const exact = byModel.get(rawLc);
    if (exact && activeAt(exact, atMs)) {
      return { pricing: exact, quality: "exact", resolvedModel: exact.model };
    }
    const alias = MODEL_ALIASES[rawLc];
    const hit = alias ? byModel.get(alias.toLowerCase()) : undefined;
    if (hit && activeAt(hit, atMs)) {
      return { pricing: hit, quality: "exact", resolvedModel: hit.model };
    }
    const dated = knownDatedBase(raw);
    if (dated && activeAt(dated, atMs)) {
      return { pricing: dated, quality: "exact", resolvedModel: dated.model };
    }
    // Step 3.4 的 DATED_ID 短路在此保留：dated raw 只允许 exact/alias/dated-base
    // 命中；miss 或退役后一律 unknown，不得落进 family fallback。
    if (DATED_ID.test(rawLc)) {
      return { pricing: null, quality: "unknown", resolvedModel: null };
    }
  }
  const family = (modelFamily ?? "").trim();
  const familyLc = family.toLowerCase();
  const familyFromRaw = Boolean(raw) && Boolean(family) && rawLc.includes(familyLc);
  if (family && (!raw || familyFromRaw)) {
    const mapped = FAMILY_FALLBACK[family] ?? FAMILY_FALLBACK[familyLc];
    const hit = mapped ? byModel.get(mapped.toLowerCase()) : undefined;
    if (hit && activeAt(hit, atMs)) {
      return { pricing: hit, quality: "family-fallback", resolvedModel: hit.model };
    }
  }
  return { pricing: null, quality: "unknown", resolvedModel: null };
}

export { OPENAI_CREDITS_PER_USD, PRICING_VERSION };
