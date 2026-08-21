import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");
const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);

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
    "desktop:verify:ci",
  ]) {
    assert.equal(typeof packageJson.scripts[script], "string", `missing npm script: ${script}`);
  }
  assert.ok(
    packageJson.scripts["desktop:verify:security"].includes("verify-macos-env-isolation.sh"),
    "desktop:verify:security omits packaged environment isolation",
  );
  assert.ok(
    packageJson.scripts["desktop:verify:security"].includes("verify-desktop-security.mjs"),
    "desktop:verify:security omits live Host/Fetch-Metadata verification",
  );
  const ciVerify = packageJson.scripts["desktop:verify:ci"];
  for (const script of ["security", "crash", "dmg"]) {
    assert.ok(ciVerify.includes(`desktop:verify:${script}`), `desktop:verify:ci omits ${script}`);
  }
  const verify = packageJson.scripts["desktop:verify"];
  assert.equal(typeof verify, "string", "missing npm script: desktop:verify");
  for (const script of ["security", "app", "crash", "startup-error", "dmg"]) {
    assert.ok(verify.includes(`desktop:verify:${script}`), `desktop:verify omits ${script}`);
  }

  const macosDoc = read("docs/macos-desktop.md");
  for (const required of [
    "npm run desktop:verify",
    "Accessibility",
    "SIGKILL",
    "startup-error",
    "hdiutil verify",
  ]) {
    assert.ok(macosDoc.includes(required), `macOS doc missing desktop verification detail: ${required}`);
  }
});

test("README stays user-facing and omits maintainer verification", () => {
  const readme = read("README.md");
  for (const forbidden of [
    "Accessibility",
    "SIGKILL",
    "startup-error",
    "hdiutil verify",
    "npm run desktop:verify",
    "L1：",
    "L2：",
    "L3：",
  ]) {
    assert.ok(!readme.includes(forbidden), `README should not include: ${forbidden}`);
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

test("gitignore keeps App Builder and local-only paths out of git", () => {
  const ignore = read(".gitignore").split(/\r?\n/);
  for (const entry of [
    ".grok/",
    "AGENTS.md",
    "startup.sh",
    ".node_modules.lock",
    "docs/plans/",
    "docs/designs/",
    "docs/research/",
    "playwright-onboarding-snapshot.md",
    "screenshots/*",
    "!screenshots/.gitkeep",
    "!screenshots/claude-grok-quota-desktop.png",
    "!screenshots/claude-grok-quota-mobile.png",
  ]) {
    assert.ok(ignore.includes(entry), `.gitignore missing: ${entry}`);
  }
});

test("git does not track App Builder, plans, or extra screenshots", () => {
  const files = tracked();
  for (const prefix of [
    ".grok/",
    "AGENTS.md",
    "startup.sh",
    ".node_modules.lock",
    "docs/plans/",
    "docs/designs/",
    "docs/research/",
    "playwright-onboarding-snapshot.md",
  ]) {
    assert.equal(
      files.filter((file) => file === prefix || file.startsWith(prefix)).length,
      0,
      `tracked unrelated path: ${prefix}`,
    );
  }
  assert.deepEqual(files.filter((file) => file.startsWith("screenshots/")).sort(), [
    "screenshots/.gitkeep",
    "screenshots/claude-grok-quota-desktop.png",
    "screenshots/claude-grok-quota-mobile.png",
  ]);
});

test("repository is MIT licensed", () => {
  const license = read("LICENSE");
  assert.match(license, /^MIT License/m);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.equal(JSON.parse(read("package.json")).license, "MIT");
  assert.match(read("README.md"), /\[MIT\]\(\.\/LICENSE\)/);
});

test("App Builder PWA, preview bridge, and unused multiplayer are gone", () => {
  const files = tracked();
  for (const prefix of [
    "public/__grok/",
    "scripts/grok-pwa-plugin.mjs",
    "scripts/grok-pwa-plugin.test.mjs",
    "scripts/grok-pwa-shared.mjs",
    "scripts/grok-pwa-shared.d.mts",
    "scripts/install-page.html",
    "server/",
    "src/components/preview-host-bridge.tsx",
    "src/lib/preview-host-bridge.ts",
    "src/lib/preview-embedder-origin.ts",
    "src/lib/multiplayer/",
  ]) {
    assert.equal(
      files.filter((file) => file === prefix || file.startsWith(prefix)).length,
      0,
      `tracked App Builder path: ${prefix}`,
    );
    const diskPath = join(root, prefix.replace(/\/$/, ""));
    assert.equal(existsSync(diskPath), false, `still on disk: ${prefix}`);
  }

  const rootRoute = read("src/routes/__root.tsx");
  assert.doesNotMatch(rootRoute, /PreviewHostBridge/);
  assert.doesNotMatch(rootRoute, /\/__grok\//);

  const viteConfig = read("vite.config.ts");
  assert.doesNotMatch(viteConfig, /grokPwaPlugin/);
  assert.doesNotMatch(viteConfig, /serverDir/);
});
