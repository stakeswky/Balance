import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("settings owns native CLI controls and the former plugin surface", async () => {
  const [settings, nativeSettings, plugin] = await Promise.all([
    source("src/components/balance/settings-panel.tsx"),
    source("src/components/balance/native-agent-settings.tsx"),
    source("src/components/balance/plugin-panel.tsx"),
  ]);
  assert.match(settings, /SettingsPanel\(\{ agents \}/);
  assert.match(settings, /<NativeAgentSettings/);
  assert.match(settings, /<PluginPanel agents=\{agents\}/);
  assert.match(nativeSettings, /getNativeAgentSettings/);
  assert.match(nativeSettings, /saveNativeAgentSettings/);
  assert.match(nativeSettings, /detectNativeAgentRuntimes/);
  assert.match(nativeSettings, /保存并检测/);
  assert.match(nativeSettings, /每个 Agent\s+同时只运行 1 个任务/);
  assert.match(plugin, /高级导入与协议/);
});

test("only Claude, Codex and Grok native CLI rows are configured", async () => {
  const nativeSettings = await source("src/components/balance/native-agent-settings.tsx");
  for (const value of ["claude", "codex", "grok"]) {
    assert.match(nativeSettings, new RegExp(`${value}:`));
  }
  assert.match(nativeSettings, /Claude Code/);
  assert.match(nativeSettings, /Codex CLI/);
  assert.match(nativeSettings, /Grok CLI/);
  assert.match(nativeSettings, /globalMaxConcurrency/);
  assert.match(nativeSettings, /<option value=\{1\}>1<\/option>/);
  assert.match(nativeSettings, /<option value=\{2\}>2<\/option>/);
  assert.match(nativeSettings, /<option value=\{3\}>3<\/option>/);
  assert.doesNotMatch(nativeSettings, /npm install|brew install|自动安装/);
});

test("plugin is removed from top-level navigation but all original advanced tools remain", async () => {
  const [header, dashboard, plugin] = await Promise.all([
    source("src/components/balance/header.tsx"),
    source("src/components/balance/dashboard.tsx"),
    source("src/components/balance/plugin-panel.tsx"),
  ]);
  assert.doesNotMatch(header, /id: "plugin"|label: "插件"/);
  assert.doesNotMatch(dashboard, /view === "plugin"/);
  assert.match(dashboard, /<SettingsPanel agents=\{visibleAgents\}/);
  for (const preserved of ["适配器", "导入用量", "并入额度", "载入 Claude 导出", "事件协议"]) {
    assert.match(plugin, new RegExp(preserved));
  }
});

test("native settings keeps path editing inert until explicit save and exposes failures", async () => {
  const nativeSettings = await source("src/components/balance/native-agent-settings.tsx");
  assert.doesNotMatch(nativeSettings, /onBlur=/);
  assert.match(nativeSettings, /runtime\.version/);
  assert.match(nativeSettings, /runtime\?\.error/);
  assert.match(nativeSettings, /toast\.success/);
  assert.match(nativeSettings, /toast\.error/);
  assert.match(nativeSettings, /disabled=\{saving \|\| loading\}/);
});

test("orchestrator UI source contains no retired fourth agent name", async () => {
  const paths = [
    "src/components/balance/settings-panel.tsx",
    "src/components/balance/native-agent-settings.tsx",
    "src/components/balance/plugin-panel.tsx",
    "src/lib/orchestrator/planner.server.ts",
  ];
  const combined = (await Promise.all(paths.map(source))).join("\n");
  const retiredName = ["ge", "mini"].join("");
  assert.equal(combined.toLowerCase().includes(retiredName), false);
});
