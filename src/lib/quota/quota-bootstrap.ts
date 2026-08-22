// quota-bootstrap.ts —— 同构编排模块：cache 水合 + 轮询控制。禁止 node 内建 import。
import type { CachedQuotaEvent, QuotaBootstrapPage } from "./quota-cache.ts";
import type { UsageEvent } from "./types.ts";

export interface QuotaHydrationDeps {
  pull: (input: {
    offset: number;
    limit: number;
    snapshotKey: string | null;
  }) => Promise<QuotaBootstrapPage>;
  hydrate: (event: CachedQuotaEvent) => UsageEvent;
  ingest: (
    events: UsageEvent[],
    opts: { publish: boolean; complete: boolean },
  ) => void;
  reset: () => void;
  setBoundary: (historyTruncated: boolean, truncatedBeforeMs: number | null) => void;
  yieldToBrowser: () => Promise<void>;
}

export async function hydrateQuotaCache(
  deps: QuotaHydrationDeps,
): Promise<number | null> {
  let offset = 0;
  let pageIndex = 0;
  let snapshotKey: string | null = null;
  let stableSavedAt: number | null = null;
  let restarts = 0;
  for (;;) {
    const page = await deps.pull({ offset, limit: 2_000, snapshotKey });
    if (page.restart) {
      restarts += 1;
      if (restarts > 3) throw new Error("quota cache changed repeatedly during hydration");
      deps.reset();
      offset = 0;
      pageIndex = 0;
      snapshotKey = page.snapshotKey;
      stableSavedAt = null;
      continue;
    }
    snapshotKey = page.snapshotKey;
    if (pageIndex === 0) stableSavedAt = page.savedAt;
    if (page.savedAt !== stableSavedAt) {
      throw new Error("quota cache savedAt changed without restart");
    }
    const complete = page.nextOffset == null;
    deps.ingest(
      page.events.map(deps.hydrate),
      { publish: pageIndex === 0 || complete, complete },
    );
    deps.setBoundary(page.historyTruncated, page.truncatedBeforeMs);
    if (page.nextOffset == null) return stableSavedAt;
    offset = page.nextOffset;
    pageIndex += 1;
    await deps.yieldToBrowser();
  }
}

export function startQuotaPolling(opts: {
  initialSince: number;
  seedCursors: (since: number) => void;
  pullLogs: () => Promise<void>;
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (timer: number) => void;
}): () => void {
  let stopped = false;
  let inFlight = false;
  opts.seedCursors(opts.initialSince);
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await opts.pullLogs();
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = opts.setInterval(() => void tick(), 2_500);
  return () => {
    stopped = true;
    opts.clearInterval(timer);
  };
}
