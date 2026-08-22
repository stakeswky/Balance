import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scanClaudeUsage, createScanState, type ScanState } from "./claude-log.server.ts";
import type { CachedLogCursor } from "./quota-cache.ts";

function claudeJsonlLine(
  ts: number,
  index: number,
  model = "claude-sonnet-4-20250514",
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts + index * 1000).toISOString(),
    requestId: `req-${index}`,
    message: {
      id: `msg-${index}`,
      model,
      usage: {
        input_tokens: 100 + index,
        output_tokens: 50 + index,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function setupClaudeHome(tmpDir: string): {
  home: string;
  projectDir: string;
  sessionPath: string;
} {
  const home = tmpDir;
  const projectDir = path.join(home, ".claude", "projects", "test-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionPath = path.join(projectDir, "session-001.jsonl");
  return { home, projectDir, sessionPath };
}

describe("resumes hashed file cursors (Claude)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cursor-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first scan returns quotaCacheCursors, warm restart reads zero bytes for unchanged file", () => {
    const { home, sessionPath } = setupClaudeHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    // Build 1724 complete lines
    const lines: string[] = [];
    for (let i = 0; i < 1724; i++) {
      lines.push(claudeJsonlLine(baseTs, i));
    }
    fs.writeFileSync(sessionPath, lines.map((l) => l + "\n").join(""));

    // First full scan
    const state1 = createScanState();
    const result1 = scanClaudeUsage(baseTs - 1, {
      home,
      now,
      state: state1,
    });

    assert.ok(result1.events.length > 0, "first scan should yield events");
    assert.ok(result1.filesRead > 0, "first scan should read files");
    assert.ok(
      Array.isArray(result1.quotaCacheCursors),
      "result must include quotaCacheCursors",
    );
    assert.ok(result1.quotaCacheCursors.length > 0, "should produce cursors");

    // Simulate process restart: fresh state + resume cursors
    const state2 = createScanState();
    const result2 = scanClaudeUsage(baseTs - 1, {
      home,
      now,
      state: state2,
      resumeCursors: result1.quotaCacheCursors,
    });

    assert.equal(
      result2.filesRead,
      0,
      "warm restart of unchanged file should read zero bytes",
    );
    assert.ok(
      Array.isArray(result2.quotaCacheCursors),
      "warm restart must still return cursors",
    );
  });

  it("append after warm restart reads only suffix", () => {
    const { home, sessionPath } = setupClaudeHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    // Initial content
    const initialLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      initialLines.push(claudeJsonlLine(baseTs, i));
    }
    fs.writeFileSync(sessionPath, initialLines.map((l) => l + "\n").join(""));

    // First full scan
    const state1 = createScanState();
    const result1 = scanClaudeUsage(baseTs - 1, {
      home,
      now,
      state: state1,
    });
    const cursors = result1.quotaCacheCursors;
    assert.ok(cursors.length > 0);

    // Append new content
    const appendLines: string[] = [];
    for (let i = 100; i < 110; i++) {
      appendLines.push(claudeJsonlLine(baseTs, i));
    }
    fs.appendFileSync(sessionPath, appendLines.map((l) => l + "\n").join(""));

    // Warm restart with fresh state + cursors
    const state2 = createScanState();
    const result2 = scanClaudeUsage(baseTs - 1, {
      home,
      now: now + 20_000,
      state: state2,
      resumeCursors: cursors,
    });

    assert.equal(result2.filesRead, 1, "should read only the appended file");
    // Should get ~10 new events from the suffix
    assert.ok(result2.events.length >= 10, `expected >=10 events from suffix, got ${result2.events.length}`);
  });

  it("truncated file does full re-read, not partial", () => {
    const { home, sessionPath } = setupClaudeHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(claudeJsonlLine(baseTs, i));
    }
    fs.writeFileSync(sessionPath, lines.map((l) => l + "\n").join(""));

    // First scan
    const state1 = createScanState();
    const result1 = scanClaudeUsage(baseTs - 1, {
      home,
      now,
      state: state1,
    });
    const cursors = result1.quotaCacheCursors;

    // Truncate file (smaller content)
    fs.writeFileSync(sessionPath, claudeJsonlLine(baseTs, 0) + "\n");

    // Warm restart: cursor's resumeOffset > new size, so seedFileCursors skips → full read
    const state2 = createScanState();
    const result2 = scanClaudeUsage(baseTs - 1, {
      home,
      now: now + 20_000,
      state: state2,
      resumeCursors: cursors,
    });

    assert.equal(result2.filesRead, 1, "truncated file should be fully re-read");
  });
});

describe("persists scanner cursors (Claude)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-persist-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("quotaCacheCursors never leaks raw path or tail", () => {
    const { home, sessionPath } = setupClaudeHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    fs.writeFileSync(
      sessionPath,
      claudeJsonlLine(baseTs, 0) + "\n" + claudeJsonlLine(baseTs, 1) + "\n",
    );

    const state = createScanState();
    const result = scanClaudeUsage(baseTs - 1, { home, now, state });

    for (const cursor of result.quotaCacheCursors) {
      const serialized = JSON.stringify(cursor);
      assert.ok(!serialized.includes(sessionPath), "leaked raw path");
      assert.ok(!serialized.includes(tmpDir), "leaked tmpDir");
      assert.ok(!serialized.includes('"tail"'), "leaked tail field");
      assert.ok(/^[a-f0-9]{64}$/.test(cursor.pathHash), "pathHash must be hex64");
      assert.equal(cursor.agent, "claude");
    }
  });
});
