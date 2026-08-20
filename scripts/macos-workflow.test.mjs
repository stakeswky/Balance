import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/macos-arm64.yml", import.meta.url);

test("macOS workflow builds, verifies, and uploads both bundles", async () => {
  const yaml = await readFile(workflowUrl, "utf8");
  assert.match(yaml, /runs-on: macos-26/);
  assert.match(yaml, /node-version: 22/);
  assert.match(yaml, /aarch64-apple-darwin/);
  assert.match(yaml, /npm test/);
  assert.match(yaml, /npm run typecheck/);
  assert.match(yaml, /npm run desktop:prepare/);
  assert.match(yaml, /npm run desktop:test/);
  assert.match(yaml, /npm run desktop:build/);
  assert.match(yaml, /codesign --verify --deep --strict/);
  assert.match(yaml, /Synq-macos-arm64\.app\.zip/);
  assert.match(yaml, /bundle\/dmg\/\*\.dmg/);
  assert.ok(
    yaml.indexOf("npm run desktop:prepare") <
      yaml.indexOf("npm run desktop:test"),
    "clean CI must generate externalBin and resources before cargo test",
  );
});
