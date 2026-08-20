import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, type AgentLiveInfo, type UsageEvent } from "./types.ts";
import { foldGrokTurns, parseGrokUpdateLine, type GrokSessionMeta } from "./grok-jsonl.ts";

const GROW_MS = 30 * 60 * 1000;
const WRITING_MS = 20 * 1000;

export interface FileCursor {
  size: number;
  mtimeMs: number;
  tail: string;
}

export interface GrokScanState {
  files: Map<string, FileCursor>;
  meta: Map<string, GrokSessionMeta>;
}

export interface GrokScanResult {
  events: UsageEvent[];
  live: AgentLiveInfo | null;
  roots: string[];
  filesRead: number;
}

export function createGrokScanState(): GrokScanState {
  return { files: new Map(), meta: new Map() };
}

const defaultState = createGrokScanState();

function grokHomeOf(home: string, override?: string): string {
  return override || process.env.GROK_HOME || join(home, ".grok");
}

function listUpdates(root: string, out: string[]): void {
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
      else if (st.isFile() && name === "updates.jsonl") out.push(p);
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
  opts?: { home?: string; grokHome?: string; now?: number; state?: GrokScanState },
): GrokScanResult {
  const home = opts?.home ?? homedir();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const now = opts?.now ?? Date.now();
  const state = opts?.state ?? defaultState;
  const sessionsRoot = join(grokHome, "sessions");
  const roots = existsSync(sessionsRoot) ? [sessionsRoot] : [];
  const files: string[] = [];
  for (const root of roots) listUpdates(root, files);

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
    if (!lines.length) continue;
    filesRead += 1;

    const sid = sessionIdFromPath(path);
    const dir = path.slice(0, path.lastIndexOf(sep));
    const meta =
      state.meta.get(sid) ??
      ({ sessionId: sid, cwd: cwdFromEncoded(path, sessionsRoot), title: "", model: "grok-4.6" } satisfies GrokSessionMeta);
    loadSummary(dir, meta);
    for (const line of lines) {
      const ev = parseGrokUpdateLine(line, meta);
      if (ev) fresh.push(ev);
    }
    state.meta.set(sid, meta);
  }

  const folded = foldGrokTurns(fresh).filter((e) => (since <= 0 || e.ts >= since) && e.ts <= now + 60_000);

  let live: AgentLiveInfo | null = null;
  let bestMtime = 0;
  for (const [path, cursor] of state.files) {
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
        task: meta?.title || meta?.cwd || sid,
        writing: age <= WRITING_MS,
        lastTs: cursor.mtimeMs,
        startedAt: mine[0]?.ts ?? cursor.mtimeMs,
        turns: mine.length,
      };
    }
  }

  return { events: folded, live, roots, filesRead };
}
