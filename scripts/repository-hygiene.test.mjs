import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("bundled Claude demo data contains no local identity or absolute path", () => {
  const raw = read("src/data/claude-import.json");
  const rows = JSON.parse(raw);
  assert.ok(Array.isArray(rows) && rows.length > 0);
  assert.doesNotMatch(raw, /\/Users\/|\/Volumes\/|\/home\//);
  for (const row of rows) {
    assert.match(String(row.sessionId ?? ""), /^(?:demo-session|daily-summary-demo)-\d{3}$/);
    assert.match(String(row.task ?? ""), /^匿名 Claude 示例 · /);
  }
  const dailySummaries = rows.filter((row) =>
    String(row.sessionId ?? "").startsWith("daily-summary-demo-"),
  );
  assert.ok(dailySummaries.length > 0);
  assert.ok(dailySummaries.every((row) => String(row.sessionId).startsWith("daily-summary-")));
});

test("README documents local usage, verification, and real screenshots", () => {
  const readme = read("README.md");
  for (const required of [
    "npm install",
    "npm run dev",
    "npm test",
    "npm run typecheck",
    "npm run build",
    "screenshots/claude-grok-quota-desktop.png",
    "screenshots/claude-grok-quota-mobile.png",
    "不是现金余额",
  ]) {
    assert.ok(readme.includes(required), `README missing: ${required}`);
  }
  assert.ok(existsSync(join(root, "screenshots/claude-grok-quota-desktop.png")));
  assert.ok(existsSync(join(root, "screenshots/claude-grok-quota-mobile.png")));
});

test("macOS verification is one-command and documented", () => {
  const packageJson = JSON.parse(read("package.json"));
  for (const script of [
    "desktop:verify:security",
    "desktop:verify:app",
    "desktop:verify:crash",
    "desktop:verify:startup-error",
    "desktop:verify:dmg",
  ]) {
    assert.equal(typeof packageJson.scripts[script], "string", `missing npm script: ${script}`);
  }
  const verify = packageJson.scripts["desktop:verify"];
  assert.equal(typeof verify, "string", "missing npm script: desktop:verify");
  for (const script of ["security", "app", "crash", "startup-error", "dmg"]) {
    assert.ok(verify.includes(`desktop:verify:${script}`), `desktop:verify omits ${script}`);
  }

  const readme = read("README.md");
  for (const required of [
    "npm run desktop:verify",
    "Accessibility",
    "SIGKILL",
    "startup-error",
    "hdiutil verify",
  ]) {
    assert.ok(readme.includes(required), `README missing desktop verification detail: ${required}`);
  }
});

test("private local artifacts are ignored", () => {
  const ignore = read(".gitignore").split(/\r?\n/);
  for (const entry of [
    ".vercel/",
    ".playwright-mcp/",
    "claude-quota-report.md",
    "synq-claude-import.json",
    "screenshots/claude-grok-quota-production.png",
  ]) {
    assert.ok(ignore.includes(entry), `.gitignore missing: ${entry}`);
  }
});
