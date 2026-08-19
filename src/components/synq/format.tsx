import { formatDuration, formatPct, formatTokens, formatUsd } from "@/lib/quota/engine";
import { MODEL_META } from "@/lib/quota/plans";
import type { ModelId } from "@/lib/quota/types";

export { formatDuration, formatPct, formatTokens, formatUsd };

export function modelLabel(id: ModelId) {
  return MODEL_META[id].label;
}
