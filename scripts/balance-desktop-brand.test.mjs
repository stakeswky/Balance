import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("Tauri publishes Balance without changing the bundle identity", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "Balance");
  assert.equal(config.identifier, "com.synq.desktop");
  assert.deepEqual(config.bundle.externalBin, ["binaries/synq-node"]);
  assert.equal(config.bundle.resources["../.output"], "synq-server");

  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /name = "synq-desktop"/);
  assert.match(cargo, /name = "synq_desktop_lib"/);
});

test("native UI and startup error use Balance while health stays compatible", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /\.title\("Balance"\)/);
  assert.match(
    rust,
    /const HEALTH_BODY: &str = "\{\\"app\\":\\"synq\\",\\"mode\\":\\"desktop\\"\}"/,
  );
  assert.match(rust, /const SIDECAR_BIN: &str = "synq-node"/);
  assert.doesNotMatch(rust, /\.title\("Synq"\)/);
  assert.doesNotMatch(rust, /Synq/);

  const errorPage = read("src-tauri/dist/startup-error.html");
  assert.match(errorPage, /<title>Balance 无法启动<\/title>/);
  assert.match(errorPage, /Balance 无法启动本地服务/);
  assert.doesNotMatch(errorPage, /Synq 无法启动/);

  const nativeSmoke = read("scripts/macos-ui-smoke.swift");
  assert.match(nativeSmoke, /title == "Balance"/);
  assert.match(nativeSmoke, /余量初始设置/);
  assert.match(nativeSmoke, /Balance 无法启动本地服务/);
  assert.doesNotMatch(nativeSmoke, /Synq/);
});

test("desktop verification and CI use Balance artifact paths", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["desktop:verify:dmg"], /Balance_0\.1\.0_aarch64\.dmg/);

  for (const script of [
    "scripts/verify-macos-app.sh",
    "scripts/verify-macos-crash-cleanup.sh",
    "scripts/verify-macos-env-isolation.sh",
    "scripts/verify-macos-startup-error.sh",
  ]) {
    const source = read(script);
    assert.match(source, /bundle\/macos\/Balance\.app/);
    assert.doesNotMatch(source, /bundle\/macos\/Synq\.app/);
  }

  const appVerifier = read("scripts/verify-macos-app.sh");
  assert.match(appVerifier, /\[ "\$ui_title" != "Balance" \]/);

  const workflow = read(".github/workflows/macos-arm64.yml");
  assert.match(workflow, /bundle\/macos\/Balance\.app/);
  assert.match(workflow, /artifacts\/Balance-macos-arm64\.app\.zip/);
  assert.match(workflow, /name: Balance-macos-arm64/);
  assert.match(workflow, /Contents\/MacOS\/synq-desktop/);
  assert.match(workflow, /Contents\/MacOS\/synq-node/);
  assert.doesNotMatch(workflow, /Synq-macos-arm64/);
});
