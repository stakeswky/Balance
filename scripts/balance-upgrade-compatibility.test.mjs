import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("Balance keeps the Synq persistence and desktop protocol identifiers", () => {
  const store = read("src/lib/quota/store.ts");
  assert.match(store, /name: "synq-quota-v8"/);
  assert.match(store, /removeItem\("synq-quota-v7"\)/);

  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.identifier, "com.synq.desktop");

  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /const SIDECAR_HOST: &str = "127\.0\.0\.1"/);
  assert.match(rust, /const SIDECAR_PORT: u16 = 4780/);
  assert.match(rust, /\{\\"app\\":\\"synq\\",\\"mode\\":\\"desktop\\"\}/);

  const official = read("src/lib/quota/official.server.ts");
  assert.match(official, /"Application Support", "Synq", "official-quota\.json"/);
});

test("installed screenshot capture follows Balance without changing storage", () => {
  const capture = read("scripts/capture-public-screenshots.mjs");
  assert.match(capture, /\/Applications\/Balance\.app\/Contents\/Resources\/synq-server/);
  assert.doesNotMatch(capture, /\/Applications\/Synq\.app/);
  assert.match(capture, /localStorage\.setItem\("synq-quota-v8"/);
  assert.match(capture, /localStorage\.getItem\("synq-quota-v8"/);
  assert.match(capture, /余量 \/ Balance/);
  assert.match(capture, /getByText\("余量", \{ exact: true \}\)/);
});

test("native verification reads the persisted settings through the Balance UI", () => {
  const plans = read("src/components/synq/plans-panel.tsx");
  assert.match(plans, /aria-label=\{active \? `\$\{p\.name\}，当前套餐` : p\.name\}/);
  assert.match(plans, /aria-label="周额度加成百分比"/);
  assert.match(plans, /aria-label="五小时窗告警阈值"/);
  assert.match(plans, /aria-label="本周额度告警阈值"/);

  const nativeSmoke = read("scripts/macos-ui-smoke.swift");
  assert.match(nativeSmoke, /BALANCE_EXPECTED_SETTINGS/);
  assert.match(nativeSmoke, /native-persistence-ok/);
  assert.match(nativeSmoke, /，当前套餐/);
  assert.match(nativeSmoke, /waitForSliderValue/);

  const appVerifier = read("scripts/verify-macos-app.sh");
  assert.match(appVerifier, /BALANCE_EXPECTED_SETTINGS/);
  assert.match(appVerifier, /native-persistence-ok/);
});

test("README does not document the Synq upgrade path", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /## 从 Synq 升级/);
  assert.doesNotMatch(readme, /原地品牌升级/);
});
