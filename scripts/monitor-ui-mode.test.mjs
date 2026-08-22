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
