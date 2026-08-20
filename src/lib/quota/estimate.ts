/** 5× vs 20× is a 4× gap; community Pro 20× weekly samples sit near ~700M tokens. */
export const CODEX_PRO_20X_WEEK_TOKEN_FLOOR = 350_000_000;

export function inferCodexProPlanId(estimatedWeekTokens: number | null | undefined): "chatgpt-pro-5x" | "chatgpt-pro-20x" {
  if (estimatedWeekTokens != null && estimatedWeekTokens >= CODEX_PRO_20X_WEEK_TOKEN_FLOOR) {
    return "chatgpt-pro-20x";
  }
  return "chatgpt-pro-5x";
}
