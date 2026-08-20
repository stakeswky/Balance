import { formatDuration, formatPct, formatTokens, formatUsd, formatUsdRange } from "@/lib/quota/engine";
import { modelDisplayLabel } from "@/lib/quota/model-label";
import { MODEL_META } from "@/lib/quota/plans";
import type { ModelId } from "@/lib/quota/types";

export { formatDuration, formatPct, formatTokens, formatUsd, formatUsdRange, modelDisplayLabel };

export function modelLabel(id: ModelId, modelRaw?: string | null) {
  return modelDisplayLabel(modelRaw, id);
}

export function familyLabel(id: ModelId) {
  return MODEL_META[id].label;
}
