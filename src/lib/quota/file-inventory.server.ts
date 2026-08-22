import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export interface InventoryEntry {
  root: string;
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

export interface FileInventory {
  refreshedAt: number;
  entries: InventoryEntry[];
}

export interface InventorySnapshot {
  entries: InventoryEntry[];
  refreshed: boolean;
}

export interface FileCursor {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  tail: string;
}

export const EMPTY_FILE_CURSOR: FileCursor = {
  size: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  dev: -1,
  ino: -1,
  tail: "",
};

export function createFileInventory(): FileInventory {
  return { refreshedAt: Number.NEGATIVE_INFINITY, entries: [] };
}

function isWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function refreshFileInventory(opts: {
  roots: string[];
  now: number;
  intervalMs: number;
  inventory: FileInventory;
  accepts: (name: string, path: string) => boolean;
  lstat?: typeof lstatSync;
  realpath?: typeof realpathSync;
  readdir?: typeof readdirSync;
  stat?: typeof statSync;
}): InventorySnapshot {
  if (opts.now - opts.inventory.refreshedAt < opts.intervalMs) {
    return { entries: opts.inventory.entries, refreshed: false };
  }
  const readLstat = opts.lstat ?? lstatSync;
  const readRealpath = opts.realpath ?? realpathSync;
  const readDirectory = opts.readdir ?? readdirSync;
  const readStat = opts.stat ?? statSync;
  const entries: InventoryEntry[] = [];
  const stack: Array<{ root: string; directory: string }> = [];
  for (const configuredRoot of opts.roots) {
    try {
      const rootStat = readLstat(configuredRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
      const root = readRealpath(configuredRoot);
      stack.push({ root, directory: root });
    } catch {
      continue;
    }
  }
  while (stack.length) {
    const { root, directory } = stack.pop()!;
    let names: string[];
    try {
      names = readDirectory(directory) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".") || name.endsWith(".lock")) continue;
      const path = join(directory, name);
      try {
        const linkStat = readLstat(path);
        if (linkStat.isSymbolicLink()) continue;
        const canonical = readRealpath(path);
        if (!isWithinRoot(root, canonical)) continue;
        const stat = readStat(canonical);
        if (stat.isDirectory()) stack.push({ root, directory: canonical });
        else if (stat.isFile() && opts.accepts(name, canonical)) {
          entries.push({
            root,
            path: canonical,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            dev: stat.dev,
            ino: stat.ino,
          });
        }
      } catch {
        continue;
      }
    }
  }
  opts.inventory.entries = entries;
  opts.inventory.refreshedAt = opts.now;
  return { entries, refreshed: true };
}

export function snapshotInventoryEntries(
  entries: InventoryEntry[],
  readLstat: typeof lstatSync = lstatSync,
  readRealpath: typeof realpathSync = realpathSync,
  readStat: typeof statSync = statSync,
): InventoryEntry[] {
  const snapshots: InventoryEntry[] = [];
  for (const entry of entries) {
    try {
      const linkStat = readLstat(entry.path);
      if (linkStat.isSymbolicLink()) continue;
      const canonical = readRealpath(entry.path);
      if (!isWithinRoot(entry.root, canonical)) continue;
      const stat = readStat(canonical);
      if (!stat.isFile()) continue;
      snapshots.push({
        root: entry.root,
        path: canonical,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        dev: stat.dev,
        ino: stat.ino,
      });
    } catch {
      continue;
    }
  }
  return snapshots;
}

export function readChunkFromEntry(
  entry: InventoryEntry,
  cursor: FileCursor,
): { text: string; next: FileCursor } {
  const sameFile = cursor.dev === entry.dev && cursor.ino === entry.ino;
  const unchanged = sameFile
    && cursor.size === entry.size
    && cursor.mtimeMs === entry.mtimeMs
    && cursor.ctimeMs === entry.ctimeMs;
  if (unchanged) return { text: "", next: cursor };

  const appendOnly = sameFile && entry.size > cursor.size;
  const start = appendOnly ? cursor.size : 0;
  const prefixTail = appendOnly ? cursor.tail : "";
  const requested = Math.max(0, entry.size - start);
  if (requested === 0) {
    return {
      text: "",
      next: {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        dev: entry.dev,
        ino: entry.ino,
        tail: "",
      },
    };
  }

  const buffer = Buffer.alloc(requested);
  let descriptor: number | null = null;
  let offset = 0;
  try {
    descriptor = openSync(entry.path, "r");
    const opened = fstatSync(descriptor);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
      return { text: "", next: cursor };
    }
    while (offset < requested) {
      const count = readSync(descriptor, buffer, offset, requested - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
  } catch {
    return { text: "", next: cursor };
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
  return {
    text: prefixTail + buffer.subarray(0, offset).toString("utf8"),
    next: {
      size: start + offset,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      dev: entry.dev,
      ino: entry.ino,
      tail: "",
    },
  };
}
