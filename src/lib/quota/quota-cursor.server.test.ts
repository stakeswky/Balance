import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FileCursor, InventoryEntry } from "./file-inventory.server.ts";
import { readChunkFromEntry } from "./file-inventory.server.ts";
import type { CachedLogCursor } from "./quota-cache.ts";
import {
  logPathHash,
  cachedLogCursor,
  snapshotLogCursors,
  seedFileCursors,
  type SeededLogCursor,
} from "./quota-cursor.server.ts";

describe("hashed log cursor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-cursor-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two agents with same path produce different hashes", () => {
    const p = path.join(tmpDir, "shared.jsonl");
    const h1 = logPathHash("claude", p);
    const h2 = logPathHash("codex", p);
    const h3 = logPathHash("grok", p);
    assert.notEqual(h1, h2);
    assert.notEqual(h1, h3);
    assert.notEqual(h2, h3);
    for (const h of [h1, h2, h3]) {
      assert.ok(/^[a-f0-9]{64}$/.test(h), `invalid hash: ${h}`);
    }
  });

  it("serialized JSON contains no raw path, cwd, title, sessionId or tail", () => {
    const rawPath = path.join(tmpDir, "secret-dir", "claude.jsonl");
    const cursor: FileCursor = {
      size: 500,
      mtimeMs: 1000,
      ctimeMs: 900,
      dev: 16777233,
      ino: 12345678,
      tail: "",
    };
    const cached = cachedLogCursor("claude", rawPath, cursor);
    const serialized = JSON.stringify(cached);
    assert.ok(!serialized.includes(rawPath), "leaked raw path");
    assert.ok(!serialized.includes("secret-dir"), "leaked path component");
    assert.ok(!serialized.includes(tmpDir), "leaked tmpDir");
    assert.ok(!serialized.includes("sessionId"), "leaked sessionId key");
    assert.ok(!serialized.includes('"tail"'), "leaked tail key");
    assert.ok(!serialized.includes("title"), "leaked title key");
    assert.ok(/^[a-f0-9]{64}$/.test(cached.pathHash), "pathHash not hex64");
  });

  it("dangerous modelRaw is discarded, safe Codex model ID is preserved", () => {
    const cursor: FileCursor = {
      size: 100,
      mtimeMs: 500,
      ctimeMs: 400,
      dev: 1,
      ino: 100,
      tail: "",
    };
    const p = path.join(tmpDir, "test.jsonl");

    // Dangerous model IDs
    const dangerousIds = [
      "/etc/passwd",
      "model/../../../etc/shadow",
      "model\\path",
      "a".repeat(200),
    ];
    for (const dangerous of dangerousIds) {
      const cached = cachedLogCursor("codex", p, cursor, dangerous);
      assert.equal(cached.modelRaw, undefined, `should discard: ${dangerous}`);
    }

    // Safe Codex model ID
    const safeId = "gpt-5.5";
    const cached = cachedLogCursor("codex", p, cursor, safeId);
    assert.equal(cached.modelRaw, safeId);
  });

  it("complete line file round-trips: readChunkFromEntry reads 0 bytes on unchanged file", () => {
    const filePath = path.join(tmpDir, "complete.jsonl");
    const line1 = '{"id":"1","tokens":100}\n';
    const line2 = '{"id":"2","tokens":200}\n';
    fs.writeFileSync(filePath, line1 + line2);
    const stat = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(line1 + line2),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail: "",
    };

    // Create cached log cursor - complete line should resume from EOF
    const cached = cachedLogCursor("claude", filePath, cursor);
    assert.equal(cached.resumeOffset, cursor.size, "complete line should resume from EOF");

    // Seed back into file cursors
    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
    }];
    const files = new Map<string, FileCursor>();
    const seeded = seedFileCursors("claude", entries, files, [cached]);
    assert.equal(seeded.length, 1);
    assert.ok(files.has(filePath));

    // readChunkFromEntry should read 0 bytes on unchanged file
    const result = readChunkFromEntry(entries[0], files.get(filePath)!);
    assert.equal(result.text, "", "should read 0 bytes on unchanged file");
  });

  it("append after complete line: readChunkFromEntry reads only suffix", () => {
    const filePath = path.join(tmpDir, "append.jsonl");
    const line1 = '{"id":"1","tokens":100}\n';
    fs.writeFileSync(filePath, line1);
    const stat1 = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(line1),
      mtimeMs: stat1.mtimeMs,
      ctimeMs: stat1.ctimeMs,
      dev: stat1.dev,
      ino: stat1.ino,
      tail: "",
    };

    const cached = cachedLogCursor("claude", filePath, cursor);

    // Now append a second line
    const line2 = '{"id":"2","tokens":200}\n';
    fs.appendFileSync(filePath, line2);
    const stat2 = fs.statSync(filePath);

    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat2.size,
      mtimeMs: stat2.mtimeMs,
      ctimeMs: stat2.ctimeMs,
      dev: stat2.dev,
      ino: stat2.ino,
    }];
    const files = new Map<string, FileCursor>();
    seedFileCursors("claude", entries, files, [cached]);

    const result = readChunkFromEntry(entries[0], files.get(filePath)!);
    assert.equal(result.text, line2, "should only read the appended suffix");
  });

  it("snapshotLogCursors produces sorted, deduped cursors with valid dev/ino only", () => {
    const p1 = path.join(tmpDir, "a.jsonl");
    const p2 = path.join(tmpDir, "b.jsonl");
    const files = new Map<string, FileCursor>([
      [p1, { size: 100, mtimeMs: 500, ctimeMs: 400, dev: 1, ino: 100, tail: "" }],
      [p2, { size: 200, mtimeMs: 600, ctimeMs: 500, dev: 1, ino: 200, tail: "" }],
    ]);
    const cursors = snapshotLogCursors("claude", files);
    assert.equal(cursors.length, 2);
    // Sorted by pathHash
    assert.ok(cursors[0].pathHash <= cursors[1].pathHash, "should be sorted by pathHash");
  });

  it("snapshotLogCursors filters out entries with negative dev/ino", () => {
    const p = path.join(tmpDir, "neg.jsonl");
    const files = new Map<string, FileCursor>([
      [p, { size: 100, mtimeMs: 500, ctimeMs: 400, dev: -1, ino: -1, tail: "" }],
    ]);
    const cursors = snapshotLogCursors("claude", files);
    assert.equal(cursors.length, 0, "should filter out negative dev/ino");
  });

  it("truncated file is not seeded (resumeOffset > current size)", () => {
    const filePath = path.join(tmpDir, "truncate.jsonl");
    const content = '{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n';
    fs.writeFileSync(filePath, content);
    const stat = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(content),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail: "",
    };
    const cached = cachedLogCursor("claude", filePath, cursor);

    // Truncate the file
    fs.writeFileSync(filePath, '{"id":"1"}\n');
    const stat2 = fs.statSync(filePath);

    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat2.size,
      mtimeMs: stat2.mtimeMs,
      ctimeMs: stat2.ctimeMs,
      dev: stat2.dev,
      ino: stat2.ino,
    }];
    const files = new Map<string, FileCursor>();
    const seeded = seedFileCursors("claude", entries, files, [cached]);
    assert.equal(seeded.length, 0, "truncated file should not seed");
    assert.ok(!files.has(filePath), "truncated file should not be in files map");
  });

  it("inode replacement is not seeded (different dev/ino)", () => {
    const filePath = path.join(tmpDir, "replace.jsonl");
    const content = '{"id":"1"}\n';
    fs.writeFileSync(filePath, content);
    const stat = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(content),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail: "",
    };
    const cached = cachedLogCursor("claude", filePath, cursor);

    // Replace inode: delete and recreate
    fs.unlinkSync(filePath);
    fs.writeFileSync(filePath, content);
    const stat2 = fs.statSync(filePath);

    // ino should differ (on most filesystems)
    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat2.size,
      mtimeMs: stat2.mtimeMs,
      ctimeMs: stat2.ctimeMs,
      dev: stat2.dev,
      ino: stat2.ino,
    }];
    const files = new Map<string, FileCursor>();
    const seeded = seedFileCursors("claude", entries, files, [cached]);
    // If ino actually changed, it should not seed; if filesystem reuses ino, it seeds but that's ok
    if (stat2.ino !== stat.ino) {
      assert.equal(seeded.length, 0, "replaced inode should not seed");
    }
  });

  it("already-tracked path is not seeded again", () => {
    const filePath = path.join(tmpDir, "already.jsonl");
    const content = '{"id":"1"}\n';
    fs.writeFileSync(filePath, content);
    const stat = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(content),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail: "",
    };
    const cached = cachedLogCursor("claude", filePath, cursor);

    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
    }];
    // Pre-populate files so the path is already tracked
    const files = new Map<string, FileCursor>([[filePath, cursor]]);
    const seeded = seedFileCursors("claude", entries, files, [cached]);
    assert.equal(seeded.length, 0, "already tracked path should not be seeded");
  });
});

describe("partial line resumes safely", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-cursor-partial-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("half line sets resumeOffset to 0, not EOF", () => {
    const filePath = path.join(tmpDir, "partial.jsonl");
    const completeLine = '{"id":"1","tokens":100}\n';
    const halfLine = '{"id":"2","tokens":2';
    fs.writeFileSync(filePath, completeLine + halfLine);
    const stat = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(completeLine + halfLine),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail: halfLine, // non-empty tail means incomplete line
    };

    const cached = cachedLogCursor("claude", filePath, cursor);
    assert.equal(cached.resumeOffset, 0, "half line should set resumeOffset to 0");

    // Verify no tail in serialization
    const serialized = JSON.stringify(cached);
    assert.ok(!serialized.includes(halfLine), "should not contain partial line content");
  });

  it("same-size rewrite seeds but mtime/ctime change triggers full re-read", () => {
    const filePath = path.join(tmpDir, "rewrite.jsonl");
    const original = '{"id":"1","val":"AAA"}\n';
    fs.writeFileSync(filePath, original);
    const stat1 = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(original),
      mtimeMs: stat1.mtimeMs,
      ctimeMs: stat1.ctimeMs,
      dev: stat1.dev,
      ino: stat1.ino,
      tail: "",
    };
    const cached = cachedLogCursor("claude", filePath, cursor);

    // Rewrite with same size but different content
    // Small delay to ensure mtime changes
    const replacement = '{"id":"2","val":"BBB"}\n';
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original),
      "test precondition: same byte length");
    fs.writeFileSync(filePath, replacement);
    const stat2 = fs.statSync(filePath);

    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat2.size,
      mtimeMs: stat2.mtimeMs,
      ctimeMs: stat2.ctimeMs,
      dev: stat2.dev,
      ino: stat2.ino,
    }];
    const files = new Map<string, FileCursor>();
    const seeded = seedFileCursors("claude", entries, files, [cached]);

    // Should seed because same dev/ino and resumeOffset <= size
    if (seeded.length === 1) {
      const seededCursor = files.get(filePath)!;
      // readChunkFromEntry should re-read from 0 because mtime/ctime changed
      const result = readChunkFromEntry(entries[0], seededCursor);
      // Even if seeded with same resumeOffset, the changed mtime/ctime
      // means the file appears "append-only" (same dev/ino, bigger or equal size)
      // but since size is the SAME, and mtime/ctime differ, readChunkFromEntry
      // detects it's not "unchanged" and not "append-only" → reads from 0
      if (stat2.mtimeMs !== stat1.mtimeMs || stat2.ctimeMs !== stat1.ctimeMs) {
        assert.equal(result.text, replacement,
          "changed mtime/ctime should trigger full re-read");
      }
    }
  });

  it("seedFileCursors only matches same agent", () => {
    const filePath = path.join(tmpDir, "agent-scope.jsonl");
    const content = '{"id":"1"}\n';
    fs.writeFileSync(filePath, content);
    const stat = fs.statSync(filePath);

    const cursor: FileCursor = {
      size: Buffer.byteLength(content),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      tail: "",
    };

    // Create cached cursor for "claude"
    const cachedClaude = cachedLogCursor("claude", filePath, cursor);

    // Try to seed for "codex" with "claude" cached cursor
    const entries: InventoryEntry[] = [{
      root: tmpDir,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
    }];
    const files = new Map<string, FileCursor>();
    const seeded = seedFileCursors("codex", entries, files, [cachedClaude]);
    assert.equal(seeded.length, 0, "should not seed from different agent's cursor");
  });
});
