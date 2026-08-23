import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareSemver, parseSemver } from "./bump-desktop-pack-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("desktop shell registers the signed Tauri updater with minimal capability", () => {
  const cargo = read("src-tauri/Cargo.toml");
  const rust = read("src-tauri/src/lib.rs");
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const updaterCapability = JSON.parse(
    read("src-tauri/capabilities/updater-loopback.json"),
  );
  const packageJson = JSON.parse(read("package.json"));

  assert.match(cargo, /serde_json = "=1\.0\.149"/);
  assert.match(cargo, /tauri-plugin-updater = "=2\.10\.1"/);
  assert.equal(packageJson.dependencies["@tauri-apps/plugin-updater"], "2.10.1");
  assert.match(rust, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/stakeswky/Balance/releases/latest/download/latest.json",
  ]);
  assert.deepEqual(config.app.security.capabilities, ["default", "updater-loopback"]);
  const publicKey = config.plugins.updater.pubkey;
  assert.deepEqual(defaultCapability.permissions, ["core:default"]);
  assert.equal(updaterCapability.local, false);
  assert.deepEqual(updaterCapability.windows, ["main"]);
  assert.deepEqual(updaterCapability.remote, {
    urls: ["http://127.0.0.1:4780/*"],
  });
  assert.deepEqual(updaterCapability.permissions, ["updater:default"]);
  assert.doesNotMatch(
    JSON.stringify([defaultCapability, updaterCapability]),
    /shell:allow|fs:allow|http:\/\/\*|:\*/,
  );
  assert.match(publicKey.trim(), /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(
    Buffer.from(publicKey.trim(), "base64").toString("utf8"),
    /^untrusted comment: minisign public key:[^\n]*\nRW[A-Za-z0-9+/=]+\n?$/,
  );
});

test("native version stamps stay at 0.3.0 while the hot pack can move independently", () => {
  const cargo = read("src-tauri/Cargo.toml");
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const pack = JSON.parse(read("desktop-pack.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.match(cargo, /^version = "0\.3\.0"$/m);
  assert.equal(config.version, "0.3.0");
  assert.ok(parseSemver(pack.packVersion));
  assert.ok(compareSemver(pack.packVersion, pack.minNativeVersion) >= 0);
  assert.equal(pack.minNativeVersion, "0.3.0");
  assert.match(packageJson.scripts["desktop:verify:dmg"], /Balance_0\.3\.0_aarch64\.dmg/);
});
