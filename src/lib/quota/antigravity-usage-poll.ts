import type { AntigravityUsageScanResult } from "./antigravity-usage.ts";

export const ANTIGRAVITY_USAGE_POLL_MS = 30_000;

interface PollAntigravityUsageOptions {
  available: boolean;
  now: number;
  since: number;
  lastPulledAt: number | null;
  previous: AntigravityUsageScanResult | null;
  pull: (request: { data: { since: number } }) => Promise<AntigravityUsageScanResult>;
}

export interface PollAntigravityUsageResult {
  lastPulledAt: number | null;
  snapshot: AntigravityUsageScanResult | null;
}

export async function pollAntigravityUsage(
  options: PollAntigravityUsageOptions,
): Promise<PollAntigravityUsageResult> {
  if (!options.available) {
    return { lastPulledAt: options.lastPulledAt, snapshot: options.previous };
  }
  if (
    options.lastPulledAt != null
    && options.now - options.lastPulledAt < ANTIGRAVITY_USAGE_POLL_MS
  ) {
    return { lastPulledAt: options.lastPulledAt, snapshot: options.previous };
  }
  try {
    const snapshot = await options.pull({ data: { since: options.since } });
    return { lastPulledAt: options.now, snapshot };
  } catch {
    return { lastPulledAt: options.now, snapshot: options.previous };
  }
}
