import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("..", import.meta.url);

async function read(relative) {
  return readFile(new URL(relative, rootUrl), "utf8");
}

test("desktop settings show an in-app update card without leaving the WebView", async () => {
  const card = await read("src/components/balance/update-card.tsx");
  const dashboard = await read("src/components/balance/dashboard.tsx");
  const settings = await read("src/components/balance/settings-panel.tsx");
  const workflow = await read(".github/workflows/macos-arm64.yml");
  const packageJson = JSON.parse(await read("package.json"));

  assert.match(settings, /<UpdateCard\s*\/>/);
  assert.match(card, /应用更新/);
  assert.match(
    card,
    /只改界面和采集逻辑时会直接更新；需要更新桌面组件时，会自动下载并安装完整应用。/,
  );
  assert.match(card, /检查更新/);
  assert.match(card, /更新/);
  assert.match(card, /自动下载并安装完整应用/);
  assert.match(card, /installNativeUpdate/);
  assert.match(card, /更新到.*已完成。请从菜单栏选择「退出余量」，再重新打开即可使用最新版本。/);
  assert.match(card, /VITE_DESKTOP/);
  assert.match(card, /checkDesktopUpdate/);
  assert.match(card, /applyDesktopUpdate/);
  assert.match(card, /VITE_DESKTOP_UPDATER_E2E/);
  assert.match(dashboard, /VITE_DESKTOP_UPDATER_E2E/);
  assert.doesNotMatch(card, /navigator\.clipboard/);
  assert.doesNotMatch(card, /复制链接/);
  assert.doesNotMatch(card, /target="_blank"/);
  assert.doesNotMatch(card, /window\.open/);
  assert.match(packageJson.scripts["build:desktop:web"], /VITE_DESKTOP=true/);
  assert.doesNotMatch(packageJson.scripts["build:desktop:web"], /VITE_DESKTOP_UPDATER_E2E/);
  assert.doesNotMatch(workflow, /VITE_DESKTOP_UPDATER_E2E/);
  assert.doesNotMatch(packageJson.scripts.dev, /VITE_DESKTOP=true/);
  assert.doesNotMatch(packageJson.scripts.build, /VITE_DESKTOP=true/);
});
