import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  scanCodexUsage,
  createCodexScanState,
  type CodexScanState,
} from "./codex-log.server.ts";
import type { CachedLogCursor } from "./quota-cache.ts";

function codexTurnContextLine(model: string): string {
  return JSON.stringify({
    type: "turn_context",
    payload: { model, cwd: "/tmp/test" },
  });
}

function codexTokenCountLine(ts: number, index: number): string {
  return JSON.stringify({
    type: "token_count",
    timestamp: new Date(ts + index * 1000).toISOString(),
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 200 + index,
          output_tokens: 80 + index,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
        },
      },
    },
  });
}

function setupCodexHome(tmpDir: string): {
  home: string;
  sessionsDir: string;
  sessionPath: string;
} {
  const home = tmpDir;
  const sessionsDir = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionPath = path.join(
    sessionsDir,
    "rollout-00000000-0000-0000-0000-000000000001.jsonl",
  );
  return { home, sessionsDir, sessionPath };
}

describe("resumes hashed file cursors (Codex)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cursor-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first scan returns cursors, warm restart reads zero bytes, model meta preserved", () => {
    const { home, sessionPath } = setupCodexHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    // Build fixture: turn_context sets model, then 1724 token_count lines
    const lines: string[] = [codexTurnContextLine("gpt-5.4-mini")];
    for (let i = 0; i < 1724; i++) {
      lines.push(codexTokenCountLine(baseTs, i));
    }
    fs.writeFileSync(sessionPath, lines.map((l) => l + "\n").join(""));

    // First full scan
    const state1 = createCodexScanState();
    const result1 = scanCodexUsage(baseTs - 1, {
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

    // Verify cursor carries model metadata
    const cursorWithModel = result1.quotaCacheCursors.find(
      (c) => c.modelRaw != null,
    );
    assert.ok(cursorWithModel, "at least one cursor should carry modelRaw");
    assert.equal(cursorWithModel!.modelRaw, "gpt-5.4-mini");

    // Simulate warm restart: fresh state + resume cursors
    const state2 = createCodexScanState();
    const result2 = scanCodexUsage(baseTs - 1, {
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

    // Append a new token_count line after warm restart
    const appendLine =
      codexTokenCountLine(baseTs, 2000) + "\n";
    fs.appendFileSync(sessionPath, appendLine);

    const result3 = scanCodexUsage(baseTs - 1, {
      home,
      now: now + 20_000,
      state: state2,
    });

    assert.equal(result3.filesRead, 1, "append should trigger read");
    // The appended token_count should use the cached model (gpt-5.4-mini), not the default
    const appendedEvent = result3.events.find(
      (e) => e.ts >= baseTs + 2000 * 1000,
    );
    assert.ok(appendedEvent, "should find appended event");
    assert.equal(
      appendedEvent!.modelRaw,
      "gpt-5.4-mini",
      "resumed model should come from cached cursor, not default flagship",
    );
  });

  it("inode replacement does full re-read", () => {
    const { home, sessionPath } = setupCodexHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    const lines = [codexTurnContextLine("gpt-5.5")];
    for (let i = 0; i < 20; i++) {
      lines.push(codexTokenCountLine(baseTs, i));
    }
    fs.writeFileSync(sessionPath, lines.map((l) => l + "\n").join(""));

    const state1 = createCodexScanState();
    const result1 = scanCodexUsage(baseTs - 1, { home, now, state: state1 });
    const cursors = result1.quotaCacheCursors;

    // Replace inode: delete and recreate with different content
    fs.unlinkSync(sessionPath);
    const newLines = [codexTurnContextLine("gpt-5.4-mini")];
    for (let i = 0; i < 20; i++) {
      newLines.push(codexTokenCountLine(baseTs, i + 100));
    }
    fs.writeFileSync(sessionPath, newLines.map((l) => l + "\n").join(""));

    const state2 = createCodexScanState();
    const result2 = scanCodexUsage(baseTs - 1, {
      home,
      now: now + 20_000,
      state: state2,
      resumeCursors: cursors,
    });

    const stat = fs.statSync(sessionPath);
    // If ino actually changed, should do full read (not seeded)
    if (stat.ino !== cursors[0]?.ino) {
      assert.equal(result2.filesRead, 1, "replaced inode should do full re-read");
    }
  });
});

describe("persists scanner cursors (Codex)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-persist-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("quotaCacheCursors never leaks raw path", () => {
    const { home, sessionPath } = setupCodexHome(tmpDir);
    const now = Date.now();
    const baseTs = now - 3600_000;

    fs.writeFileSync(
      sessionPath,
      [codexTurnContextLine("gpt-5.5"), codexTokenCountLine(baseTs, 0)]
        .map((l) => l + "\n")
        .join(""),
    );

    const state = createCodexScanState();
    const result = scanCodexUsage(baseTs - 1, { home, now, state });

    for (const cursor of result.quotaCacheCursors) {
      const serialized = JSON.stringify(cursor);
      assert.ok(!serialized.includes(sessionPath), "leaked raw path");
      assert.ok(!serialized.includes(tmpDir), "leaked tmpDir");
      assert.ok(!serialized.includes('"tail"'), "leaked tail");
      assert.equal(cursor.agent, "codex");
    }
  });
});
