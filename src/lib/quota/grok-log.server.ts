import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, latestActivities, type AgentLiveInfo, type UsageEvent } from "./types.ts";
import { foldGrokTurns, parseGrokUpdateLine, type GrokSessionMeta } from "./grok-jsonl.ts";
import {
  type FileCursor,
  type FileInventory,
  EMPTY_FILE_CURSOR,
  createFileInventory,
  refreshFileInventory,
  snapshotInventoryEntries,
  readChunkFromEntry,
} from "./file-inventory.server.ts";
import type { CachedLogCursor } from "./quota-cache.ts";
import { withCacheIdentity, scanResponseEvents } from "./quota-cache.server.ts";
import { seedFileCursors, snapshotLogCursors } from "./quota-cursor.server.ts";

const GROW_MS = 30 * 60 * 1000;
const WRITING_MS = 20 * 1000;

export type { FileCursor } from "./file-inventory.server.ts";

export interface GrokScanState {
  files: Map<string, FileCursor>;
  inventory: FileInventory;
  meta: Map<string, GrokSessionMeta>;
}

export interface GrokScanOptions {
  home?: string;
  grokHome?: string;
  now?: number;
  state?: GrokScanState;
  resumeCursors?: readonly CachedLogCursor[];
}

export interface GrokScanResult {
  events: UsageEvent[];
  quotaCacheEvents: UsageEvent[];
  quotaCacheCursors: CachedLogCursor[];
  live: AgentLiveInfo | null;
  active: AgentLiveInfo[];
  roots: string[];
  filesRead: number;
}

export type ScanGrokUsage = (
  since: number,
  opts?: GrokScanOptions,
) => GrokScanResult;

export function createGrokScanState(): GrokScanState {
  return { files: new Map(), inventory: createFileInventory(), meta: new Map() };
}

const defaultState = createGrokScanState();

function grokHomeOf(home: string, override?: string): string {
  return override || process.env.GROK_HOME || join(home, ".grok");
}

function acceptsGrokFile(name: string): boolean {
  return name === "updates.jsonl";
}

function sessionIdFromPath(path: string): string {
  const parts = path.split(sep);
  const idx = parts.lastIndexOf("updates.jsonl");
  return idx > 0 ? parts[idx - 1]! : "grok";
}

function cwdFromEncoded(path: string, sessionsRoot: string): string {
  const rel = path.startsWith(sessionsRoot) ? path.slice(sessionsRoot.length).replace(/^[/\\]/, "") : path;
  const group = rel.split(sep)[0] ?? "";
  try {
    return decodeURIComponent(group);
  } catch {
    return group;
  }
}

function loadSummary(dir: string, meta: GrokSessionMeta): void {
  const p = join(dir, "summary.json");
  if (!existsSync(p)) return;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const info = s.info && typeof s.info === "object" ? (s.info as Record<string, unknown>) : {};
    if (typeof info.cwd === "string" && info.cwd) meta.cwd = info.cwd;
    const title = s.generated_title || s.session_summary;
    if (typeof title === "string" && title) meta.title = title;
    if (typeof s.current_model_id === "string") meta.model = s.current_model_id;
  } catch {
    /* ignore truncated summary */
  }
}

export function scanGrokUsage(
  since: number,
  opts?: GrokScanOptions,
): GrokScanResult {
  const home = opts?.home ?? homedir();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const now = opts?.now ?? Date.now();
  const state = opts?.state ?? defaultState;
  const sessionsRoot = join(grokHome, "sessions");
  const roots = existsSync(sessionsRoot) ? [sessionsRoot] : [];

  const inventory = refreshFileInventory({
    roots,
    now,
    intervalMs: 15_000,
    inventory: state.inventory,
    accepts: acceptsGrokFile,
  });
  const files = inventory.refreshed
    ? inventory.entries
    : snapshotInventoryEntries(inventory.entries);

  // Grok：meta map 以 sid 为 key；其余字段仍由路径/summary 的现有逻辑补齐。
  const seeded = since > 0
    ? seedFileCursors("grok", files, state.files, opts?.resumeCursors ?? [])
    : [];
  for (const { path, cached } of seeded) {
    if (!cached.modelRaw) continue;
    const sid = sessionIdFromPath(path);
    if (state.meta.has(sid)) continue;
    state.meta.set(sid, {
      sessionId: sid,
      cwd: cwdFromEncoded(path, sessionsRoot),
      title: "",
      model: cached.modelRaw,
    });
  }

  if (since <= 0) {
    for (const [path] of state.files) {
      state.files.set(path, { ...EMPTY_FILE_CURSOR });
    }
  }

  const weekStart = now - WEEK_MS - 24 * 60 * 60 * 1000;
  const fresh: UsageEvent[] = [];
  let filesRead = 0;

  for (const entry of files) {
    const path = entry.path;
    if (entry.mtimeMs < weekStart && (state.files.get(path)?.size ?? 0) === 0) continue;

    const prev = state.files.get(path) ?? { ...EMPTY_FILE_CURSOR };
    const { text, next } = readChunkFromEntry(entry, prev);
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    state.files.set(path, { ...next, tail });
    if (!lines.length) continue;
    filesRead += 1;

    const sid = sessionIdFromPath(path);
    const dir = path.slice(0, path.lastIndexOf(sep));
    const meta =
      state.meta.get(sid) ??
      ({ sessionId: sid, cwd: cwdFromEncoded(path, sessionsRoot), title: "" } satisfies GrokSessionMeta);
    loadSummary(dir, meta);
    for (const line of lines) {
      const ev = parseGrokUpdateLine(line, meta);
      if (ev) fresh.push(ev);
    }
    state.meta.set(sid, meta);
  }

  const folded = foldGrokTurns(fresh).filter((e) => e.ts <= now + 60_000);
  const candidates: AgentLiveInfo[] = [];
  for (const [path, cursor] of state.files) {
    const age = now - cursor.mtimeMs;
    if (age > GROW_MS) continue;
    const sessionId = sessionIdFromPath(path);
    const meta = state.meta.get(sessionId);
    const mine = folded.filter((event) => event.sessionId === sessionId);
    candidates.push({
      sessionId,
      cwd: meta?.cwd ?? "",
      task: meta?.title || meta?.cwd || sessionId,
      writing: age <= WRITING_MS,
      lastTs: cursor.mtimeMs,
      startedAt: mine[0]?.ts ?? cursor.mtimeMs,
      turns: mine.length,
    });
  }
  const { live, active } = latestActivities(candidates);

  withCacheIdentity(folded);
  return {
    events: scanResponseEvents(folded, since),
    quotaCacheEvents: folded,
    quotaCacheCursors: snapshotLogCursors(
      "grok",
      state.files,
      (path) => state.meta.get(sessionIdFromPath(path))?.model,
    ),
    live,
    active,
    roots,
    filesRead,
  };
}
