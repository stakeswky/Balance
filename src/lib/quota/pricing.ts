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

export function lookupPricing(modelRaw: string | null | undefined, modelFamily?: string | null): PricingHit {
  const raw = (modelRaw ?? "").trim();
  if (raw) {
    const exact = byModel.get(raw.toLowerCase());
    if (exact) return { pricing: exact, quality: "exact", resolvedModel: exact.model };
    const alias = MODEL_ALIASES[raw.toLowerCase()];
    if (alias) {
      const hit = byModel.get(alias.toLowerCase());
      if (hit) return { pricing: hit, quality: "exact", resolvedModel: hit.model };
    }
  }
  const family = (modelFamily ?? "").trim();
  const rawLc = raw.toLowerCase();
  const familyLc = family.toLowerCase();
  const familyFromRaw = Boolean(raw) && Boolean(family) && rawLc.includes(familyLc);
  if (family && (!raw || familyFromRaw)) {
    const mapped = FAMILY_FALLBACK[family] ?? FAMILY_FALLBACK[familyLc];
    if (mapped) {
      const hit = byModel.get(mapped.toLowerCase());
      if (hit) return { pricing: hit, quality: "family-fallback", resolvedModel: hit.model };
    }
  }
  return { pricing: null, quality: "unknown", resolvedModel: null };
}

export { OPENAI_CREDITS_PER_USD, PRICING_VERSION };
