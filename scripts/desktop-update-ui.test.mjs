import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("..", import.meta.url);

async function read(relative) {
  return readFile(new URL(relative, rootUrl), "utf8");
}

test("desktop settings show an in-app update card without leaving the WebView", async () => {
  const card = await read("src/components/balance/update-card.tsx");
  const settings = await read("src/components/balance/settings-panel.tsx");
  const packageJson = JSON.parse(await read("package.json"));

  assert.match(settings, /<UpdateCard\s*\/>/);
  assert.match(card, /应用更新/);
  assert.match(
    card,
    /仓库发布后，若只改了界面和采集逻辑，可以直接更新，不用重新下载安装包。改了桌面壳则仍需安装包。/,
  );
  assert.match(card, /检查更新/);
  assert.match(card, /更新/);
  assert.match(card, /下载安装包/);
  assert.match(card, /复制链接/);
  assert.match(
    card,
    /更新完成。请从菜单栏选择「退出余量」，再重新打开。关闭窗口不够。/,
  );
  assert.match(card, /VITE_DESKTOP/);
  assert.match(card, /checkDesktopUpdate/);
  assert.match(card, /applyDesktopUpdate/);
  assert.doesNotMatch(card, /target="_blank"/);
  assert.doesNotMatch(card, /window\.open/);
  assert.match(packageJson.scripts["build:desktop:web"], /VITE_DESKTOP=true/);
  assert.doesNotMatch(packageJson.scripts.dev, /VITE_DESKTOP=true/);
  assert.doesNotMatch(packageJson.scripts.build, /VITE_DESKTOP=true/);
});
