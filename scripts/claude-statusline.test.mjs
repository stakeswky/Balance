import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultStatuslinePath, sanitizeRateLimits } from "./balance-claude-statusline.mjs";

const COLLECTOR = new URL("./balance-claude-statusline.mjs", import.meta.url);

function runCollector(input, snapshotPath) {
  return spawnSync(process.execPath, [COLLECTOR.pathname], {
    input,
    encoding: "utf8",
    env: { ...process.env, BALANCE_CLAUDE_STATUSLINE_PATH: snapshotPath },
  });
}

const STDIN_FIXTURE = JSON.stringify({
  cwd: "/Users/someone/private-project",
  session_id: "sess-private",
  transcript_path: "/Users/someone/.claude/transcript.jsonl",
  model: { id: "claude-fable-5" },
  rate_limits: {
    five_hour: {
      used_percentage: 12.5,
      resets_at: "2026-08-21T15:00:00Z",
      surprise_nested: { access_token: "leak-me" },
    },
    seven_day: { used_percentage: 34.25, resets_at: 1787305600 },
    unknown_window: { used_percentage: 1, resets_at: 1787305600 },
  },
});

test("collector persists only whitelisted quota numbers and prints the statusline", () => {
  const dir = mkdtempSync(join(tmpdir(), "balance-statusline-collector-"));
  const snapshotPath = join(dir, "state", "claude-statusline.json");
  const result = runCollector(STDIN_FIXTURE, snapshotPath);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "Balance 5h 12.5% · 7d 34.25%");
  const rawSnapshot = readFileSync(snapshotPath, "utf8");
  for (const leaked of [
    "cwd",
    "private",
    "session",
    "transcript",
    "token",
    "surprise",
    "unknown_window",
    "model",
  ]) {
    assert.equal(rawSnapshot.includes(leaked), false, leaked);
  }
  const stored = JSON.parse(rawSnapshot);
  assert.deepEqual(Object.keys(stored).sort(), ["fetchedAt", "rate_limits"]);
  assert.deepEqual(stored.rate_limits, {
    five_hour: { used_percentage: 12.5, resets_at: Date.parse("2026-08-21T15:00:00Z") },
    seven_day: { used_percentage: 34.25, resets_at: 1_787_305_600_000 },
  });
  assert.ok(Number.isSafeInteger(stored.fetchedAt));
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700);
    assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(join(dir, "state")).filter((name) => name.endsWith(".tmp")), []);
});

test("collector fails open on oversized, malformed, and unwritable input", () => {
  const dir = mkdtempSync(join(tmpdir(), "balance-statusline-badinput-"));
  const snapshotPath = join(dir, "claude-statusline.json");
  const oversized = runCollector(
    `{"rate_limits":{"pad":"${"x".repeat(1024 * 1024)}"}}`,
    snapshotPath,
  );
  assert.equal(oversized.status, 0);
  assert.equal(oversized.stdout, "Balance");
  assert.equal(existsSync(snapshotPath), false);
  const malformed = runCollector("not json", snapshotPath);
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "Balance");
  assert.equal(existsSync(snapshotPath), false);
  const blockerFile = join(dir, "blocking-file");
  writeFileSync(blockerFile, "not a directory");
  const unwritable = runCollector(STDIN_FIXTURE, join(blockerFile, "claude-statusline.json"));
  assert.equal(unwritable.status, 0);
  assert.equal(unwritable.stdout, "Balance 5h 12.5% · 7d 34.25%");
});

test("collector default snapshot paths cover darwin, win32, and linux", () => {
  assert.equal(
    defaultStatuslinePath("darwin", {}, "/Users/u"),
    join("/Users/u", "Library", "Application Support", "Balance", "claude-statusline.json"),
  );
  assert.equal(
    defaultStatuslinePath("win32", { LOCALAPPDATA: "/tmp/local-app-data" }, "/Users/u"),
    join("/tmp/local-app-data", "Balance", "claude-statusline.json"),
  );
  assert.equal(
    defaultStatuslinePath("win32", { LOCALAPPDATA: "" }, "/Users/u"),
    join("/Users/u", "AppData", "Local", "Balance", "claude-statusline.json"),
  );
  assert.equal(
    defaultStatuslinePath("linux", { XDG_STATE_HOME: "/tmp/xdg-state" }, "/home/u"),
    join("/tmp/xdg-state", "balance", "claude-statusline.json"),
  );
  assert.equal(
    defaultStatuslinePath("linux", { XDG_STATE_HOME: " " }, "/home/u"),
    join("/home/u", ".local", "state", "balance", "claude-statusline.json"),
  );
});

test("sanitizeRateLimits drops unknown keys and out-of-range values", () => {
  assert.deepEqual(
    sanitizeRateLimits({
      five_hour: { used_percentage: 12.5, resets_at: "2026-08-21T15:00:00Z", extra: "x" },
      seven_day: { utilization: 34.25, resets_at: 1_787_305_600_000 },
      other: { used_percentage: 1, resets_at: 1787305600 },
    }),
    {
      five_hour: { used_percentage: 12.5, resets_at: Date.parse("2026-08-21T15:00:00Z") },
      seven_day: { used_percentage: 34.25, resets_at: 1_787_305_600_000 },
    },
  );
  assert.equal(
    sanitizeRateLimits({ five_hour: { used_percentage: 101, resets_at: 1787305600 } }),
    null,
  );
  assert.equal(
    sanitizeRateLimits({ five_hour: { used_percentage: 12.5, resets_at: "2019-12-31T00:00:00Z" } }),
    null,
  );
  assert.equal(
    sanitizeRateLimits({ five_hour: { used_percentage: Number.NaN, resets_at: 1787305600 } }),
    null,
  );
  assert.equal(sanitizeRateLimits([]), null);
});
