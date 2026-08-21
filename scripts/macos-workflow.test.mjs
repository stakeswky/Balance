import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/macos-arm64.yml", import.meta.url);

test("macOS workflow builds, verifies, and uploads both bundles", async () => {
  const yaml = await readFile(workflowUrl, "utf8");
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /branches:\n\s+- main/);
  assert.match(yaml, /tags:\n\s+- "app-v\*"/);
  assert.match(yaml, /runs-on: macos-26/);
  assert.match(yaml, /node-version: 22\.23\.2/);
  assert.match(yaml, /toolchain: 1\.88\.0/);
  assert.match(yaml, /aarch64-apple-darwin/);
  assert.match(yaml, /npm test/);
  assert.match(yaml, /npm run typecheck/);
  assert.match(yaml, /npm run desktop:prepare/);
  assert.match(yaml, /npm run desktop:test/);
  assert.match(yaml, /npm run desktop:build/);
  assert.match(yaml, /npm run desktop:verify:ci/);
  assert.match(yaml, /codesign --verify --deep --strict/);
  assert.match(yaml, /Mach-O 64-bit executable arm64/);
  assert.match(yaml, /Balance-macos-arm64\.app\.zip/);
  assert.match(yaml, /bundle\/dmg\/\*\.dmg/);
  assert.ok(
    yaml.indexOf("npm run desktop:prepare") < yaml.indexOf("npm run desktop:test"),
    "clean CI must generate externalBin and resources before cargo test",
  );
});

test("package-lock nests babel lru-cache so npm ci does not look for v11", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(lock.packages["node_modules/@babel/helper-compilation-targets/node_modules/lru-cache"]);
  assert.equal(lock.packages["node_modules/lru-cache"], undefined);
});

test("macOS workflow pins every action to an immutable commit", async () => {
  const yaml = await readFile(workflowUrl, "utf8");
  const expected = [
    "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
    "dtolnay/rust-toolchain@6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772",
    "Swatinem/rust-cache@49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c # v2",
    "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
  ];
  for (const action of expected) assert.ok(yaml.includes(`uses: ${action}`), action);

  const uses = [...yaml.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.equal(uses.length, expected.length);
  for (const action of uses) {
    assert.match(action, /@[0-9a-f]{40}$/, `${action} must use a full commit SHA`);
  }
});
