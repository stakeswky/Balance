import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, latestActivities, type AgentLiveInfo, type UsageEvent } from "./types.ts";
import {
  foldCodexTurns,
  parseCodexJsonlLine,
  type CodexSessionMeta,
} from "./codex-jsonl.ts";
import { collapseOfficialPlateaus, type OfficialSlice } from "./official.ts";
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

export interface CodexScanState {
  files: Map<string, FileCursor>;
  inventory: FileInventory;
  meta: Map<string, CodexSessionMeta>;
}

export interface CodexScanOptions {
  home?: string;
  codexHome?: string;
  now?: number;
  state?: CodexScanState;
  resumeCursors?: readonly CachedLogCursor[];
}

export interface CodexScanResult {
  events: UsageEvent[];
  quotaCacheEvents: UsageEvent[];
  quotaCacheCursors: CachedLogCursor[];
  live: AgentLiveInfo | null;
  active: AgentLiveInfo[];
  roots: string[];
  filesRead: number;
  official: OfficialSlice | null;
  officialHistory: OfficialSlice[];
}

export type ScanCodexUsage = (
  since: number,
  opts?: CodexScanOptions,
) => CodexScanResult;

export function createCodexScanState(): CodexScanState {
  return { files: new Map(), inventory: createFileInventory(), meta: new Map() };
}

const defaultState = createCodexScanState();

function codexHomeOf(home: string, override?: string): string {
  return override || process.env.CODEX_HOME || join(home, ".codex");
}

function acceptsCodexFile(name: string): boolean {
  return name.endsWith(".jsonl") && name.startsWith("rollout-");
}

function sessionIdFromPath(path: string): string {
  const base = path.split(sep).pop() ?? "";
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m?.[1] ?? base.replace(/\.jsonl$/, "");
}

export function scanCodexUsage(
  since: number,
  opts?: CodexScanOptions,
): CodexScanResult {
  const home = opts?.home ?? homedir();
  const codexHome = codexHomeOf(home, opts?.codexHome);
  const now = opts?.now ?? Date.now();
  const state = opts?.state ?? defaultState;
  const sessionsRoot = join(codexHome, "sessions");
  const roots = existsSync(sessionsRoot) ? [sessionsRoot] : [];

  const inventory = refreshFileInventory({
    roots,
    now,
    intervalMs: 15_000,
    inventory: state.inventory,
    accepts: acceptsCodexFile,
  });
  const files = inventory.refreshed
    ? inventory.entries
    : snapshotInventoryEntries(inventory.entries);

  // Codex：token_count 依赖此前 turn_context 的 model；不恢复 cwd/title/session 原文。
  const seeded = since > 0
    ? seedFileCursors("codex", files, state.files, opts?.resumeCursors ?? [])
    : [];
  for (const { path, cached } of seeded) {
    if (!cached.modelRaw || state.meta.has(path)) continue;
    state.meta.set(path, {
      sessionId: sessionIdFromPath(path),
      cwd: "",
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
  const parsedOfficial: OfficialSlice[] = [];

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
    const meta =
      state.meta.get(path) ??
      ({ sessionId: sid, cwd: "", title: "" } satisfies CodexSessionMeta);
    for (const line of lines) {
      const parsed = parseCodexJsonlLine(line, meta);
      if (parsed.event) fresh.push(parsed.event);
      if (parsed.official) parsedOfficial.push(parsed.official);
    }
    state.meta.set(path, meta);
  }

  const folded = foldCodexTurns(fresh).filter((e) => e.ts <= now + 60_000);
  const candidates: AgentLiveInfo[] = [];
  for (const [path, cursor] of state.files) {
    const age = now - cursor.mtimeMs;
    if (age > GROW_MS) continue;
    const meta = state.meta.get(path);
    const sessionId = meta?.sessionId ?? sessionIdFromPath(path);
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

  parsedOfficial.sort((left, right) => left.fetchedAt - right.fetchedAt);
  const seenOfficial = new Set<string>();
  const deduplicatedOfficial = parsedOfficial.filter((slice) => {
    const key = [
      slice.fetchedAt,
      slice.windowPct ?? "na",
      slice.weekPct ?? "na",
      slice.windowResetsAt ?? "na",
      slice.weekResetsAt ?? "na",
    ].join(":");
    if (seenOfficial.has(key)) return false;
    seenOfficial.add(key);
    return true;
  });
  const officialHistory = collapseOfficialPlateaus(deduplicatedOfficial);
  const official = officialHistory.at(-1) ?? null;

  withCacheIdentity(folded);
  return {
    events: scanResponseEvents(folded, since),
    quotaCacheEvents: folded,
    quotaCacheCursors: snapshotLogCursors(
      "codex",
      state.files,
      (path) => state.meta.get(path)?.model,
    ),
    live,
    active,
    roots,
    filesRead,
    official,
    officialHistory,
  };
}
