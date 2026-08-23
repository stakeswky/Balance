import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Tauri scaffold has a delayed loopback window and minimal capability", async () => {
  const config = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const defaultCapability = JSON.parse(
    await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  );
  const updaterCapability = JSON.parse(
    await readFile(
      new URL("../src-tauri/capabilities/updater-loopback.json", import.meta.url),
      "utf8",
    ),
  );
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const infoPlist = await readFile(new URL("../src-tauri/Info.plist", import.meta.url), "utf8");
  const watchdog = await readFile(
    new URL("../src-tauri/resources/sidecar-watchdog.cjs", import.meta.url),
    "utf8",
  );
  const verifier = await readFile(new URL("./verify-macos-app.sh", import.meta.url), "utf8");
  const nativeSmoke = await readFile(new URL("./macos-ui-smoke.swift", import.meta.url), "utf8");
  assert.deepEqual(config.app.windows, []);
  assert.equal(config.identifier, "com.balance.desktop");
  assert.deepEqual(config.bundle.externalBin, ["binaries/balance-node"]);
  assert.equal(config.bundle.macOS.signingIdentity, "-");
  assert.equal(config.bundle.macOS.infoPlist, "Info.plist");
  assert.equal(config.bundle.resources["resources/sidecar-watchdog.cjs"], "sidecar-watchdog.cjs");
  assert.deepEqual(config.app.security.capabilities, ["default", "updater-loopback"]);
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
  assert.match(infoPlist, /<key>NSAppTransportSecurity<\/key>/);
  assert.match(infoPlist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  assert.doesNotMatch(infoPlist, /NSAllowsArbitraryLoads/);
  assert.match(rust, /WebviewUrl::External/);
  assert.match(rust, /const SIDECAR_BIN: &str = "balance-node"/);
  assert.match(rust, /wait_for_health/);
  assert.match(rust, /CommandChild/);
  assert.match(rust, /RunEvent::Ready/);
  assert.match(rust, /RunEvent::ExitRequested/);
  assert.match(rust, /api\.prevent_close/);
  assert.match(rust, /window\.hide\(\)/);
  assert.match(rust, /TrayIconBuilder/);
  assert.match(rust, /MenuBuilder/);
  assert.match(rust, /quit_app/);
  assert.match(rust, /const TRAY_WINDOW: &str = "tray"/);
  assert.match(rust, /toggle_tray_dashboard/);
  assert.match(rust, /__desktop\/show-main/);
  assert.match(rust, /\/tray/);
  assert.match(rust, /title\("余量周限额"\)/);
  assert.deepEqual(defaultCapability.windows, ["main", "startup-error", "tray"]);
  assert.match(rust, /BALANCE_PARENT_PID/);
  assert.match(rust, /sidecar-watchdog\.cjs/);
  assert.match(rust, /stopping/);
  assert.match(rust, /\.env_clear\(\)/);
  assert.match(rust, /SIDECAR_ENV_ALLOWLIST/);
  for (const key of ["HOME", "GROK_HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    assert.match(rust, new RegExp(`"${key}"`));
  }
  assert.match(rust, /BALANCE_NATIVE_VERSION/);
  assert.match(rust, /BALANCE_STATE_DIR/);
  assert.match(rust, /BALANCE_ORCHESTRATOR_TOKEN/);
  assert.match(rust, /BALANCE_E2E_STATE_DIR/);
  assert.match(rust, /\.join\("Balance"\)\.join\("orchestrator"\)/);
  assert.match(rust, /symlink_metadata/);
  assert.match(rust, /MetadataExt/);
  assert.match(rust, /from_mode\(0o700\)/);
  assert.match(rust, /from_mode\(0o600\)/);
  assert.match(rust, /\/dev\/urandom/);
  assert.match(rust, /#balance-token=/);
  assert.match(rust, /BALANCE_SHUTDOWN\\n/);
  assert.match(rust, /Duration::from_secs\(17\)/);
  assert.match(rust, /hot-update\/current/);
  assert.match(rust, /failed-/);
  assert.match(rust, /kill_sidecar_for_retry|take_child_for_retry/);
  assert.match(rust, /force_bundled/);
  assert.match(watchdog, /process\.stdin/);
  assert.match(watchdog, /process\.ppid/);
  assert.match(watchdog, /BALANCE_SHUTDOWN/);
  assert.match(watchdog, /Symbol\.for\("balance\.orchestrator\.shutdown"\)/);
  assert.match(watchdog, /15_000/);
  assert.match(watchdog, /SIGTERM/);
  assert.match(verifier, /Mach-O 64-bit executable arm64/);
  assert.match(nativeSmoke, /title == "Balance"/);
  assert.match(nativeSmoke, /waitForInitialAppState/);
  assert.match(nativeSmoke, /Thread\.sleep\(forTimeInterval: 1\)/);
  assert.match(nativeSmoke, /case \.onboarding/);
  assert.match(nativeSmoke, /case \.dashboard/);
});

test("statusline collector is bundled, installed 0700, and injected into the sidecar", async () => {
  const config = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.equal(
    config.bundle.resources["../scripts/balance-claude-statusline.mjs"],
    "claude-statusline.mjs",
  );
  assert.match(rust, /fn install_statusline_collector/);
  assert.match(
    rust,
    /\.join\("\.local"\)\s*\.join\("share"\)\s*\.join\("balance"\)\s*\.join\("bin"\)/,
  );
  assert.match(rust, /set_permissions\(&directory, /);
  assert.match(rust, /set_permissions\(&target, /);
  assert.match(rust, /from_mode\(0o700\)/);
  assert.match(rust, /fn statusline_snapshot_path/);
  assert.match(
    rust,
    /home\s*\.join\("Library"\)\s*\.join\("Application Support"\)\s*\.join\("Balance"\)/,
  );
  assert.match(rust, /"BALANCE_CLAUDE_STATUSLINE_COLLECTOR"/);
  assert.match(rust, /"BALANCE_CLAUDE_STATUSLINE_PATH"/);
});
