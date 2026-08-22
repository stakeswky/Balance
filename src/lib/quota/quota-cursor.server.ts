import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { CachedLogCursor } from "./quota-cache.ts";
import { isSafeModelRaw } from "./quota-cache.ts";
import type { FileCursor, InventoryEntry } from "./file-inventory.server.ts";
import type { AgentId } from "./types.ts";

export interface SeededLogCursor {
  path: string;
  cached: CachedLogCursor;
}

export function logPathHash(agent: AgentId, path: string): string {
  return createHash("sha256")
    .update(`${agent}\0${resolve(path)}`, "utf8")
    .digest("hex");
}

export function cachedLogCursor(
  agent: AgentId,
  path: string,
  cursor: FileCursor,
  modelRaw?: string,
): CachedLogCursor {
  return {
    pathHash: logPathHash(agent, path),
    agent,
    modelRaw: modelRaw && isSafeModelRaw(modelRaw) ? modelRaw : undefined,
    // tail 非空表示 cursor.size 落在未完成 JSONL 行之后；不持久化 tail，故只能从 0 安全重放。
    resumeOffset: cursor.tail.length === 0 ? cursor.size : 0,
    observedSize: cursor.size,
    mtimeMs: cursor.mtimeMs,
    ctimeMs: cursor.ctimeMs,
    dev: cursor.dev,
    ino: cursor.ino,
  };
}

export function snapshotLogCursors(
  agent: AgentId,
  files: ReadonlyMap<string, FileCursor>,
  modelForPath: (path: string) => string | undefined = () => undefined,
): CachedLogCursor[] {
  return [...files.entries()]
    .filter(([, cursor]) => cursor.dev >= 0 && cursor.ino >= 0)
    .map(([path, cursor]) => cachedLogCursor(agent, path, cursor, modelForPath(path)))
    .sort((left, right) => left.pathHash.localeCompare(right.pathHash));
}

export function seedFileCursors(
  agent: AgentId,
  entries: readonly InventoryEntry[],
  files: Map<string, FileCursor>,
  cached: readonly CachedLogCursor[],
): SeededLogCursor[] {
  const byHash = new Map(
    cached
      .filter((cursor) => cursor.agent === agent)
      .map((cursor) => [cursor.pathHash, cursor] as const),
  );
  const seeded: SeededLogCursor[] = [];
  for (const entry of entries) {
    if (files.has(entry.path)) continue;
    const prior = byHash.get(logPathHash(agent, entry.path));
    if (!prior) continue;
    if (prior.dev !== entry.dev || prior.ino !== entry.ino) continue;
    if (prior.resumeOffset > entry.size) continue;
    files.set(entry.path, {
      size: prior.resumeOffset,
      mtimeMs: prior.mtimeMs,
      ctimeMs: prior.ctimeMs,
      dev: prior.dev,
      ino: prior.ino,
      tail: "",
    });
    seeded.push({ path: entry.path, cached: prior });
  }
  return seeded;
}
