import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MANIFEST_URL, parseUpdateManifest } from "./manifest.ts";
import { overlayCurrentDir, writePackJson } from "./overlay.ts";
import {
  applyCheckedUpdate,
  CHECK_USER_AGENT,
  checkForUpdate,
  readLocalVersion,
} from "./service.ts";

const HOT_URL = "https://github.com/stakeswky/Balance/releases/download/latest/balance-server.zip";
const INSTALLER_URL = "https://github.com/stakeswky/Balance/releases/latest";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function validManifest(
  partial: Record<string, unknown> = {},
  hotPartial: Record<string, unknown> = {},
) {
  const manifest = {
    schemaVersion: 1,
    app: "balance",
    packVersion: "0.1.2",
    minNativeVersion: "0.1.1",
    nativeVersion: "0.1.1",
    gitSha: "deadbeef",
    publishedAt: "2026-08-21T00:00:00Z",
    hot: {
      url: HOT_URL,
      sha256: "ab".repeat(32),
      size: 100,
      ...hotPartial,
    },
    installer: { url: INSTALLER_URL },
    ...partial,
  };
  parseUpdateManifest(JSON.stringify(manifest));
  return manifest;
}

function jsonResponse(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

function writeBundled(bundledRoot: string, packVersion = "0.1.0") {
  writePackJson(bundledRoot, {
    schemaVersion: 1,
    app: "balance",
    packVersion,
    minNativeVersion: "0.1.0",
  });
}

function writeBootableExtract(dest: string, packVersion: string) {
  mkdirSync(join(dest, "server"), { recursive: true });
  mkdirSync(join(dest, "public"), { recursive: true });
  writeFileSync(join(dest, "server", "index.mjs"), "export {}\n");
  writeFileSync(join(dest, "public", ".keep"), "");
  writePackJson(dest, {
    schemaVersion: 1,
    app: "balance",
    packVersion,
    minNativeVersion: "0.1.1",
  });
}

function roots() {
  const home = tmp("balance-service-home-");
  const bundledRoot = tmp("balance-service-bundled-");
  writeBundled(bundledRoot);
  return { home, bundledRoot };
}

test("fetch newer compatible pack is hot with bundled local version", async () => {
  const { home, bundledRoot } = roots();
  let seenUrl = "";
  let seenUa = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenUa = new Headers(init?.headers).get("User-Agent") ?? "";
    return jsonResponse(validManifest());
  };

  const { local, decision } = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
  });

  assert.equal(local.packVersion, "0.1.0");
  assert.equal(local.nativeVersion, "0.1.1");
  assert.equal(decision.kind, "hot");
  assert.equal(seenUrl, DEFAULT_MANIFEST_URL);
  assert.equal(seenUa, CHECK_USER_AGENT);
});

test("minNative higher than local native is installer and does not download", async () => {
  const { home, bundledRoot } = roots();
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(
      validManifest({
        packVersion: "0.1.2",
        minNativeVersion: "0.1.2",
        nativeVersion: "0.1.2",
      }),
    );

  const { decision } = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
  });
  assert.equal(decision.kind, "installer");

  let downloads = 0;
  const applied = await applyCheckedUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
    download: async () => {
      downloads += 1;
      throw new Error("download should not be called");
    },
  });
  assert.deepEqual(applied, {
    kind: "installer",
    url: INSTALLER_URL,
    packVersion: "0.1.2",
  });
  assert.equal(downloads, 0);
});

test("isDesktop false is not-desktop and still returns local", async () => {
  const { home, bundledRoot } = roots();
  const fetchImpl: typeof fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const { local, decision } = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: false,
    fetchImpl,
  });
  assert.equal(local.packVersion, "0.1.0");
  assert.deepEqual(decision, { kind: "unavailable", reason: "not-desktop" });

  const applied = await applyCheckedUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: false,
    fetchImpl,
    download: async () => {
      throw new Error("download should not be called");
    },
  });
  assert.deepEqual(applied, { kind: "unavailable", reason: "not-desktop" });
});

test("fetch 500 is unavailable network", async () => {
  const { home, bundledRoot } = roots();
  const fetchImpl: typeof fetch = async () => jsonResponse("error", 500);

  const { local, decision } = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
  });
  assert.equal(local.packVersion, "0.1.0");
  assert.deepEqual(decision, { kind: "unavailable", reason: "network" });

  const thrown: typeof fetch = async () => {
    throw new Error("offline");
  };
  const failed = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl: thrown,
  });
  assert.deepEqual(failed.decision, { kind: "unavailable", reason: "network" });
});

test("invalid manifest JSON is unavailable", async () => {
  const { home, bundledRoot } = roots();
  const fetchImpl: typeof fetch = async () => jsonResponse("{not-json", 200);
  const { decision } = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
  });
  assert.deepEqual(decision, { kind: "unavailable", reason: "invalid-manifest" });
});

test("apply hot injects download and extract and reports ready-restart", async () => {
  const { home, bundledRoot } = roots();
  const bytes = Buffer.from("zip-bytes");
  const digest = sha256(bytes);
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(
      validManifest({}, { sha256: digest, size: bytes.length }),
    );

  const applied = await applyCheckedUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
    download: async (_url, dest) => {
      writeFileSync(dest, bytes);
    },
    extract: async (_zip, dest) => {
      writeBootableExtract(dest, "0.1.2");
    },
  });

  const current = overlayCurrentDir(home, "darwin");
  assert.deepEqual(applied, { kind: "ready-restart", packVersion: "0.1.2" });
  assert.equal(existsSync(current), true);
  assert.equal(existsSync(join(current, "public")), true);
  assert.equal(existsSync(join(current, "server", "index.mjs")), true);
});

test("readLocalVersion prefers a bootable overlay then bundled then 0.0.0", async () => {
  const home = tmp("balance-service-overlay-");
  const bundledRoot = tmp("balance-service-bundled-empty-");
  const missing = await readLocalVersion({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
  });
  assert.equal(missing.source, "bundled");
  assert.equal(missing.packVersion, "0.0.0");

  writeBundled(bundledRoot, "0.1.0");
  const fromBundled = await readLocalVersion({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
  });
  assert.equal(fromBundled.source, "bundled");
  assert.equal(fromBundled.packVersion, "0.1.0");

  const current = overlayCurrentDir(home, "darwin");
  writeBootableExtract(current, "0.1.1");
  const fromOverlay = await readLocalVersion({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
  });
  assert.equal(fromOverlay.source, "overlay");
  assert.equal(fromOverlay.packVersion, "0.1.1");
});

test("equal remote pack is current and does not download", async () => {
  const { home, bundledRoot } = roots();
  writeBundled(bundledRoot, "0.1.2");
  const fetchImpl: typeof fetch = async () => jsonResponse(validManifest({ packVersion: "0.1.2" }));
  const { decision } = await checkForUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
  });
  assert.equal(decision.kind, "current");

  let downloads = 0;
  const applied = await applyCheckedUpdate({
    home,
    bundledRoot,
    nativeVersion: "0.1.1",
    isDesktop: true,
    fetchImpl,
    download: async () => {
      downloads += 1;
      throw new Error("download should not be called");
    },
  });
  assert.deepEqual(applied, { kind: "current" });
  assert.equal(downloads, 0);
});
