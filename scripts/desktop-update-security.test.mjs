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
  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const packageJson = JSON.parse(read("package.json"));

  const guards = actions.match(/assertQuotaRequestAllowed\(\)/g) ?? [];
  assert.equal(guards.length, 2);
  assert.match(manifest, /stakeswky\/Balance\/releases\/download\//);
  assert.match(manifest, /isAllowedUpdateUrl/);
  assert.match(manifest, /isAllowedInstallerUrl/);
  assert.match(apply, /MAX_PACK_BYTES = 80 \* 1024 \* 1024/);
  assert.match(apply, /timingSafeEqual/);
  assert.deepEqual(capability.permissions, ["core:default"]);
  assert.doesNotMatch(JSON.stringify(capability), /shell:allow|fs:allow/);
  assert.equal(packageJson.dependencies?.["@tauri-apps/api"], undefined);
  assert.equal(packageJson.devDependencies?.["@tauri-apps/api"], undefined);
});

test("tracked docs tell 0.1.0 users to install 0.2.0 before hot updates", () => {
  const readme = read("README.md");
  const macos = read("docs/macos-desktop.md");
  const chickenEgg = /已经安装的 0\.1\.0 没有检查更新代码，必须先装 0\.2\.0 的 DMG；之后 sidecar 更新才能热更新。/;
  assert.match(readme, chickenEgg);
  assert.match(macos, chickenEgg);
  assert.match(readme, /设置/);
  assert.match(macos, /退出余量/);
});
