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
  const infoPlist = await readFile(
    new URL("../src-tauri/Info.plist", import.meta.url),
    "utf8",
  );
  const watchdog = await readFile(
    new URL("../src-tauri/resources/sidecar-watchdog.cjs", import.meta.url),
    "utf8",
  );
  const verifier = await readFile(
    new URL("./verify-macos-app.sh", import.meta.url),
    "utf8",
  );
  const nativeSmoke = await readFile(
    new URL("./macos-ui-smoke.swift", import.meta.url),
    "utf8",
  );
  assert.deepEqual(config.app.windows, []);
  assert.deepEqual(config.bundle.externalBin, ["binaries/synq-node"]);
  assert.equal(config.bundle.macOS.signingIdentity, "-");
  assert.equal(config.bundle.macOS.infoPlist, "Info.plist");
  assert.equal(
    config.bundle.resources["resources/sidecar-watchdog.cjs"],
    "sidecar-watchdog.cjs",
  );
  assert.deepEqual(capability.permissions, ["core:default"]);
  assert.doesNotMatch(JSON.stringify(capability), /shell:allow|fs:allow/);
  assert.match(infoPlist, /<key>NSAppTransportSecurity<\/key>/);
  assert.match(infoPlist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  assert.doesNotMatch(infoPlist, /NSAllowsArbitraryLoads/);
  assert.match(rust, /WebviewUrl::External/);
  assert.match(rust, /const SIDECAR_BIN: &str = "synq-node"/);
  assert.match(rust, /wait_for_health/);
  assert.match(rust, /CommandChild/);
  assert.match(rust, /RunEvent::Ready/);
  assert.match(rust, /RunEvent::ExitRequested/);
  assert.match(rust, /window\.app_handle\(\)\.exit\(0\)/);
  assert.match(rust, /SYNQ_PARENT_PID/);
  assert.match(rust, /sidecar-watchdog\.cjs/);
  assert.match(rust, /stopping/);
  assert.match(watchdog, /process\.stdin/);
  assert.match(watchdog, /process\.ppid/);
  assert.match(verifier, /Mach-O 64-bit executable arm64/);
  assert.doesNotMatch(nativeSmoke, /title\.isEmpty \? "Synq"/);
});
