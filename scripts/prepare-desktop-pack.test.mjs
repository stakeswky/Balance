import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareSemver, parseSemver } from "./bump-desktop-pack-version.mjs";
import {
  NATIVE_SURFACE_FILES,
  cargoPackageVersion,
  nativeFingerprint,
  stampDesktopPack,
} from "./prepare-desktop-pack.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("desktop pack stays on semver and keeps native compatibility stamps", () => {
  const pack = JSON.parse(read("desktop-pack.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const lock = JSON.parse(read("desktop-native.lock"));
  const cargoVersion = cargoPackageVersion(read("src-tauri/Cargo.toml"));

  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.app, "balance");
  assert.ok(parseSemver(pack.packVersion));
  assert.equal(pack.minNativeVersion, "0.3.0");
  assert.equal(tauri.version, "0.3.0");
  assert.equal(cargoVersion, "0.3.0");
  assert.equal(lock.nativeVersion, "0.3.0");
  assert.equal(pack.minNativeVersion, tauri.version);
  assert.equal(pack.minNativeVersion, cargoVersion);
  assert.ok(compareSemver(pack.packVersion, pack.minNativeVersion) >= 0);
});

test("native fingerprint matches the committed lock after the 0.3.0 bump", () => {
  const lock = JSON.parse(read("desktop-native.lock"));
  assert.ok(NATIVE_SURFACE_FILES.includes("src-tauri/capabilities/updater-loopback.json"));
  assert.ok(NATIVE_SURFACE_FILES.includes("src-tauri/capabilities/orchestrator-dialog.json"));
  assert.equal(nativeFingerprint(root), lock.fingerprint);
  assert.match(lock.fingerprint, /^[0-9a-f]{64}$/);
});

test("desktop prepare stamps pack.json into the Nitro output", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "balance-pack-"));
  try {
    const stamped = stampDesktopPack({
      root,
      outputDir,
      gitSha: "abc1234deadbeef",
    });
    const written = JSON.parse(readFileSync(join(outputDir, "pack.json"), "utf8"));
    const pack = JSON.parse(read("desktop-pack.json"));
    assert.equal(stamped.packVersion, pack.packVersion);
    assert.equal(stamped.minNativeVersion, "0.3.0");
    assert.equal(stamped.nativeVersion, "0.3.0");
    assert.equal(stamped.gitSha, "abc1234deadbeef");
    assert.deepEqual(written, stamped);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("desktop prepare and DMG verify use the stamped pack and 0.3.0 installer", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["desktop:prepare"], /prepare-desktop-pack\.mjs/);
  assert.match(packageJson.scripts["desktop:verify:dmg"], /Balance_0\.3\.0_aarch64\.dmg/);
});
