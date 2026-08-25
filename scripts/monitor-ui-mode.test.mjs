import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("settings expose geek mode as the opt-in full dashboard", () => {
  const settings = read("src/components/balance/settings-panel.tsx");
  assert.match(settings, /CardTitle>极客模式</);
  assert.match(settings, /aria-label="极客模式"/);
  assert.match(settings, /checked=\{!minimalMode\}/);
  assert.match(settings, /已开启极客模式/);
  assert.match(settings, /已恢复简约模式/);
  assert.doesNotMatch(settings, /CardTitle>简约模式</);
  assert.doesNotMatch(settings, /aria-label="简约模式"/);
  assert.doesNotMatch(settings, /完整模式/);
});

test("collaboration plan keeps title and tips on one row", () => {
  const advice = read("src/components/balance/advice-card.tsx");
  const timeline = read("src/components/balance/timeline.tsx");
  assert.match(advice, /grid-cols-\[4\.5rem_1fr\]/);
  assert.match(timeline, /grid-cols-\[4\.5rem_1fr\]/);
  assert.match(advice, /truncate text-sm/);
  assert.doesNotMatch(advice, /sm:grid-cols-2/);
  assert.doesNotMatch(advice, /CardHint/);
});

test("secondary monitor descriptions move into accessible hover help", () => {
  const help = read("src/components/ui/inline-help.tsx");
  const dashboard = read("src/components/balance/dashboard.tsx");
  const agentCard = read("src/components/balance/agent-card.tsx");
  assert.match(help, /role="img"/);
  assert.match(help, /aria-label=\{label\}/);
  assert.match(help, /title=\{label\}/);
  assert.match(help, /tabIndex=\{0\}/);
  assert.match(dashboard, /<InlineHelp/);
  assert.match(dashboard, /协同时间线：/);
  assert.match(dashboard, /近 24 小时 token：/);
  assert.match(agentCard, /套餐：\$\{planName\}/);
  assert.match(agentCard, /配置路径：\$\{adapter\}/);
});

test("minimal primary reset keeps absolute time in hover help", () => {
  const agentCard = read("src/components/balance/agent-card.tsx");
  assert.match(agentCard, /<time/);
  assert.match(agentCard, /title=\{primaryResetHint\.title\}/);
  assert.match(
    agentCard,
    /aria-label=\{`\$\{primaryResetHint\.label\}，\$\{primaryResetHint\.title\}`\}/,
  );
});

test("tray popup highlights which subscription to use now", () => {
  const tray = read("src/components/balance/tray-dashboard.tsx");
  assert.match(tray, /现在该用/);
  assert.match(tray, />推荐</);
  assert.match(tray, /pickPreferredSubscription/);
  assert.match(tray, /function WeekRow[\s\S]*?const used = row\.usedPct;/);
  assert.match(tray, /function WeekRow[\s\S]*?const remain = row\.remainPct;/);
  assert.doesNotMatch(tray, /function WeekRow[\s\S]*?const used = subscriptionLoad\(row\)/);
  assert.match(tray, /overflow-hidden/);
  assert.doesNotMatch(tray, /RemainRing/);
});

test("monitor cards and dashboard use compact spacing", () => {
  const card = read("src/components/ui/card.tsx");
  const dashboard = read("src/components/balance/dashboard.tsx");
  assert.match(card, /p-3 shadow-\[var\(--shadow-border\)\] sm:p-4/);
  assert.match(dashboard, /h-dvh overflow-hidden/);
  assert.match(dashboard, /flex h-full flex-col justify-between/);
  assert.match(dashboard, /flex flex-col gap-4/);
  assert.doesNotMatch(dashboard, /self-start/);
  assert.doesNotMatch(dashboard, /space-y-5/);
});

test("Antigravity uses an official-only card with its own visual tone", () => {
  const dashboard = read("src/components/balance/dashboard.tsx");
  const agentCard = read("src/components/balance/agent-card.tsx");
  const settings = read("src/components/balance/settings-panel.tsx");
  const plans = read("src/components/balance/plans-panel.tsx");
  const styles = read("src/styles.css");
  assert.match(dashboard, /name="Antigravity"/);
  assert.match(dashboard, /officialOnly/);
  assert.match(agentCard, /!officialOnly && onToggle/);
  assert.match(settings, /antigravityAvailable=\{visibleAgents\.includes\("antigravity"\)\}/);
  assert.match(plans, /const planCount = agents\.length \+ Number\(antigravityAvailable\)/);
  assert.match(plans, /planCount > 0/);
  assert.match(plans, /Antigravity 套餐/);
  assert.match(plans, /官方额度（自动读取）/);
  assert.match(plans, /无需选择/);
  assert.doesNotMatch(plans, /ANTIGRAVITY_PLANS/);
  assert.match(styles, /--color-antigravity:/);
  assert.match(styles, /--antigravity:/);
});
