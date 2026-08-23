import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bumpPatch,
  compareSemver,
  nextPackVersion,
  writeBumpedPack,
} from "./bump-desktop-pack-version.mjs";

test("bumpPatch increments the patch number", () => {
  assert.equal(bumpPatch("0.3.1"), "0.3.2");
  assert.equal(bumpPatch("1.0.9"), "1.0.10");
  assert.equal(bumpPatch("0.0.0"), "0.0.1");
});

test("bumpPatch rejects non-semver versions", () => {
  assert.throws(() => bumpPatch("0.3"), /invalid packVersion/);
  assert.throws(() => bumpPatch("0.3.1-beta"), /invalid packVersion/);
});

test("nextPackVersion bumps the higher of local and remote", () => {
  assert.equal(nextPackVersion("0.3.1"), "0.3.2");
  assert.equal(nextPackVersion("0.3.1", "0.3.1"), "0.3.2");
  assert.equal(nextPackVersion("0.3.1", "0.3.4"), "0.3.5");
  assert.equal(nextPackVersion("0.3.4", "0.3.1"), "0.3.5");
});

test("writeBumpedPack keeps native compatibility stamps and only moves packVersion", () => {
  const dir = mkdtempSync(join(tmpdir(), "balance-pack-bump-"));
  try {
    const packPath = join(dir, "desktop-pack.json");
    writeFileSync(
      packPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          app: "balance",
          packVersion: "0.3.1",
          minNativeVersion: "0.3.0",
        },
        null,
        2,
      )}\n`,
    );
    const result = writeBumpedPack({ packPath, remotePackVersion: "0.3.3" });
    assert.deepEqual(result, { previous: "0.3.1", next: "0.3.4" });
    assert.deepEqual(JSON.parse(readFileSync(packPath, "utf8")), {
      schemaVersion: 1,
      app: "balance",
      packVersion: "0.3.4",
      minNativeVersion: "0.3.0",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compareSemver orders hot packs ahead of the current native floor", () => {
  assert.equal(compareSemver("0.3.2", "0.3.1") > 0, true);
  assert.equal(compareSemver("0.3.1", "0.3.0") > 0, true);
  assert.equal(compareSemver("0.3.1", "0.3.1"), 0);
});
