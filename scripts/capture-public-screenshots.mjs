#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { toCrossJSON } from "seroval";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

for (const key of [
  "BROWSER_ALLOW_EXTERNAL_HOST",
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
]) {
  delete process.env[key];
}
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = checkedUrl(process.argv[2] || "http://127.0.0.1:4780/");
const OUTPUT_ROOTS = [resolve(ROOT, "screenshots"), resolve("/tmp")];
const OUTPUT_DIR = checkedOutputPath(
  resolve(process.argv[3] || resolve(ROOT, "screenshots")),
  OUTPUT_ROOTS,
);
const EXPECTED_TITLE_PREFIX = "余量 / Balance";
const SPECS = [
  {
    name: "desktop-light",
    theme: "light",
    viewport: { width: 1280, height: 900 },
    file: "claude-grok-quota-desktop.png",
    maxHeight: 5000,
  },
  {
    name: "desktop-dark",
    theme: "dark",
    viewport: { width: 1280, height: 900 },
    file: "claude-grok-quota-desktop-dark.png",
    maxHeight: 5000,
  },
];
const EXPECTED_README_IMAGES = SPECS.map((spec) => "screenshots/" + spec.file);
const DEV_AVAILABILITY_ID = "cHVsbEFnZW50QXZhaWxhYmlsaXR5";
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const fetchedAt = Date.now();
const publicSlice = (agent, windowPct, weekPct, planLabel, source, windowKind) => ({
  agent,
  windowPct,
  weekPct,
  windowResetsAt: null,
  weekResetsAt: null,
  weekStartedAt: null,
  windowDurationMs: windowKind === "five_hour" ? FIVE_HOUR_MS : WEEK_MS,
  weekDurationMs: WEEK_MS,
  burnPctPerHour: 0,
  planLabel,
  products: [],
  prepaidBalance: null,
  onDemandUsed: null,
  onDemandCap: null,
  source,
  fetchedAt,
  windowKind,
});
const publicPersistedState = {
  state: {
    onboardingComplete: true,
    demoMode: true,
    adapterHint: true,
    agentAvailability: { claude: true, grok: true, codex: true, antigravity: false },
    captureEnabled: { claude: true, grok: true, codex: true, antigravity: false },
    claudePlanId: "claude-max-20x",
    grokPlanId: "grok-super",
    codexPlanId: "chatgpt-plus",
    official: {
      claude: {
        ...publicSlice("claude", 24, 34, "Claude Max", "oauth-usage", "five_hour"),
        modelWeekLimits: { fable: { usedPct: 26, resetsAt: null } },
      },
      grok: publicSlice("grok", 37, 37, "SuperGrok", "billing-api", "weekly"),
      codex: publicSlice("codex", 32, 32, "ChatGPT Plus", "wham-usage", "weekly"),
      antigravity: null,
    },
  },
  version: 0,
};
const SENSITIVE = [
  /\/Users\//i,
  /\/Volumes\//i,
  /\/home\//i,
  /[A-Z]:[\\/]+Users[\\/]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/i,
  /AI_Agent_MultiTenant_Workstation|simverse-world|deepseek-harness/i,
];

function pngSize(path) {
  const png = readFileSync(path);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", path + " is not PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function assertReadmeContract() {
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  const images = [...readme.matchAll(/src="\.\/(screenshots\/[^"?]+\.png)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(images, EXPECTED_README_IMAGES, "README public image set changed");
  assert.ok(!readme.includes("claude-grok-quota-production.png"));
}

function assertPrivateTextAbsent(surface) {
  for (const pattern of SENSITIVE) assert.doesNotMatch(surface, pattern);
}

function productionServerFnIds(name) {
  const ids = [];
  for (const directory of [
    resolve(ROOT, ".output/server/_ssr"),
    resolve(ROOT, ".vercel/output/functions/__server.func/_ssr"),
    "/Applications/Balance.app/Contents/Resources/balance-server/server/_ssr",
  ]) {
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter(
      (entry) => entry.startsWith("routes-") && entry.endsWith(".mjs"),
    )) {
      const source = readFileSync(resolve(directory, file), "utf8");
      const match = source.match(
        new RegExp(`var ${name} = [^;]+createSsrRpc\\("([a-f0-9]{64})"\\)`),
      );
      if (match?.[1]) ids.push(match[1]);
    }
  }
  return ids;
}

const AVAILABILITY_IDS = new Set([
  DEV_AVAILABILITY_ID,
  ...productionServerFnIds("pullAgentAvailability"),
]);

function isAvailabilityRequest(request) {
  if (request.method() !== "GET") return false;
  try {
    const pathname = new URL(request.url()).pathname;
    const prefix = "/_serverFn/";
    if (!pathname.startsWith(prefix)) return false;
    const encoded = pathname.slice(prefix.length).split("/")[0];
    const id = decodeURIComponent(encoded);
    if (AVAILABILITY_IDS.has(id)) return true;
    const decoded = Buffer.from(id, "base64url").toString("utf8");
    return decoded === "pullAgentAvailability" || decoded.includes("pullAgentAvailability");
  } catch {
    return false;
  }
}

function cardAround(page, heading) {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
}

async function capture(browser, spec) {
  const context = await browser.newContext({
    viewport: spec.viewport,
    locale: "zh-CN",
    colorScheme: spec.theme,
  });
  await context.addInitScript(
    ({ persistedState, theme }) => {
      try {
        localStorage.setItem("balance-quota-v8", JSON.stringify(persistedState));
        localStorage.setItem("remain-theme", theme);
        const root = document.documentElement;
        if (root) {
          root.dataset.theme = theme;
          root.style.colorScheme = theme;
        }
        sessionStorage.clear();
      } catch {
        /* about:blank may not have a documentElement yet */
      }
    },
    { persistedState: publicPersistedState, theme: spec.theme },
  );
  await context.route(/https:\/\/(grok\.com|fonts\.(gstatic|googleapis)\.com)\//, async (route) => {
    const type = route.request().resourceType();
    await route.fulfill({
      status: 200,
      contentType:
        type === "script"
          ? "application/javascript"
          : type === "stylesheet"
            ? "text/css"
            : "application/octet-stream",
      body: "",
    });
  });
  let availabilityIntercepted = false;
  await context.route("**/_serverFn/**", async (route) => {
    const request = route.request();
    if (!availabilityIntercepted && isAvailabilityRequest(request)) {
      availabilityIntercepted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: JSON.stringify(
          toCrossJSON({
            result: { claude: true, grok: true, codex: true, antigravity: false },
            error: undefined,
            context: {},
          }),
        ),
      });
      return;
    }
    await route.continue();
  });
  const errors = { console: [], page: [], request: [], http: [] };
  const networkSurface = [];
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(String(error?.message || error)));
  page.on("request", (request) => {
    const raw = request.url() + "\n" + (request.postData() || "");
    try {
      networkSurface.push(decodeURIComponent(raw));
    } catch {
      networkSurface.push(raw);
    }
  });
  page.on("requestfailed", (request) => {
    errors.request.push(
      request.method() + " " + request.url() + " " + (request.failure()?.errorText || "failed"),
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.http.push(
        response.status() + " " + response.request().method() + " " + response.url(),
      );
    }
  });

  try {
    const response = await page.goto(BASE, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200);
    assert.ok((await page.title()).startsWith(EXPECTED_TITLE_PREFIX));
    await page.getByText("余量", { exact: true }).waitFor();
    assert.ok(
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(response.url()).hostname),
    );
    for (const agent of ["Claude Code", "Grok", "Codex"]) {
      await page.getByRole("heading", { name: agent, exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "重置演示" }).waitFor();
    await page.getByText("当前是演示数据。", { exact: false }).waitFor();
    const themeToggleName = spec.theme === "dark" ? "切换亮色" : "切换暗色";
    await page.getByRole("button", { name: themeToggleName }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      spec.theme,
    );
    const pause = page.getByRole("button", { name: "全部暂停" });
    await pause.click();
    await page.getByRole("button", { name: "开始协同" }).waitFor();
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const raw = localStorage.getItem("balance-quota-v8");
      return raw ? JSON.parse(raw)?.state : null;
    });
    assert.equal(state?.demoMode, true);
    assert.equal(state?.onboardingComplete, true);
    assert.equal(availabilityIntercepted, true);
    const claudeCard = cardAround(page, "Claude Code");
    for (const text of [
      "5 小时窗（官方）",
      "本周额度（官方）",
      "Fable 5 周额度（官方）",
      "24%",
      "34%",
      "26%",
    ]) {
      await claudeCard.getByText(text, { exact: true }).first().waitFor();
    }
    await cardAround(page, "Grok").getByText("37%", { exact: true }).first().waitFor();
    await cardAround(page, "Codex").getByText("32%", { exact: true }).first().waitFor();
    const surface = await page.evaluate(() => {
      const attributes = [...document.querySelectorAll("*")]
        .flatMap((element) =>
          [...element.attributes]
            .filter((attribute) => !/\/(?:src|node_modules)\//.test(attribute.value))
            .map((attribute) => attribute.value),
        )
        .join("\n");
      return (
        document.body.innerText +
        "\n" +
        attributes +
        "\n" +
        (localStorage.getItem("balance-quota-v8") || "")
      );
    });
    assertPrivateTextAbsent(surface + "\n" + networkSurface.join("\n"));
    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert.equal(metrics.innerWidth, spec.viewport.width);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth, JSON.stringify(metrics));
    assert.deepEqual(errors, { console: [], page: [], request: [], http: [] });

    const path = checkedOutputPath(resolve(OUTPUT_DIR, spec.file), OUTPUT_ROOTS);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: true });
    const size = pngSize(path);
    assert.equal(size.width, spec.viewport.width);
    assert.ok(size.height > spec.viewport.height, JSON.stringify(size));
    assert.ok(size.height <= spec.maxHeight, JSON.stringify(size));
    return { name: spec.name, path, size, metrics, errors };
  } finally {
    await context.close();
  }
}

assertReadmeContract();
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];
try {
  for (const spec of SPECS) results.push(await capture(browser, spec));
} finally {
  await browser.close();
}
writeFileSync(
  "/tmp/balance-public-screenshots.json",
  JSON.stringify({ base: BASE, results }, null, 2) + "\n",
);
console.log(JSON.stringify({ base: BASE, results }, null, 2));
