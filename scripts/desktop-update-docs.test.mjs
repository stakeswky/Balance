import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relative) {
  return readFile(resolve(root, relative), "utf8");
}

test("user and maintainer docs explain the automatic native update boundary", async () => {
  const readme = await read("README.md");
  const desktopDocs = await read("docs/macos-desktop.md");

  for (const contents of [readme, desktopDocs]) {
    assert.match(contents, /0\.2\.0[^\n]*0\.3\.0[^\n]*最后一次手动安装/);
    assert.match(contents, /0\.3\.0[^\n]*自动下载并安装/);
    assert.match(contents, /退出余量[^\n]*重新打开/);
  }

  assert.match(readme, /Balance_0\.3\.0_aarch64\.dmg/);
  assert.match(desktopDocs, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(desktopDocs, /不得提交/);
  assert.match(desktopDocs, /遗失/);
});

test("native updater E2E stays local and cannot weaken production transport", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const productionConfig = await read("src-tauri/tauri.conf.json");
  const verifier = await read("scripts/verify-native-updater-e2e.sh");
  const swiftDriver = await read("scripts/macos-updater-e2e.swift");

  assert.equal(
    packageJson.scripts["desktop:verify:updater"],
    "sh scripts/verify-native-updater-e2e.sh",
  );
  assert.doesNotMatch(productionConfig, /dangerousInsecureTransportProtocol/);
  assert.match(verifier, /dangerousInsecureTransportProtocol/);
  assert.match(verifier, /127\.0\.0\.1:4876/);
  assert.match(verifier, /git worktree add --detach/);
  assert.match(verifier, /git worktree remove --force/);
  assert.match(verifier, /VITE_DESKTOP_UPDATER_E2E=true/);
  assert.match(verifier, /native-updater-install-ok: 0\.3\.0 -> 0\.3\.1/);
  assert.match(verifier, /native-updater-restart-ok: version=0\.3\.1/);
  assert.match(verifier, /native-updater-bad-signature-ok: version=0\.3\.0/);
  assert.match(verifier, /Buffer\.from\(process\.env\.VALID_SIGNATURE, "base64"\)/);
  assert.match(verifier, /decoded\[1\]/);
  assert.doesNotMatch(verifier, /NR == 2/);
  assert.doesNotMatch(verifier, /valid_signature#\?/);
  assert.match(swiftDriver, /自动更新失败，请检查网络后重试/);
  assert.match(swiftDriver, /更新到 0\.3\.1 已完成/);
  assert.match(swiftDriver, /kAXTitleAttribute\) == "Balance"/);
  assert.match(swiftDriver, /kAXTitleAttribute\) == "退出余量"/);
});
