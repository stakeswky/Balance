import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("hot-update path stays allowlisted, guarded, and capability-minimal", () => {
  const actions = read("src/lib/desktop-update/actions.ts");
  const manifest = read("src/lib/desktop-update/manifest.ts");
  const apply = read("src/lib/desktop-update/apply.ts");
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const updaterCapability = JSON.parse(
    read("src-tauri/capabilities/updater-loopback.json"),
  );
  const packageJson = JSON.parse(read("package.json"));

  const guards = actions.match(/assertQuotaRequestAllowed\(\)/g) ?? [];
  assert.equal(guards.length, 2);
  assert.match(manifest, /stakeswky\/Balance\/releases\/download\//);
  assert.match(manifest, /isAllowedUpdateUrl/);
  assert.match(manifest, /isAllowedInstallerUrl/);
  assert.match(apply, /MAX_PACK_BYTES = 80 \* 1024 \* 1024/);
  assert.match(apply, /timingSafeEqual/);
  assert.deepEqual(defaultCapability.permissions, ["core:default"]);
  assert.deepEqual(updaterCapability.permissions, ["updater:default"]);
  assert.deepEqual(updaterCapability.remote?.urls, ["http://127.0.0.1:4780/*"]);
  assert.doesNotMatch(
    JSON.stringify([defaultCapability, updaterCapability]),
    /shell:allow|fs:allow/,
  );
  assert.equal(packageJson.dependencies?.["@tauri-apps/plugin-updater"], "2.10.1");
  assert.equal(packageJson.dependencies?.["@tauri-apps/api"], undefined);
  assert.equal(packageJson.devDependencies?.["@tauri-apps/api"], undefined);
});

test("tracked docs describe the desktop update entry point and restart path", () => {
  const readme = read("README.md");
  const macos = read("docs/macos-desktop.md");
  assert.match(readme, /设置/);
  assert.match(readme, /退出余量/);
  assert.match(macos, /设置/);
  assert.match(macos, /退出余量/);
});
