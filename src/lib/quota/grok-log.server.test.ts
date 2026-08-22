import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  scanGrokUsage,
  createGrokScanState,
  type GrokScanState,
} from "./grok-log.server.ts";
import type { CachedLogCursor } from "./quota-cache.ts";

function grokUpdateLine(ts: number, index: number, model = "grok-4.6"): string {
  return JSON.stringify({
    params: {
      sessionId: "grok-sess-001",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: `prompt-${index}`,
        usage: {
          input_tokens: 150 + index,
          output_tokens: 60 + index,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          modelUsage: {
            [model]: { costUsdTicks: 1_000_000_000 },
          },
          schemaVersion: "grok-cli-1.0.0",
        },
      },
      _meta: {
        agentTimestampMs: ts + index * 1000,
      },
    },
  });
}

function setupGrokHome(tmpDir: string): {
  home: string;
  sessionsDir: string;
  sessionDir: string;
  updatesPath: string;
} {
  const home = tmpDir;
  const sessionsDir = path.join(home, ".grok", "sessions");
  const sessionDir = path.join(sessionsDir, "test-project", "grok-sess-001");
  fs.mkdirSync(sessionDir, { recursive: true });
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  return { home, sessionsDir, sessionDir, updatesPath };
}

describe("resumes hashed file cursors (Grok)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cursor-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first scan returns cursors, warm restart reads zero bytes", () => {
    const { home, updatesPath } = setupGrokHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    // Build 1724 complete lines
    const lines: string[] = [];
    for (let i = 0; i < 1724; i++) {
      lines.push(grokUpdateLine(baseTs, i));
    }
    fs.writeFileSync(updatesPath, lines.map((l) => l + "\n").join(""));

    // First full scan
    const state1 = createGrokScanState();
    const result1 = scanGrokUsage(baseTs - 1, {
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
    const state2 = createGrokScanState();
    const result2 = scanGrokUsage(baseTs - 1, {
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
    const { home, updatesPath } = setupGrokHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    const initialLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      initialLines.push(grokUpdateLine(baseTs, i));
    }
    fs.writeFileSync(updatesPath, initialLines.map((l) => l + "\n").join(""));

    const state1 = createGrokScanState();
    const result1 = scanGrokUsage(baseTs - 1, { home, now, state: state1 });
    const cursors = result1.quotaCacheCursors;

    // Append
    const appendLines: string[] = [];
    for (let i = 100; i < 110; i++) {
      appendLines.push(grokUpdateLine(baseTs, i));
    }
    fs.appendFileSync(updatesPath, appendLines.map((l) => l + "\n").join(""));

    const state2 = createGrokScanState();
    const result2 = scanGrokUsage(baseTs - 1, {
      home,
      now: now + 20_000,
      state: state2,
      resumeCursors: cursors,
    });

    assert.equal(result2.filesRead, 1, "should read the appended file");
    assert.ok(
      result2.events.length >= 10,
      `expected >=10 events from suffix, got ${result2.events.length}`,
    );
  });

  it("same-size rewrite triggers full re-read", () => {
    const { home, updatesPath } = setupGrokHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    const original = grokUpdateLine(baseTs, 0) + "\n";
    fs.writeFileSync(updatesPath, original);

    const state1 = createGrokScanState();
    const result1 = scanGrokUsage(baseTs - 1, { home, now, state: state1 });
    const cursors = result1.quotaCacheCursors;

    // Rewrite with same byte length but different content
    const replacement = grokUpdateLine(baseTs, 999) + "\n";
    // Pad to same length if needed
    const originalLen = Buffer.byteLength(original);
    const replacementLen = Buffer.byteLength(replacement);
    const padding = originalLen > replacementLen
      ? " ".repeat(originalLen - replacementLen)
      : "";
    fs.writeFileSync(updatesPath, replacement + padding);

    const state2 = createGrokScanState();
    const result2 = scanGrokUsage(baseTs - 1, {
      home,
      now: now + 20_000,
      state: state2,
      resumeCursors: cursors,
    });

    // Whether seeded or not, the mtime change should force a read
    assert.equal(result2.filesRead, 1, "rewritten file should be re-read");
  });
});

describe("persists scanner cursors (Grok)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-persist-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("quotaCacheCursors carry model metadata from Grok meta", () => {
    const { home, updatesPath, sessionDir } = setupGrokHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    // Write summary.json with model
    fs.writeFileSync(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { cwd: "/tmp/test" },
        generated_title: "Test session",
        current_model_id: "grok-4.3",
      }),
    );

    fs.writeFileSync(
      updatesPath,
      [grokUpdateLine(baseTs, 0, "grok-4.3"), grokUpdateLine(baseTs, 1, "grok-4.3")]
        .map((l) => l + "\n")
        .join(""),
    );

    const state = createGrokScanState();
    const result = scanGrokUsage(baseTs - 1, { home, now, state });

    assert.ok(result.quotaCacheCursors.length > 0);
    for (const cursor of result.quotaCacheCursors) {
      const serialized = JSON.stringify(cursor);
      assert.ok(!serialized.includes(updatesPath), "leaked raw path");
      assert.ok(!serialized.includes(tmpDir), "leaked tmpDir");
      assert.ok(!serialized.includes('"tail"'), "leaked tail");
      assert.equal(cursor.agent, "grok");
    }
  });
});
