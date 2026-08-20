import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, type ClaudeLiveInfo, type UsageEvent } from "./types.ts";
import { foldByRequestId, parseJsonlLine, type SessionMeta } from "./claude-jsonl.ts";

const GROW_MS = 30 * 60 * 1000;
const WRITING_MS = 20 * 1000;

export interface FileCursor {
  size: number;
  mtimeMs: number;
  tail: string;
}

export interface ScanState {
  files: Map<string, FileCursor>;
  meta: Map<string, SessionMeta>;
}

export interface ClaudeScanResult {
  events: UsageEvent[];
  live: ClaudeLiveInfo | null;
  roots: string[];
  filesRead: number;
}

export function createScanState(): ScanState {
  return { files: new Map(), meta: new Map() };
}

const defaultState = createScanState();

function projectRoots(home: string): string[] {
  return [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
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
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && name.endsWith(".jsonl")) out.push(p);
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
  return base.replace(/\.jsonl$/, "");
}

function isParentJsonl(path: string): boolean {
  return !path.includes(`${sep}subagents${sep}`);
}

export function scanClaudeUsage(
  since: number,
  opts?: { home?: string; now?: number; state?: ScanState },
): ClaudeScanResult {
  const home = opts?.home ?? homedir();
  const now = opts?.now ?? Date.now();
  const state = opts?.state ?? defaultState;
  const roots = projectRoots(home).filter((r) => existsSync(r));
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
    if (!lines.length && !tail) continue;
    filesRead += 1;

    const sid = sessionIdFromPath(path);
    const meta = state.meta.get(sid) ?? { sessionId: sid, cwd: "", title: "", lastUser: "" };
    for (const line of lines) {
      const ev = parseJsonlLine(line, meta);
      if (ev) fresh.push(ev);
    }
    state.meta.set(sid, meta);
  }

  const folded = foldByRequestId(fresh).filter((e) => (since <= 0 || e.ts >= since) && e.ts <= now + 60_000);

  let live: ClaudeLiveInfo | null = null;
  let bestMtime = 0;
  for (const [path, cursor] of state.files) {
    if (!isParentJsonl(path)) continue;
    const age = now - cursor.mtimeMs;
    if (age > GROW_MS) continue;
    if (cursor.mtimeMs >= bestMtime) {
      bestMtime = cursor.mtimeMs;
      const sid = sessionIdFromPath(path);
      const meta = state.meta.get(sid);
      const mine = folded.filter((e) => e.sessionId === sid);
      live = {
        sessionId: sid,
        cwd: meta?.cwd ?? "",
        task: meta?.title || meta?.lastUser || sid,
        writing: age <= WRITING_MS,
        lastTs: cursor.mtimeMs,
        startedAt: mine[0]?.ts ?? cursor.mtimeMs,
        turns: mine.length,
      };
    }
  }

  return { events: folded, live, roots, filesRead };
}
