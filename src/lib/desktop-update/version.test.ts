import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSemver, decideUpdate, parseSemver, type UpdateManifestLike } from "./version.ts";

function remote(
  partial: Partial<UpdateManifestLike & { hot?: { url: string; sha256: string; size: number }; installer?: { url: string } }> = {},
) {
  return {
    packVersion: "0.1.1",
    minNativeVersion: "0.1.0",
    hot: {
      url: "https://github.com/stakeswky/Balance/releases/download/latest/balance-server.zip",
      sha256: "aa".repeat(32),
      size: 12,
    },
    installer: { url: "https://github.com/stakeswky/Balance/releases/latest" },
    ...partial,
  };
}

test("parseSemver reads major.minor.patch", () => {
  assert.deepEqual(parseSemver("0.1.1"), [0, 1, 1]);
  assert.equal(parseSemver("1.2"), null);
  assert.equal(parseSemver("latest"), null);
});

test("compareSemver orders versions", () => {
  assert.equal(compareSemver("0.1.1", "0.1.0"), 1);
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
});

test("equal or older remote pack is current", () => {
  assert.equal(
    decideUpdate({ packVersion: "0.1.1", nativeVersion: "0.1.1" }, remote({ packVersion: "0.1.1" })).kind,
    "current",
  );
  assert.equal(
    decideUpdate({ packVersion: "0.1.2", nativeVersion: "0.1.1" }, remote({ packVersion: "0.1.1" })).kind,
    "current",
  );
});

test("newer pack with compatible native is hot", () => {
  const decision = decideUpdate(
    { packVersion: "0.1.0", nativeVersion: "0.1.1" },
    remote({ packVersion: "0.1.2", minNativeVersion: "0.1.1" }),
  );
  assert.equal(decision.kind, "hot");
});

test("newer pack that needs a newer shell is installer", () => {
  const decision = decideUpdate(
    { packVersion: "0.1.1", nativeVersion: "0.1.1" },
    remote({ packVersion: "0.1.2", minNativeVersion: "0.1.2" }),
  );
  assert.equal(decision.kind, "installer");
});
