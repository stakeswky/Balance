import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  applyHotUpdatePack,
  dittoExtract,
  MAX_PACK_BYTES,
  sha256Matches,
} from "./apply.ts";
import {
  hotUpdateRoot,
  overlayCurrentDir,
  overlayStagingDir,
  writePackJson,
} from "./overlay.ts";

const ALLOWED_URL =
  "https://github.com/stakeswky/Balance/releases/download/latest/balance-server.zip";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function homeDir() {
  return mkdtempSync(join(tmpdir(), "balance-apply-"));
}

function writeBootableExtract(dest: string) {
  mkdirSync(join(dest, "server"), { recursive: true });
  mkdirSync(join(dest, "public"), { recursive: true });
  writeFileSync(join(dest, "server", "index.mjs"), "export {}\n");
  writeFileSync(join(dest, "public", ".keep"), "");
  writePackJson(dest, {
    schemaVersion: 1,
    app: "balance",
    packVersion: "0.1.2",
    minNativeVersion: "0.1.1",
  });
}

test("sha256Matches uses 32-byte timing-safe comparison", () => {
  const digest = "ab".repeat(32);
  assert.equal(sha256Matches(digest, digest), true);
  assert.equal(sha256Matches(digest.toUpperCase(), digest), true);
  assert.equal(sha256Matches("aa".repeat(32), "bb".repeat(32)), false);
  assert.equal(sha256Matches("aa".repeat(31), "aa".repeat(31)), false);
  assert.equal(sha256Matches("aa".repeat(33), "aa".repeat(33)), false);
  assert.equal(sha256Matches("not-hex", digest), false);
});

test("activates a verified pack into Application Support", async () => {
  const home = homeDir();
  const bytes = Buffer.from("zip-bytes");
  const digest = sha256(bytes);
  assert.equal(digest.length, 64);
  const result = await applyHotUpdatePack({
    home,
    nativeVersion: "0.1.1",
    asset: {
      url: ALLOWED_URL,
      sha256: digest,
      size: bytes.length,
    },
    download: async (_url, dest) => {
      writeFileSync(dest, bytes);
    },
    extract: async (_zip, dest) => {
      writeBootableExtract(dest);
    },
  });
  const current = overlayCurrentDir(home, "darwin");
  assert.equal(result.packVersion, "0.1.2");
  assert.equal(readFileSync(join(current, "server", "index.mjs"), "utf8"), "export {}\n");
  assert.equal(existsSync(join(current, "public", ".keep")), true);
  assert.equal(existsSync(overlayStagingDir(home, "darwin")), false);
});

test("refuses a sha256 mismatch without extracting or replacing current", async () => {
  const home = homeDir();
  await assert.rejects(
    () =>
      applyHotUpdatePack({
        home,
        nativeVersion: "0.1.1",
        asset: {
          url: ALLOWED_URL,
          sha256: "aa".repeat(32),
          size: 4,
        },
        download: async (_url, dest) => {
          writeFileSync(dest, "nope");
        },
        extract: async () => {
          throw new Error("should not extract");
        },
      }),
    /sha256/,
  );
  assert.equal(existsSync(overlayCurrentDir(home, "darwin")), false);
  assert.equal(existsSync(overlayStagingDir(home, "darwin")), false);
});

test("refuses an illegal update URL before download", async () => {
  const home = homeDir();
  await assert.rejects(
    () =>
      applyHotUpdatePack({
        home,
        nativeVersion: "0.1.1",
        asset: {
          url: "https://evil.example/pack.zip",
          sha256: "aa".repeat(32),
          size: 4,
        },
        download: async () => {
          throw new Error("download should not be called");
        },
      }),
    /allowlist/i,
  );
  assert.equal(existsSync(overlayCurrentDir(home, "darwin")), false);
});

test("refuses an oversize pack before download", async () => {
  const home = homeDir();
  await assert.rejects(
    () =>
      applyHotUpdatePack({
        home,
        nativeVersion: "0.1.1",
        asset: {
          url: ALLOWED_URL,
          sha256: "aa".repeat(32),
          size: MAX_PACK_BYTES + 1,
        },
        download: async () => {
          throw new Error("download should not be called");
        },
      }),
    /MAX_PACK_BYTES|too large|oversize|size/i,
  );
  assert.equal(existsSync(overlayCurrentDir(home, "darwin")), false);
});

test("refuses extracted packs that escape the staging directory", async () => {
  const home = homeDir();
  const bytes = Buffer.from("zip-bytes");
  const digest = sha256(bytes);
  await assert.rejects(
    () =>
      applyHotUpdatePack({
        home,
        nativeVersion: "0.1.1",
        asset: {
          url: ALLOWED_URL,
          sha256: digest,
          size: bytes.length,
        },
        download: async (_url, dest) => writeFileSync(dest, bytes),
        extract: async (_zip, dest) => {
          mkdirSync(dest, { recursive: true });
          symlinkSync("/tmp", join(dest, "escape"));
        },
      }),
    /escape|symlink|outside/i,
  );
  assert.equal(existsSync(overlayCurrentDir(home, "darwin")), false);
  assert.equal(existsSync(overlayStagingDir(home, "darwin")), false);
});

test(
  "real zip traversal with ditto does not escape or activate",
  { skip: process.platform !== "darwin" },
  async () => {
    const home = homeDir();
    const zipPath = join(home, "slip.zip");
    execFileSync("python3", [
      "-c",
      `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
z.writestr("../escaped.txt", "pwned")
z.writestr("dummy.txt", "ok")
z.close()
`,
    ]);
    const bytes = readFileSync(zipPath);
    const digest = sha256(bytes);
    const root = hotUpdateRoot(home, "darwin");
    const parent = dirname(root);
    const escapedAtParent = join(parent, "escaped.txt");
    const escapedBesideParent = join(dirname(parent), "escaped.txt");
    const escapedAtRoot = join(root, "escaped.txt");

    let threw = false;
    try {
      await applyHotUpdatePack({
        home,
        nativeVersion: "0.1.1",
        asset: {
          url: ALLOWED_URL,
          sha256: digest,
          size: bytes.length,
        },
        download: async (_url, dest) => {
          writeFileSync(dest, bytes);
        },
        extract: dittoExtract,
      });
    } catch {
      threw = true;
    }

    assert.equal(existsSync(overlayCurrentDir(home, "darwin")), false);
    assert.equal(existsSync(escapedAtParent), false);
    assert.equal(existsSync(escapedBesideParent), false);
    assert.equal(existsSync(escapedAtRoot), false);
    assert.equal(existsSync(join(overlayStagingDir(home, "darwin"), "escaped.txt")), false);
    assert.ok(threw || !existsSync(overlayCurrentDir(home, "darwin")));
  },
);
