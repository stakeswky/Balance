import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Tauri scaffold has a delayed loopback window and minimal capability", async () => {
  const config = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const capability = JSON.parse(
    await readFile(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  );
  const rust = await readFile(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  assert.deepEqual(config.app.windows, []);
  assert.deepEqual(config.bundle.externalBin, ["binaries/synq-node"]);
  assert.equal(config.bundle.macOS.signingIdentity, "-");
  assert.deepEqual(capability.permissions, ["core:default"]);
  assert.doesNotMatch(JSON.stringify(capability), /shell:allow|fs:allow/);
  assert.match(rust, /WebviewUrl::External/);
  assert.match(rust, /const SIDECAR_BIN: &str = "synq-node"/);
  assert.match(rust, /wait_for_health/);
  assert.match(rust, /CommandChild/);
  assert.match(rust, /RunEvent::ExitRequested/);
  assert.match(rust, /window\.app_handle\(\)\.exit\(0\)/);
});
