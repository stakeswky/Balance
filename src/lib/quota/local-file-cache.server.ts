import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";

export interface ParsedFileCache<T> {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  value: T;
}

export interface JsonlTailCache<T> {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  tail: string;
  values: T[];
}

export function readParsedFile<T>(opts: {
  path: string;
  cache: ParsedFileCache<T> | null;
  parse: (text: string) => T;
}): ParsedFileCache<T> | null {
  try {
    const stat = statSync(opts.path);
    if (
      opts.cache
      && opts.cache.size === stat.size
      && opts.cache.mtimeMs === stat.mtimeMs
      && opts.cache.ctimeMs === stat.ctimeMs
      && opts.cache.dev === stat.dev
      && opts.cache.ino === stat.ino
    ) return opts.cache;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      value: opts.parse(readFileSync(opts.path, "utf8")),
    };
  } catch {
    return opts.cache;
  }
}

export function readJsonlTailFile<T>(opts: {
  path: string;
  cache: JsonlTailCache<T> | null;
  parseLine: (line: string) => T | null;
  compact: (values: T[]) => T[];
}): JsonlTailCache<T> | null {
  try {
    const stat = statSync(opts.path);
    if (
      opts.cache
      && opts.cache.size === stat.size
      && opts.cache.mtimeMs === stat.mtimeMs
      && opts.cache.ctimeMs === stat.ctimeMs
      && opts.cache.dev === stat.dev
      && opts.cache.ino === stat.ino
    ) {
      return opts.cache;
    }

    const sameFile = opts.cache != null
      && opts.cache.dev === stat.dev
      && opts.cache.ino === stat.ino;
    const unchangedPrefix = sameFile
      && stat.size > opts.cache!.size;
    const appendOnly = unchangedPrefix;
    const start = appendOnly ? opts.cache!.size : 0;
    const prefixTail = appendOnly ? opts.cache!.tail : "";
    const priorValues = appendOnly ? [...opts.cache!.values] : [];
    const length = stat.size - start;
    let chunk = "";
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      const descriptor = openSync(opts.path, "r");
      try {
        let offset = 0;
        while (offset < length) {
          const count = readSync(descriptor, buffer, offset, length - offset, start + offset);
          if (count === 0) break;
          offset += count;
        }
        chunk = buffer.subarray(0, offset).toString("utf8");
      } finally {
        closeSync(descriptor);
      }
    }

    const lines = `${prefixTail}${chunk}`.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const value = opts.parseLine(line);
      if (value != null) priorValues.push(value);
    }
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail,
      values: opts.compact(priorValues),
    };
  } catch {
    return opts.cache;
  }
}
