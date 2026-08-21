import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  hotUpdateRoot,
  isPackCompatible,
  overlayCurrentDir,
  overlayLooksBootable,
  overlayStagingDir,
  readPackManifest,
  writePackJson,
} from "./overlay.ts";

function home() {
  return mkdtempSync(join(tmpdir(), "balance-hot-update-"));
}

test("macOS overlay lives under Application Support/Balance", () => {
  const root = hotUpdateRoot("/tmp/user", "darwin");
  assert.equal(root, "/tmp/user/Library/Application Support/Balance/hot-update");
  assert.equal(overlayCurrentDir("/tmp/user", "darwin"), join(root, "current"));
  assert.equal(overlayStagingDir("/tmp/user", "darwin"), join(root, "staging"));
});

test("non-darwin overlay paths are rejected", () => {
  assert.throws(() => hotUpdateRoot("/tmp/user", "linux"), /desktop hot update is macOS-only/);
  assert.throws(() => overlayCurrentDir("/tmp/user", "win32"), /desktop hot update is macOS-only/);
  assert.throws(() => overlayStagingDir("/tmp/user", "linux"), /desktop hot update is macOS-only/);
});

test("rejects overlay packs that need a newer native shell", () => {
  const dir = join(home(), "pack");
  mkdirSync(dir, { recursive: true });
  writePackJson(dir, {
    schemaVersion: 1,
    app: "balance",
    packVersion: "0.1.2",
    minNativeVersion: "0.1.2",
    nativeVersion: "0.1.2",
  });
  const pack = readPackManifest(dir);
  assert.equal(isPackCompatible(pack, "0.1.1"), false);
  assert.equal(isPackCompatible(pack, "0.1.2"), true);
});

test("missing pack.json is incompatible", () => {
  const dir = join(home(), "empty");
  mkdirSync(dir, { recursive: true });
  assert.equal(readPackManifest(dir), null);
  assert.equal(isPackCompatible(null, "0.1.1"), false);
});

test("overlayLooksBootable requires server entry, public/, and a compatible pack", () => {
  const dir = join(home(), "overlay");
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "index.mjs"), "export {}\n");
  writePackJson(dir, {
    schemaVersion: 1,
    app: "balance",
    packVersion: "0.1.2",
    minNativeVersion: "0.1.1",
    nativeVersion: "0.1.1",
  });
  assert.equal(overlayLooksBootable(dir, "0.1.1"), false);
  mkdirSync(join(dir, "public"));
  assert.equal(overlayLooksBootable(dir, "0.1.1"), true);
});
