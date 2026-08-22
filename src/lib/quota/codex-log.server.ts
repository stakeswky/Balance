import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, latestActivities, type AgentLiveInfo, type UsageEvent } from "./types.ts";
import {
  foldCodexTurns,
  parseCodexJsonlLine,
  type CodexSessionMeta,
} from "./codex-jsonl.ts";
import { collapseOfficialPlateaus, type OfficialSlice } from "./official.ts";

const GROW_MS = 30 * 60 * 1000;
const WRITING_MS = 20 * 1000;

export interface FileCursor {
  size: number;
  mtimeMs: number;
  tail: string;
}

export interface CodexScanState {
  files: Map<string, FileCursor>;
  meta: Map<string, CodexSessionMeta>;
}

export interface CodexScanResult {
  events: UsageEvent[];
  live: AgentLiveInfo | null;
  active: AgentLiveInfo[];
  roots: string[];
  filesRead: number;
  official: OfficialSlice | null;
  officialHistory: OfficialSlice[];
}

export function createCodexScanState(): CodexScanState {
  return { files: new Map(), meta: new Map() };
}

const defaultState = createCodexScanState();

function codexHomeOf(home: string, override?: string): string {
  return override || process.env.CODEX_HOME || join(home, ".codex");
}

function listJsonl(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name.endsWith(".lock")) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && name.endsWith(".jsonl") && name.startsWith("rollout-")) out.push(p);
    }
  }
}

function readNewChunk(path: string, cursor: FileCursor): { text: string; next: FileCursor } {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { text: "", next: cursor };
  }
  let start = cursor.size;
  let tail = cursor.tail;
  if (st.size < cursor.size) {
    start = 0;
    tail = "";
  }
  if (st.size === start && st.mtimeMs === cursor.mtimeMs) {
    return { text: "", next: cursor };
  }
  const len = st.size - start;
  if (len <= 0) {
    return { text: "", next: { size: st.size, mtimeMs: st.mtimeMs, tail } };
  }
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return {
    text: tail + buf.toString("utf8"),
    next: { size: st.size, mtimeMs: st.mtimeMs, tail: "" },
  };
}

function sessionIdFromPath(path: string): string {
  const base = path.split(sep).pop() ?? "";
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m?.[1] ?? base.replace(/\.jsonl$/, "");
}

export function scanCodexUsage(
  since: number,
  opts?: { home?: string; codexHome?: string; now?: number; state?: CodexScanState },
): CodexScanResult {
  const home = opts?.home ?? homedir();
  const codexHome = codexHomeOf(home, opts?.codexHome);
  const now = opts?.now ?? Date.now();
  const state = opts?.state ?? defaultState;
  const sessionsRoot = join(codexHome, "sessions");
  const roots = existsSync(sessionsRoot) ? [sessionsRoot] : [];
  const files: string[] = [];
  for (const root of roots) listJsonl(root, files);

  if (since <= 0) {
    for (const [path] of state.files) {
      state.files.set(path, { size: 0, mtimeMs: 0, tail: "" });
    }
  }

  const weekStart = now - WEEK_MS - 24 * 60 * 60 * 1000;
  const fresh: UsageEvent[] = [];
  let filesRead = 0;
  const parsedOfficial: OfficialSlice[] = [];

  for (const path of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.mtimeMs < weekStart && (state.files.get(path)?.size ?? 0) === 0) continue;

    const prev = state.files.get(path) ?? { size: 0, mtimeMs: 0, tail: "" };
    if (st.size === prev.size && st.mtimeMs === prev.mtimeMs) continue;

    const { text, next } = readNewChunk(path, prev);
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

  return { events: folded, live, active, roots, filesRead, official, officialHistory };
}
