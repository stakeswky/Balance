import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { WEEK_MS, activityIdOf, latestActivities, type ClaudeLiveInfo, type UsageEvent } from "./types.ts";
import { foldByRequestId, normalizedActorId, parseJsonlLine, type SessionMeta } from "./claude-jsonl.ts";

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
  workflowMtimes: Map<string, number>;
  workflowLabels: Map<string, string>;
}

export interface ClaudeScanResult {
  events: UsageEvent[];
  live: ClaudeLiveInfo | null;
  active: ClaudeLiveInfo[];
  roots: string[];
  filesRead: number;
}

export function createScanState(): ScanState {
  return {
    files: new Map(),
    meta: new Map(),
    workflowMtimes: new Map(),
    workflowLabels: new Map(),
  };
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

function listWorkflowFiles(root: string, out: string[]): void {
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
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile() && name.startsWith("wf_") && name.endsWith(".json")) out.push(path);
    }
  }
}

function refreshWorkflowLabels(roots: string[], state: ScanState): void {
  const files: string[] = [];
  for (const root of roots) listWorkflowFiles(root, files);
  for (const path of files) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (state.workflowMtimes.get(path) === mtimeMs) continue;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const progress = Array.isArray(value.workflowProgress) ? value.workflowProgress : [];
      for (const raw of progress) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const actorId = normalizedActorId(row.agentId);
        const label = typeof row.label === "string" ? row.label.trim() : "";
        if (actorId && label) state.workflowLabels.set(actorId, label);
      }
      state.workflowMtimes.set(path, mtimeMs);
    } catch {
      /* ignore truncated workflow metadata */
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
  refreshWorkflowLabels(roots, state);

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

  return { events: folded, live, active, roots, filesRead };
}
