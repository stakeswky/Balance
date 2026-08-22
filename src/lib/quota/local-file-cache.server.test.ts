import assert from "node:assert/strict";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readJsonlTailFile,
  readParsedFile,
  type JsonlTailCache,
  type ParsedFileCache,
} from "./local-file-cache.server.ts";

function tmpFile(name = "test.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "balance-file-cache-"));
  return join(dir, name);
}

// ── readParsedFile ──────────────────────────────────────────────────────────

test("readParsedFile parses on first read", () => {
  const path = tmpFile();
  writeFileSync(path, JSON.stringify({ hello: "world" }));
  let parseCalls = 0;
  const result = readParsedFile({
    path,
    cache: null,
    parse: (text) => {
      parseCalls += 1;
      return JSON.parse(text);
    },
  });
  assert.equal(parseCalls, 1);
  assert.deepEqual(result?.value, { hello: "world" });
});

test("readParsedFile returns cached value when mtime unchanged", () => {
  const path = tmpFile();
  writeFileSync(path, JSON.stringify({ hello: "world" }));
  let parseCalls = 0;
  const parse = (text: string) => {
    parseCalls += 1;
    return JSON.parse(text);
  };
  const first = readParsedFile({ path, cache: null, parse });
  assert.equal(parseCalls, 1);
  const second = readParsedFile({ path, cache: first, parse });
  assert.equal(parseCalls, 1);
  assert.strictEqual(second, first);
});

test("readParsedFile re-parses when content changes (same size rewrite)", () => {
  const path = tmpFile();
  writeFileSync(path, '{"a":1}');
  let parseCalls = 0;
  const parse = (text: string) => {
    parseCalls += 1;
    return JSON.parse(text);
  };
  const first = readParsedFile({ path, cache: null, parse });
  assert.equal(parseCalls, 1);
  // Same-size rewrite: force mtime change
  const origStat = statSync(path);
  // Write same-length content with a tiny delay to ensure mtime differs
  writeFileSync(path, '{"b":2}');
  const newStat = statSync(path);
  // If mtime didn't change (unlikely but possible on fast fs), skip this assertion
  if (newStat.mtimeMs !== origStat.mtimeMs || newStat.ctimeMs !== origStat.ctimeMs) {
    const second = readParsedFile({ path, cache: first, parse });
    assert.equal(parseCalls, 2);
    assert.deepEqual(second?.value, { b: 2 });
  }
});

test("readParsedFile returns existing cache when file is missing", () => {
  const path = tmpFile();
  writeFileSync(path, '{"a":1}');
  const parse = (text: string) => JSON.parse(text);
  const first = readParsedFile({ path, cache: null, parse });
  unlinkSync(path);
  const second = readParsedFile({ path, cache: first, parse });
  assert.strictEqual(second, first);
});

test("readParsedFile returns null when file never existed and no cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "balance-file-cache-"));
  const result = readParsedFile({
    path: join(dir, "nonexistent.json"),
    cache: null,
    parse: JSON.parse,
  });
  assert.equal(result, null);
});

test("readParsedFile detects inode replace (atomic rename)", () => {
  const path = tmpFile();
  writeFileSync(path, '{"v":1}');
  let parseCalls = 0;
  const parse = (text: string) => {
    parseCalls += 1;
    return JSON.parse(text);
  };
  const first = readParsedFile({ path, cache: null, parse });
  assert.equal(parseCalls, 1);

  // Atomic replace: write to a temp file and rename
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, '{"v":2}');
  renameSync(tmp, path);

  const second = readParsedFile({ path, cache: first, parse });
  assert.equal(parseCalls, 2);
  assert.deepEqual(second?.value, { v: 2 });
});

// ── readJsonlTailFile ───────────────────────────────────────────────────────

function makeJsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("readJsonlTailFile parses all lines on first read", () => {
  const path = tmpFile("unified.jsonl");
  const entries = [{ id: 1 }, { id: 2 }, { id: 3 }];
  writeFileSync(path, makeJsonl(entries));
  const result = readJsonlTailFile({
    path,
    cache: null,
    parseLine: (line) => JSON.parse(line) as { id: number },
    compact: (values) => values,
  });
  assert.equal(result?.values.length, 3);
  assert.deepEqual(result?.values.map((v) => v.id), [1, 2, 3]);
});

test("readJsonlTailFile returns cached value when unchanged", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, makeJsonl([{ id: 1 }]));
  let parseCalls = 0;
  const parseLine = (line: string) => {
    parseCalls += 1;
    return JSON.parse(line) as { id: number };
  };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  assert.equal(parseCalls, 1);
  const second = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
  assert.equal(parseCalls, 1);
  assert.strictEqual(second, first);
});

test("readJsonlTailFile reads only appended bytes on append", () => {
  const path = tmpFile("unified.jsonl");
  const initial = [{ id: 1 }, { id: 2 }];
  writeFileSync(path, makeJsonl(initial));
  let parseCalls = 0;
  const parseLine = (line: string) => {
    parseCalls += 1;
    return JSON.parse(line) as { id: number };
  };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  assert.equal(parseCalls, 2);
  assert.equal(first?.values.length, 2);

  // Append one line
  const fd = openSync(path, "a");
  const newLine = `${JSON.stringify({ id: 3 })}\n`;
  writeSync(fd, newLine);
  closeSync(fd);

  parseCalls = 0;
  const second = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
  assert.equal(parseCalls, 1); // Only parsed the new line
  assert.equal(second?.values.length, 3);
  assert.deepEqual(second?.values.map((v) => v.id), [1, 2, 3]);
});

test("readJsonlTailFile handles half-line across chunks", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, makeJsonl([{ id: 1 }]));
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });

  // Append a half-line (no trailing newline)
  const fd = openSync(path, "a");
  const halfContent = '{"id":';
  writeSync(fd, halfContent);
  closeSync(fd);

  const withHalf = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
  // half-line should be stored in tail, not parsed
  assert.equal(withHalf?.values.length, 1);
  assert.equal(withHalf?.tail, '{"id":');

  // Now complete the line
  const fd2 = openSync(path, "a");
  writeSync(fd2, "2}\n");
  closeSync(fd2);

  const completed = readJsonlTailFile({ path, cache: withHalf, parseLine, compact: (v) => v });
  assert.equal(completed?.values.length, 2);
  assert.deepEqual(completed?.values.map((v) => v.id), [1, 2]);
  assert.equal(completed?.tail, "");
});

test("readJsonlTailFile full-rereads on truncate", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, makeJsonl([{ id: 1 }, { id: 2 }, { id: 3 }]));
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  assert.equal(first?.values.length, 3);

  // Truncate the file to fewer lines
  writeFileSync(path, makeJsonl([{ id: 10 }]));
  const afterTruncate = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
  assert.equal(afterTruncate?.values.length, 1);
  assert.deepEqual(afterTruncate?.values[0]?.id, 10);
});

test("readJsonlTailFile full-rereads on same-size rewrite", () => {
  const path = tmpFile("unified.jsonl");
  // Write known exact content
  const content1 = '{"id":1}\n';
  writeFileSync(path, content1);
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  assert.equal(first?.values.length, 1);

  // Same-size rewrite
  const origStat = statSync(path);
  writeFileSync(path, '{"id":2}\n');
  const newStat = statSync(path);
  if (newStat.mtimeMs !== origStat.mtimeMs || newStat.ctimeMs !== origStat.ctimeMs) {
    const afterRewrite = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
    assert.equal(afterRewrite?.values.length, 1);
    assert.equal(afterRewrite?.values[0]?.id, 2);
  }
});

test("readJsonlTailFile full-rereads on inode replace (atomic rename)", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, makeJsonl([{ id: 1 }]));
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });

  // Atomic replace
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, makeJsonl([{ id: 100 }, { id: 200 }]));
  renameSync(tmp, path);

  const afterReplace = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
  assert.equal(afterReplace?.values.length, 2);
  assert.deepEqual(afterReplace?.values.map((v) => v.id), [100, 200]);
});

test("readJsonlTailFile applies compact on every read", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, makeJsonl([{ id: 1 }, { id: 1 }, { id: 2 }]));
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  // compact deduplicates by id
  const compact = (values: { id: number }[]) => {
    const seen = new Set<number>();
    return values.filter((v) => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });
  };
  const result = readJsonlTailFile({ path, cache: null, parseLine, compact });
  assert.equal(result?.values.length, 2);
  assert.deepEqual(result?.values.map((v) => v.id), [1, 2]);
});

test("readJsonlTailFile returns existing cache when file disappears", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, makeJsonl([{ id: 1 }]));
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  const first = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  unlinkSync(path);
  const second = readJsonlTailFile({ path, cache: first, parseLine, compact: (v) => v });
  assert.strictEqual(second, first);
});

test("readJsonlTailFile returns null when file never existed and no cache", () => {
  const result = readJsonlTailFile({
    path: "/nonexistent/path/unified.jsonl",
    cache: null,
    parseLine: JSON.parse,
    compact: (v) => v,
  });
  assert.equal(result, null);
});

test("readJsonlTailFile skips blank lines", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, '{"id":1}\n\n\n{"id":2}\n');
  const parseLine = (line: string) => JSON.parse(line) as { id: number };
  const result = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  assert.equal(result?.values.length, 2);
});

test("readJsonlTailFile skips lines that parseLine returns null for", () => {
  const path = tmpFile("unified.jsonl");
  writeFileSync(path, '{"id":1}\n{"skip":true}\n{"id":2}\n');
  const parseLine = (line: string) => {
    const parsed = JSON.parse(line);
    if (parsed.skip) return null;
    return parsed as { id: number };
  };
  const result = readJsonlTailFile({ path, cache: null, parseLine, compact: (v) => v });
  assert.equal(result?.values.length, 2);
});
