import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, activityIdOf, latestActivities, type ClaudeLiveInfo, type UsageEvent } from "./types.ts";
import { foldByRequestId, normalizedActorId, parseJsonlLine, type SessionMeta } from "./claude-jsonl.ts";
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
import { seedFileCursors, snapshotLogCursors } from "./quota-cursor.server.ts";

const GROW_MS = 30 * 60 * 1000;
const WRITING_MS = 20 * 1000;

export type { FileCursor } from "./file-inventory.server.ts";

export interface ScanState {
  files: Map<string, FileCursor>;
  inventory: FileInventory;
  meta: Map<string, SessionMeta>;
  workflowMtimes: Map<string, number>;
  workflowLabels: Map<string, string>;
}

export interface ClaudeScanOptions {
  home?: string;
  now?: number;
  state?: ScanState;
  resumeCursors?: readonly CachedLogCursor[];
}

export interface ClaudeScanResult {
  events: UsageEvent[];
  quotaCacheCursors: CachedLogCursor[];
  live: ClaudeLiveInfo | null;
  active: ClaudeLiveInfo[];
  roots: string[];
  filesRead: number;
}

export type ScanClaudeUsage = (
  since: number,
  opts?: ClaudeScanOptions,
) => ClaudeScanResult;

export function createScanState(): ScanState {
  return {
    files: new Map(),
    inventory: createFileInventory(),
    meta: new Map(),
    workflowMtimes: new Map(),
    workflowLabels: new Map(),
  };
}

const defaultState = createScanState();

function projectRoots(home: string): string[] {
  return [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
}

function acceptsAgentFile(name: string): boolean {
  return name.endsWith(".jsonl") || (name.startsWith("wf_") && name.endsWith(".json"));
}

function refreshWorkflowLabelsFromEntries(
  entries: import("./file-inventory.server.ts").InventoryEntry[],
  state: ScanState,
): void {
  for (const entry of entries) {
    const name = entry.path.split(sep).pop() ?? "";
    if (!name.startsWith("wf_") || !name.endsWith(".json")) continue;
    if (state.workflowMtimes.get(entry.path) === entry.mtimeMs) continue;
    try {
      const value = JSON.parse(readFileSync(entry.path, "utf8")) as Record<string, unknown>;
      const progress = Array.isArray(value.workflowProgress) ? value.workflowProgress : [];
      for (const raw of progress) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const actorId = normalizedActorId(row.agentId);
        const label = typeof row.label === "string" ? row.label.trim() : "";
        if (actorId && label) state.workflowLabels.set(actorId, label);
      }
      state.workflowMtimes.set(entry.path, entry.mtimeMs);
    } catch {
      /* ignore truncated workflow metadata */
    }
  }
}


function sessionIdFromPath(path: string): string {
  const base = path.split(sep).pop() ?? "";
  return base.replace(/\.jsonl$/, "");
}

function isParentJsonl(path: string): boolean {
  return !path.includes(`${sep}subagents${sep}`);
}

export function scanClaudeUsage(
  since: number,
  opts?: ClaudeScanOptions,
): ClaudeScanResult {
  const home = opts?.home ?? homedir();
  const now = opts?.now ?? Date.now();
  const state = opts?.state ?? defaultState;
  const roots = projectRoots(home).filter((r) => existsSync(r));

  const inventory = refreshFileInventory({
    roots,
    now,
    intervalMs: 15_000,
    inventory: state.inventory,
    accepts: acceptsAgentFile,
  });
  const files = inventory.refreshed
    ? inventory.entries
    : snapshotInventoryEntries(inventory.entries);

  refreshWorkflowLabelsFromEntries(files, state);

  const seeded = since > 0
    ? seedFileCursors("claude", files, state.files, opts?.resumeCursors ?? [])
    : [];
  void seeded;

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
    const name = path.split(sep).pop() ?? "";
    if (!name.endsWith(".jsonl")) continue;

    if (entry.mtimeMs < weekStart && (state.files.get(path)?.size ?? 0) === 0) continue;

    const prev = state.files.get(path) ?? { ...EMPTY_FILE_CURSOR };
    const { text, next } = readChunkFromEntry(entry, prev);
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    state.files.set(path, { ...next, tail });
    if (!lines.length && !tail) continue;
    filesRead += 1;

    const sid = sessionIdFromPath(path);
    const pathActorId = path.includes(`${sep}subagents${sep}`) && sid.startsWith("agent-") ? sid : undefined;
    const meta = state.meta.get(path) ?? {
      sessionId: sid,
      cwd: "",
      title: "",
      lastUser: "",
      actorId: pathActorId,
      actorKind: pathActorId
        ? path.includes(`${sep}subagents${sep}workflows${sep}`)
          ? "workflow-subagent"
          : "subagent"
        : undefined,
    };
    for (const line of lines) {
      const ev = parseJsonlLine(line, meta);
      const workflowLabel = meta.actorId ? state.workflowLabels.get(meta.actorId) : undefined;
      if (ev) {
        if (workflowLabel) ev.task = workflowLabel;
        fresh.push(ev);
      }
    }
    state.meta.set(path, meta);
  }

  const folded = foldByRequestId(fresh).filter((e) => e.ts <= now + 60_000);
  const candidates: ClaudeLiveInfo[] = [];
  for (const [path, cursor] of state.files) {
    const age = now - cursor.mtimeMs;
    if (age > GROW_MS) continue;
    if (!isParentJsonl(path) && !path.includes(`${sep}subagents${sep}`)) continue;
    const meta = state.meta.get(path);
    if (path.includes(`${sep}subagents${sep}`) && !meta?.actorId) continue;
    const sessionId = meta?.sessionId ?? sessionIdFromPath(path);
    const activityId = meta?.actorId ?? sessionId;
    const mine = folded.filter((event) => activityIdOf(event) === activityId);
    candidates.push({
      sessionId,
      actorId: meta?.actorId,
      actorKind: meta?.actorKind,
      cwd: meta?.cwd ?? "",
      task:
        (meta?.actorId ? state.workflowLabels.get(meta.actorId) : undefined) ||
        meta?.title ||
        meta?.lastUser ||
        activityId,
      writing: age <= WRITING_MS,
      lastTs: cursor.mtimeMs,
      startedAt: mine[0]?.ts ?? cursor.mtimeMs,
      turns: mine.length,
    });
  }
  const { live, active } = latestActivities(candidates);

  return {
    events: folded,
    quotaCacheCursors: snapshotLogCursors("claude", state.files),
    live,
    active,
    roots,
    filesRead,
  };
}
