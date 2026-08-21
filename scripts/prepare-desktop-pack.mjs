import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const NATIVE_SURFACE_FILES = [
  "scripts/prepare-macos-node-runtime.mjs",
  "src-tauri/Info.plist",
  "src-tauri/build.rs",
  "src-tauri/capabilities/default.json",
  "src-tauri/Cargo.toml",
  "src-tauri/resources/sidecar-watchdog.cjs",
  "src-tauri/src/lib.rs",
  "src-tauri/src/main.rs",
  "src-tauri/tauri.conf.json",
].sort();

export function cargoPackageVersion(toml) {
  const match = /^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(toml);
  if (!match) {
    throw new Error("Cargo.toml is missing a package version");
  }
  return match[1];
}

export function nativeFingerprint(root = DEFAULT_ROOT) {
  const hash = createHash("sha256");
  for (const relative of NATIVE_SURFACE_FILES) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(root, relative)));
  }
  return hash.digest("hex");
}

export function stampDesktopPack({
  root = DEFAULT_ROOT,
  outputDir = join(root, ".output"),
  gitSha = process.env.GITHUB_SHA ?? "unknown",
} = {}) {
  const pack = JSON.parse(readFileSync(join(root, "desktop-pack.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const cargoVersion = cargoPackageVersion(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "desktop-native.lock"), "utf8"));
  const fingerprint = nativeFingerprint(root);

  if (pack.schemaVersion !== 1 || pack.app !== "balance") {
    throw new Error("desktop-pack.json is not a Balance pack");
  }
  if (pack.minNativeVersion !== tauri.version) {
    throw new Error("desktop-pack minNativeVersion must equal tauri.conf version");
  }
  if (pack.minNativeVersion !== cargoVersion) {
    throw new Error("desktop-pack minNativeVersion must equal Cargo package version");
  }
  if (lock.nativeVersion !== pack.minNativeVersion) {
    throw new Error("desktop-native.lock nativeVersion must equal minNativeVersion");
  }
  if (lock.fingerprint !== fingerprint) {
    throw new Error(
      `desktop-native.lock fingerprint mismatch; update the lock after native changes (${fingerprint})`,
    );
  }

  const stamped = {
    schemaVersion: 1,
    app: "balance",
    packVersion: pack.packVersion,
    minNativeVersion: pack.minNativeVersion,
    nativeVersion: tauri.version,
    gitSha,
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "pack.json"), `${JSON.stringify(stamped, null, 2)}\n`);
  return stamped;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  stampDesktopPack();
}
