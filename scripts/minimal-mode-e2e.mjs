#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const BASE = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshot = checkedOutputPath(
  resolve(repoRoot, "screenshots", "minimal-mode-full.png"),
  [repoRoot],
);
mkdirSync(dirname(screenshot), { recursive: true });

function cardAround(page, heading) {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
}

async function seedDemo(page) {
  await page.goto(BASE, { waitUntil: "commit" });
  await page.evaluate(() => {
    localStorage.setItem(
      "balance-quota-v8",
      JSON.stringify({
        state: {
          onboardingComplete: true,
          demoMode: true,
          minimalMode: false,
          adapterHint: true,
          agentAvailability: { claude: true, grok: true, codex: true },
        },
        version: 0,
      }),
    );
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "监控", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
}

const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await seedDemo(page);

  const timeline = cardAround(page, "协同时间线");
  await timeline.getByRole("heading", { name: "协同计划", exact: true }).waitFor();
  assert.equal(await timeline.getByText("5 小时滚动窗", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "协同建议", exact: true }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "实时流水", exact: true }).count(), 1);

  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();
  console.log("PASS collaboration plan is embedded in the timeline card");
} finally {
  await browser.close();
}
