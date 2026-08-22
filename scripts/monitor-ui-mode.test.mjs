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

test("monitor cards and dashboard use compact spacing", () => {
  const card = read("src/components/ui/card.tsx");
  const dashboard = read("src/components/balance/dashboard.tsx");
  assert.match(card, /p-3 shadow-\[var\(--shadow-border\)\] sm:p-4/);
  assert.match(dashboard, /h-dvh overflow-hidden/);
  assert.match(dashboard, /flex h-full flex-col/);
  assert.doesNotMatch(dashboard, /self-start/);
  assert.doesNotMatch(dashboard, /space-y-5/);
});
