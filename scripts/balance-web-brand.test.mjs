import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("web surfaces use the Balance brand", () => {
  const rootRoute = read("src/routes/__root.tsx");
  assert.match(rootRoute, /const APP_NAME = "Balance";/);
  assert.match(rootRoute, /余量 \/ Balance — Claude × Grok × Codex 额度监控/);
  assert.doesNotMatch(rootRoute, /Synq — Claude/);

  const header = read("src/components/synq/header.tsx");
  assert.match(header, />余量<\/span>/);
  assert.doesNotMatch(header, />Synq<\/span>/);

  const onboarding = read("src/components/synq/onboarding.tsx");
  assert.match(onboarding, /余量初始设置/);
  assert.match(onboarding, /余量只检查本机数据目录/);
  assert.doesNotMatch(onboarding, /Synq 初始设置/);

  const settings = read("src/components/synq/settings-panel.tsx");
  assert.match(settings, /余量只读本机 Agent\s+日志/);
  assert.doesNotMatch(settings, /Synq 只读本机 Agent\s+日志/);
});

test("package and README publish the new product name", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  assert.equal(packageJson.name, "balance");
  assert.equal(packageLock.name, "balance");
  assert.equal(packageLock.packages[""].name, "balance");

  const readme = read("README.md");
  assert.match(readme, /^# 余量 \/ Balance$/m);
  assert.match(readme, /余量（Balance）是一个本地优先/);
  assert.match(readme, /alt="Balance desktop quota dashboard \(light\)"/);
  assert.match(readme, /alt="Balance desktop quota dashboard \(dark\)"/);
  assert.doesNotMatch(readme, /mobile quota dashboard/);
  assert.match(readme, /github\.com\/stakeswky\/Balance\/releases\/latest/);
  assert.match(readme, /`Balance_0\.1\.0_aarch64\.dmg`/);
  assert.doesNotMatch(readme, /`Synq-macos-arm64/);
});

test("onboarding browser assertions follow the new UI copy", () => {
  const e2e = read("scripts/onboarding-e2e.mjs");
  assert.match(e2e, /余量初始设置/);
  assert.match(e2e, /homepage is HTTP 200 with Balance title/);
  assert.match(e2e, /title\.includes\("Balance"\)/);
  assert.doesNotMatch(e2e, /Synq 初始设置/);
});
