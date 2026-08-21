import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MANIFEST_URL,
  isAllowedInstallerUrl,
  isAllowedUpdateUrl,
  parseUpdateManifest,
} from "./manifest.ts";

const valid = {
  schemaVersion: 1,
  app: "balance",
  packVersion: "0.1.1",
  minNativeVersion: "0.1.1",
  nativeVersion: "0.1.1",
  gitSha: "deadbeef",
  publishedAt: "2026-08-21T00:00:00Z",
  hot: {
    url: "https://github.com/stakeswky/Balance/releases/download/latest/balance-server.zip",
    sha256: "ab".repeat(32),
    size: 100,
  },
  installer: { url: "https://github.com/stakeswky/Balance/releases/latest" },
};

test("parses a valid GitHub latest manifest", () => {
  const parsed = parseUpdateManifest(JSON.stringify(valid));
  assert.equal(parsed.packVersion, "0.1.1");
  assert.equal(parsed.hot.sha256, "ab".repeat(32));
});

test("rejects other apps, hosts, and truncated hashes", () => {
  assert.throws(() => parseUpdateManifest(JSON.stringify({ ...valid, app: "synq" })));
  assert.throws(() =>
    parseUpdateManifest(
      JSON.stringify({
        ...valid,
        hot: { ...valid.hot, url: "https://evil.example/pack.zip" },
      }),
    ),
  );
  assert.throws(() =>
    parseUpdateManifest(
      JSON.stringify({
        ...valid,
        hot: { ...valid.hot, sha256: "abc" },
      }),
    ),
  );
});

test("allowlist accepts only Balance GitHub release downloads", () => {
  assert.equal(isAllowedUpdateUrl(valid.hot.url), true);
  assert.equal(
    isAllowedUpdateUrl(
      "https://github.com/stakeswky/Balance/releases/latest/download/update-manifest.json",
    ),
    true,
  );
  assert.equal(isAllowedUpdateUrl("http://github.com/stakeswky/Balance/releases/download/latest/x"), false);
  assert.equal(isAllowedUpdateUrl("https://github.com/stakeswky/synq/releases/download/latest/x"), false);
  assert.equal(isAllowedUpdateUrl("file:///tmp/pack.zip"), false);
  assert.equal(
    DEFAULT_MANIFEST_URL,
    "https://github.com/stakeswky/Balance/releases/latest/download/update-manifest.json",
  );
});

test("installer allowlist accepts the GitHub latest page but not file: or other repos", () => {
  assert.equal(isAllowedInstallerUrl("https://github.com/stakeswky/Balance/releases/latest"), true);
  assert.equal(isAllowedInstallerUrl(valid.hot.url), true);
  assert.equal(isAllowedInstallerUrl("file:///tmp/pack.zip"), false);
  assert.equal(isAllowedInstallerUrl("https://github.com/stakeswky/synq/releases/latest"), false);
});
