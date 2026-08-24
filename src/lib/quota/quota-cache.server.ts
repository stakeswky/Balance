// quota-cache.server.ts —— 仅服务端：hash 与脱敏转换 + 持久化 I/O。
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  quotaCacheSnapshotSchema,
  hydrateCachedEvent,
  isSafeModelRaw,
  type CachedLogCursor,
  type CachedQuotaEvent,
  type QuotaBootstrapPage,
  type QuotaCacheSnapshot,
} from "./quota-cache.ts";
import type { UsageAgentId, UsageEvent } from "./types.ts";

export function eventIdHash(agent: UsageAgentId, id: string): string {
  return createHash("sha256").update(`${agent}\0${id}`, "utf8").digest("hex");
}

/** 服务端 identity：有 cacheIdentity 用之，否则对原始 (agent,id) 求 sha256。 */
export function serverQuotaEventIdentity(event: UsageEvent): string {
  return event.cacheIdentity ?? eventIdHash(event.agent, event.id);
}

export function cacheEvent(event: UsageEvent): CachedQuotaEvent {
  const modelRaw = event.modelRaw && isSafeModelRaw(event.modelRaw)
    ? event.modelRaw
    : undefined;
  const reportedUsd = event.reportedCost?.semantics === "api-equivalent"
    && event.reportedCost.schemaVersion === "grok-cli-1.0.0"
    && event.reportedCost.usdValue != null
    && Number.isFinite(event.reportedCost.usdValue)
    && event.reportedCost.usdValue >= 0
    ? event.reportedCost.usdValue
    : undefined;
  return {
    idHash: serverQuotaEventIdentity(event),
    agent: event.agent,
    model: event.pricingDisabled && modelRaw ? modelRaw : event.model,
    modelRaw,
    ts: event.ts,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    cacheWrite1h: event.cacheWrite1h,
    cacheWriteUnsplit: event.cacheWriteUnsplit,
    imageInputTokens: event.imageInputTokens,
    imageOutputTokens: event.imageOutputTokens,
    speed: event.speed,
    anomalyCodes: event.anomalies?.map((anomaly) => anomaly.code),
    reportedUsd,
    reportedCostSchema: reportedUsd == null ? undefined : "grok-cli-1.0.0",
  };
}

// ── Shared scanner helpers (Step 5.9c) ────────────────────────────────

export function withCacheIdentity(events: UsageEvent[]): UsageEvent[] {
  for (const event of events) {
    event.cacheIdentity ??= eventIdHash(event.agent, event.id);
  }
  return events;
}

export function scanResponseEvents(folded: UsageEvent[], since: number): UsageEvent[] {
  return since > 0
    ? folded.filter((event) => event.ts > since - 60_000)
    : folded;
}

// ── Persistence I/O (Step 5.8b) ────────────────────────────────────────

const CACHE_RETENTION_MS = 8 * 24 * 60 * 60_000;
const MAX_CACHE_EVENTS = 100_000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_CURSORS = 20_000;
const MAX_CACHE_CURSOR_BYTES = 8 * 1024 * 1024;
const CACHE_METADATA_RESERVE_BYTES = 256;

export interface QuotaCacheWriteDeps {
  chmod: typeof chmodSync;
  close: typeof closeSync;
  exists: typeof existsSync;
  fsync: typeof fsyncSync;
  mkdir: typeof mkdirSync;
  open: typeof openSync;
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
  writeFile: typeof writeFileSync;
  randomId: () => string;
  pid: number;
}

export const nodeQuotaCacheWriteDeps: QuotaCacheWriteDeps = {
  chmod: chmodSync,
  close: closeSync,
  exists: existsSync,
  fsync: fsyncSync,
  mkdir: mkdirSync,
  open: openSync,
  rename: renameSync,
  unlink: unlinkSync,
  writeFile: writeFileSync,
  randomId: randomUUID,
  pid: process.pid,
};

type QuotaCacheSnapshotBody = Omit<QuotaCacheSnapshot, "snapshotId">;

export function quotaCacheSnapshotId(body: QuotaCacheSnapshotBody): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

export function quotaCachePath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Balance", "quota-cache-v2.json");
  }
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA || join(home, "AppData", "Local"),
      "Balance",
      "quota-cache-v2.json",
    );
  }
  return join(
    env.XDG_STATE_HOME || join(home, ".local", "state"),
    "balance",
    "quota-cache-v2.json",
  );
}

export function makeQuotaCacheSnapshot(
  events: UsageEvent[],
  cursors: CachedLogCursor[],
  now: number,
): QuotaCacheSnapshot {
  const uniqueCursors = [...new Map(
    cursors.map((cursor) => [`${cursor.agent}:${cursor.pathHash}`, cursor] as const),
  ).values()].sort((left, right) =>
    left.agent.localeCompare(right.agent) || left.pathHash.localeCompare(right.pathHash));
  const selectedCursors: CachedLogCursor[] = [];
  let cursorBytes = 0;
  for (const cursor of uniqueCursors) {
    const nextBytes = Buffer.byteLength(JSON.stringify(cursor)) + 1;
    if (
      selectedCursors.length >= MAX_CACHE_CURSORS
      || cursorBytes + nextBytes > MAX_CACHE_CURSOR_BYTES
    ) break;
    selectedCursors.push(cursor);
    cursorBytes += nextBytes;
  }
  const cursorSetComplete = selectedCursors.length === uniqueCursors.length;
  const candidates = events
    .filter((event) => event.ts >= now - CACHE_RETENTION_MS && event.ts <= now + 5_000)
    .sort((left, right) => right.ts - left.ts);
  const selected: ReturnType<typeof cacheEvent>[] = [];
  let encodedBytes = Buffer.byteLength(
    JSON.stringify({
      version: 2,
      snapshotId: "0".repeat(64),
      savedAt: now,
      historyTruncated: false,
      truncatedBeforeMs: null,
      cursorSetComplete,
      cursors: selectedCursors,
      events: [],
    }),
  );
  let historyTruncated = false;
  for (const event of candidates) {
    if (selected.length >= MAX_CACHE_EVENTS) {
      historyTruncated = true;
      break;
    }
    const cached = cacheEvent(event);
    const eventBytes = Buffer.byteLength(JSON.stringify(cached)) + 1;
    if (encodedBytes + eventBytes > MAX_CACHE_BYTES - CACHE_METADATA_RESERVE_BYTES) {
      historyTruncated = true;
      break;
    }
    selected.push(cached);
    encodedBytes += eventBytes;
  }
  selected.reverse();
  const truncatedBeforeMs = historyTruncated
    ? selected[0]?.ts ?? candidates.at(-1)?.ts ?? now
    : null;
  const body: QuotaCacheSnapshotBody = {
    version: 2,
    savedAt: now,
    historyTruncated,
    truncatedBeforeMs,
    cursorSetComplete,
    cursors: selectedCursors,
    events: selected,
  };
  return { ...body, snapshotId: quotaCacheSnapshotId(body) };
}

function fsyncDirectory(path: string, deps: QuotaCacheWriteDeps): void {
  let descriptor: number | null = null;
  try {
    descriptor = deps.open(path, "r");
    deps.fsync(descriptor);
  } catch {
    // Windows and some filesystems do not allow fsync on a directory.
  } finally {
    if (descriptor != null) deps.close(descriptor);
  }
}

export function writeQuotaCacheAtomic(
  path: string,
  events: UsageEvent[],
  cursors: CachedLogCursor[],
  now: number,
  deps: QuotaCacheWriteDeps = nodeQuotaCacheWriteDeps,
): QuotaCacheSnapshot {
  const snapshot = makeQuotaCacheSnapshot(events, cursors, now);
  writeQuotaCacheSnapshotAtomic(path, snapshot, deps);
  return snapshot;
}

export function writeQuotaCacheSnapshotAtomic(
  path: string,
  snapshot: QuotaCacheSnapshot,
  deps: QuotaCacheWriteDeps = nodeQuotaCacheWriteDeps,
): void {
  const validated = quotaCacheSnapshotSchema.parse(snapshot);
  const { snapshotId, ...body } = validated;
  if (quotaCacheSnapshotId(body) !== snapshotId) {
    throw new Error("quota cache snapshot id mismatch");
  }
  const payload = JSON.stringify(validated);
  if (Buffer.byteLength(payload) > MAX_CACHE_BYTES) {
    throw new Error("quota cache exceeds byte budget");
  }
  const directory = dirname(path);
  deps.mkdir(directory, { recursive: true, mode: 0o700 });
  deps.chmod(directory, 0o700);
  const temporary = join(
    directory,
    `.${basename(path)}.${deps.pid}.${deps.randomId()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = deps.open(temporary, "wx", 0o600);
    deps.writeFile(descriptor, payload, "utf8");
    deps.fsync(descriptor);
    deps.close(descriptor);
    descriptor = null;
    deps.rename(temporary, path);
    deps.chmod(path, 0o600);
    fsyncDirectory(directory, deps);
  } finally {
    if (descriptor != null) deps.close(descriptor);
    if (deps.exists(temporary)) deps.unlink(temporary);
  }
}

export function readQuotaCache(path: string): QuotaCacheSnapshot | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
    const parsed = quotaCacheSnapshotSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (!parsed.success) return null;
    const { snapshotId, ...body } = parsed.data;
    return quotaCacheSnapshotId(body) === snapshotId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createQuotaCacheWriter(
  deps: QuotaCacheWriteDeps = nodeQuotaCacheWriteDeps,
): {
  enqueue: (
    path: string,
    events: UsageEvent[],
    cursors: CachedLogCursor[],
    now: number,
  ) => Promise<void>;
} {
  let queue: Promise<void> = Promise.resolve();
  return {
    enqueue(path, events, cursors, now) {
      // 在入队时完成脱敏快照，调用方随后修改 event 也不会改变待写 payload。
      const snapshot = makeQuotaCacheSnapshot(events, cursors, now);
      const task = queue.then(() => {
        writeQuotaCacheSnapshotAtomic(path, snapshot, deps);
      });
      queue = task.catch(() => undefined);
      return task;
    },
  };
}

const quotaCacheWriter = createQuotaCacheWriter();

export const enqueueQuotaCacheWrite = quotaCacheWriter.enqueue;

// ── Coordinator (Step 5.8d) ────────────────────────────────────────────

interface QuotaServerCacheState {
  events: Map<string, UsageEvent>;
  cursors: Map<string, CachedLogCursor>;
}

export interface QuotaCacheCoordinatorDeps {
  path: string;
  read: (path: string) => QuotaCacheSnapshot | null;
  enqueue: (
    path: string,
    events: UsageEvent[],
    cursors: CachedLogCursor[],
    now: number,
  ) => Promise<void>;
}

function cursorKey(cursor: CachedLogCursor): string {
  return `${cursor.agent}:${cursor.pathHash}`;
}

function sameCursor(left: CachedLogCursor, right: CachedLogCursor): boolean {
  return left.pathHash === right.pathHash
    && left.agent === right.agent
    && left.modelRaw === right.modelRaw
    && left.resumeOffset === right.resumeOffset
    && left.observedSize === right.observedSize
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino;
}

function replaceAgentCursors(
  cache: QuotaServerCacheState,
  agent: UsageAgentId,
  incoming: CachedLogCursor[],
): boolean {
  const next = new Map(
    incoming
      .filter((cursor) => cursor.agent === agent)
      .map((cursor) => [cursorKey(cursor), cursor] as const),
  );
  const prior = [...cache.cursors.entries()]
    .filter(([, cursor]) => cursor.agent === agent);
  const unchanged = prior.length === next.size
    && prior.every(([key, cursor]) => {
      const candidate = next.get(key);
      return candidate != null && sameCursor(cursor, candidate);
    });
  if (unchanged) return false;
  for (const [key, cursor] of cache.cursors) {
    if (cursor.agent === agent) cache.cursors.delete(key);
  }
  for (const [key, cursor] of next) cache.cursors.set(key, cursor);
  return true;
}

function sameQuotaEventForCache(left: UsageEvent, right: UsageEvent): boolean {
  return JSON.stringify(cacheEvent(left)) === JSON.stringify(cacheEvent(right));
}

export interface QuotaCacheCoordinator {
  resumeCursors: (agent: UsageAgentId) => CachedLogCursor[];
  recordScan: (
    agent: UsageAgentId,
    incomingEvents: UsageEvent[],
    incomingCursors: CachedLogCursor[],
    now?: number,
  ) => Promise<void>;
}

export function createQuotaCacheCoordinator(deps: QuotaCacheCoordinatorDeps): QuotaCacheCoordinator {
  let state: QuotaServerCacheState | null = null;
  const current = (): QuotaServerCacheState => {
    if (state) return state;
    const snapshot = deps.read(deps.path);
    state = {
      events: new Map(
        (snapshot?.events ?? []).map((cached) => {
          const event = hydrateCachedEvent(cached);
          return [serverQuotaEventIdentity(event), event] as const;
        }),
      ),
      cursors: new Map(
        (snapshot?.cursors ?? []).map((cursor) => [cursorKey(cursor), cursor] as const),
      ),
    };
    return state;
  };
  return {
    resumeCursors(agent) {
      return [...current().cursors.values()].filter((cursor) => cursor.agent === agent);
    },
    async recordScan(
      agent: UsageAgentId,
      incomingEvents: UsageEvent[],
      incomingCursors: CachedLogCursor[],
      now = Date.now(),
    ): Promise<void> {
      const cache = current();
      let eventsChanged = false;
      // 惰性清理：coordinator 的 events Map 只增不减会无限累积；写盘时机按 8 天保留期淘汰。
      for (const [identity, prior] of cache.events) {
        if (prior.ts < now - CACHE_RETENTION_MS) {
          cache.events.delete(identity);
          eventsChanged = true;
        }
      }
      for (const event of incomingEvents) {
        if (event.ts < now - CACHE_RETENTION_MS) continue;
        const identity = serverQuotaEventIdentity(event);
        const prior = cache.events.get(identity);
        if (prior && sameQuotaEventForCache(prior, event)) continue;
        cache.events.set(identity, event);
        eventsChanged = true;
      }
      const cursorsChanged = replaceAgentCursors(cache, agent, incomingCursors);
      if (!eventsChanged && !cursorsChanged) return;
      await deps.enqueue(
        deps.path,
        [...cache.events.values()],
        [...cache.cursors.values()],
        now,
      );
    },
  };
}

const quotaCacheCoordinator = createQuotaCacheCoordinator({
  path: quotaCachePath(),
  read: readQuotaCache,
  enqueue: enqueueQuotaCacheWrite,
});

export function quotaResumeCursors(agent: UsageAgentId): CachedLogCursor[] {
  return quotaCacheCoordinator.resumeCursors(agent);
}

export function recordQuotaScan(
  agent: UsageAgentId,
  events: UsageEvent[],
  cursors: CachedLogCursor[],
  now = Date.now(),
): Promise<void> {
  return quotaCacheCoordinator.recordScan(agent, events, cursors, now);
}

// ── Bootstrap pagination (Step 5.9a) ──────────────────────────────────

export function readQuotaCacheSnapshotId(path: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(256);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    const match = buffer.subarray(0, count).toString("utf8")
      .match(/"snapshotId":"([a-f0-9]{64})"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

export interface QuotaBootstrapRequest {
  offset: number;
  limit: number;
  snapshotKey: string | null;
}

export interface BootstrapMemo {
  key: string;
  snapshot: QuotaCacheSnapshot;
}

let bootstrapMemo: BootstrapMemo | null = null;

export function readQuotaBootstrapSnapshot(): BootstrapMemo | null {
  const path = quotaCachePath();
  const headerId = readQuotaCacheSnapshotId(path);
  if (headerId && bootstrapMemo?.key === headerId) return bootstrapMemo;
  const snapshot = readQuotaCache(path);
  bootstrapMemo = snapshot
    ? { key: snapshot.snapshotId, snapshot }
    : null;
  return bootstrapMemo;
}

export function paginateQuotaBootstrap(
  current: BootstrapMemo | null,
  data: QuotaBootstrapRequest,
): QuotaBootstrapPage {
  if (!current) {
    return {
      events: [],
      nextOffset: null,
      savedAt: null,
      historyTruncated: false,
      truncatedBeforeMs: null,
      snapshotKey: null,
      restart: data.snapshotKey != null,
    };
  }
  if (data.snapshotKey != null && data.snapshotKey !== current.key) {
    return {
      events: [],
      nextOffset: 0,
      savedAt: current.snapshot.savedAt,
      historyTruncated: current.snapshot.historyTruncated,
      truncatedBeforeMs: current.snapshot.truncatedBeforeMs,
      snapshotKey: current.key,
      restart: true,
    };
  }
  const events = current.snapshot.events.slice(data.offset, data.offset + data.limit);
  const nextOffset = data.offset + events.length < current.snapshot.events.length
    ? data.offset + events.length
    : null;
  return {
    events,
    nextOffset,
    savedAt: current.snapshot.savedAt,
    historyTruncated: current.snapshot.historyTruncated,
    truncatedBeforeMs: current.snapshot.truncatedBeforeMs,
    snapshotKey: current.key,
    restart: false,
  };
}
