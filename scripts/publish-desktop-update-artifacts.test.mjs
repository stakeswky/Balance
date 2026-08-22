import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseUpdateManifest } from "../src/lib/desktop-update/manifest.ts";
import { publishDesktopUpdateArtifacts } from "./publish-desktop-update-artifacts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("sidecar zip roots pack.json, server entry, and public without wrapping .output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "balance-hot-artifacts-"));
  const outputDir = join(workspace, ".output");
  const artifactsDir = join(workspace, "artifacts");
  const updaterBundlePath = join(workspace, "Balance.app.tar.gz");
  const updaterSignaturePath = `${updaterBundlePath}.sig`;
  mkdirSync(join(outputDir, "server"), { recursive: true });
  mkdirSync(join(outputDir, "public"), { recursive: true });
  writeFileSync(join(outputDir, "server", "index.mjs"), "export {}\n");
  writeFileSync(join(outputDir, "public", ".keep"), "");
  writeFileSync(
    join(outputDir, "pack.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        app: "balance",
        packVersion: "0.1.1",
        minNativeVersion: "0.1.1",
        nativeVersion: "0.1.1",
        gitSha: "abc1234deadbeef",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(updaterBundlePath, "signed updater bytes");
  writeFileSync(updaterSignaturePath, "trusted updater signature\n");

  const published = await publishDesktopUpdateArtifacts({
    outputDir,
    artifactsDir,
    tag: "latest",
    gitSha: "abc1234deadbeef",
    publishedAt: "2026-08-21T00:00:00.000Z",
    updaterBundlePath,
    updaterSignaturePath,
  });

  const names = execFileSync("/usr/bin/zipinfo", ["-1", published.zipPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(names.includes("pack.json"), names.join("\n"));
  assert.ok(names.includes("server/index.mjs"), names.join("\n"));
  assert.ok(names.some((name) => name === "public/" || name.startsWith("public/")), names.join("\n"));
  assert.equal(names.some((name) => name.includes(".output")), false);

  const manifest = parseUpdateManifest(readFileSync(published.manifestPath, "utf8"));
  assert.equal(manifest.packVersion, "0.1.1");
  assert.equal(manifest.minNativeVersion, "0.1.1");
  assert.equal(manifest.hot.sha256, published.sha256);
  assert.equal(
    manifest.hot.url,
    "https://github.com/stakeswky/Balance/releases/download/latest/balance-server.zip",
  );
  assert.equal(manifest.installer.url, "https://github.com/stakeswky/Balance/releases/latest");

  const latest = JSON.parse(readFileSync(published.latestPath, "utf8"));
  assert.equal(latest.version, "0.1.1");
  assert.equal(latest.pub_date, "2026-08-21T00:00:00.000Z");
  assert.deepEqual(latest.platforms["darwin-aarch64"], {
    signature: "trusted updater signature",
    url: "https://github.com/stakeswky/Balance/releases/download/latest/Balance.app.tar.gz",
  });
  assert.deepEqual(published.latest, latest);

  rmSync(workspace, { recursive: true, force: true });
});

test("macOS workflow publishes sidecar zip before uploading artifacts", async () => {
  const yaml = readFileSync(join(root, ".github/workflows/macos-arm64.yml"), "utf8");
  assert.match(yaml, /node scripts\/publish-desktop-update-artifacts\.mjs/);
  assert.match(yaml, /artifacts\/balance-server\.zip/);
  assert.match(yaml, /artifacts\/update-manifest\.json/);
  assert.ok(
    yaml.indexOf("Package sidecar hot-update assets") < yaml.indexOf("Upload macOS bundles"),
    "hot-update assets must exist before upload-artifact",
  );
  assert.ok(yaml.indexOf("artifacts/balance-server.zip") < yaml.indexOf("gh release create"));
  assert.match(
    yaml,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/,
  );
  assert.match(yaml, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""/);
  assert.equal((yaml.match(/TAURI_SIGNING_PRIVATE_KEY(?!_PASSWORD)/g) ?? []).length, 2);
  assert.doesNotMatch(yaml, /echo[^\n]*TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(yaml, /artifacts\/latest\.json/);
  assert.match(yaml, /Balance\.app\.tar\.gz/);
  assert.match(yaml, /Balance\.app\.tar\.gz\.sig/);
  assert.equal(
    (
      yaml.match(
        /gh release create[^\n]*"\$LATEST" "\$UPDATER" "\$SIG"/g,
      ) ?? []
    ).length,
    2,
  );
});
