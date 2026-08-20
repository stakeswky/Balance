#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { toCrossJSON } from "seroval";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

for (const key of [
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

const BASE = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const SHOT_DIR = resolve(process.argv[3] || "screenshots");
const ONLY_CASE = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
mkdirSync(SHOT_DIR, { recursive: true });

const AVAILABILITY_ID = "cHVsbEFnZW50QXZhaWxhYmlsaXR5";
const OFFICIAL_ID = "cHVsbE9mZmljaWFsUXVvdGE";
const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
};

const report = {
  base: BASE,
  passed: 0,
  failed: 0,
  cases: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  httpErrors: [],
};

function serialized(result) {
  return JSON.stringify(toCrossJSON({ result, error: undefined, context: {} }));
}

function officialSlice(partial = {}) {
  return {
    agent: "claude",
    windowPct: 24,
    weekPct: 34,
    windowResetsAt: null,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: 5 * 60 * 60 * 1000,
    weekDurationMs: 7 * 24 * 60 * 60 * 1000,
    burnPctPerHour: 0,
    planLabel: "Claude Max",
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    modelWeekLimits: {
      fable: { usedPct: 26, resetsAt: null },
    },
    source: "oauth-usage",
    fetchedAt: Date.now(),
    windowKind: "five_hour",
    ...partial,
  };
}

const SCENARIOS = {
  loading: {
    mode: "hold",
    present: [
      "正在读取官方额度；当前显示本地估算。",
      "本地估算窗口剩余",
      "5 小时窗用量（本地估算）",
      "本周用量（本地估算）",
      "本地估算",
    ],
    absent: ["5 小时窗（官方）", "本周额度（官方）"],
  },
  full: {
    official: { claude: officialSlice(), grok: null, codex: null },
    present: [
      "官方窗口剩余",
      "5 小时窗（官方）",
      "本周额度（官方）",
      "Fable 5 周额度（官方）",
      "24%",
      "34%",
      "26%",
    ],
    absent: ["当前显示本地估算", "官方快照"],
  },
  partial: {
    official: {
      claude: officialSlice({ windowPct: null, modelWeekLimits: undefined }),
      grok: null,
      codex: null,
    },
    present: [
      "部分官方额度暂未返回；缺失项显示本地估算。",
      "本地估算窗口剩余",
      "5 小时窗用量（本地估算）",
      "本周额度（官方）",
      "34%",
      "充足",
    ],
    absent: ["5 小时窗（官方）", "Fable 5 周额度（官方）"],
  },
  stale: {
    official: {
      claude: officialSlice({
        windowPct: 96,
        weekPct: 95,
        modelWeekLimits: {
          fable: { usedPct: 94, resetsAt: null },
        },
        windowStale: true,
        weekStale: true,
        modelWeekLimitsStale: true,
      }),
      grok: null,
      codex: null,
    },
    present: [
      "官方接口暂不可用；标为“官方快照”的值来自上次成功读取。",
      "官方快照窗口剩余",
      "5 小时窗（官方快照）",
      "本周额度（官方快照）",
      "Fable 5 周额度（官方快照）",
      "96%",
      "95%",
      "94%",
      "官方快照",
    ],
    absent: ["5 小时窗（官方）", "本周额度（官方）", "将尽"],
    expectNoAlerts: true,
  },
  error: {
    mode: "error",
    present: [
      "官方额度读取失败；当前显示本地估算。",
      "本地估算窗口剩余",
      "5 小时窗用量（本地估算）",
      "本周用量（本地估算）",
      "本地估算",
    ],
    absent: ["5 小时窗（官方）", "本周额度（官方）"],
  },
};

function isRequest(request, id, name) {
  const url = request.url();
  if (request.method() !== "GET" || !url.includes("/_serverFn/")) return false;
  if (url.includes(id) || url.includes(name)) return true;
  try {
    const encoded = new URL(url).pathname.split("/_serverFn/")[1]?.split("/")[0];
    const decoded = encoded
      ? Buffer.from(decodeURIComponent(encoded), "base64url").toString("utf8")
      : "";
    return decoded.includes(name);
  } catch {
    return false;
  }
}

function cardAround(page, heading) {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
}

function shotPath(name) {
  return checkedOutputPath(resolve(SHOT_DIR, name), [resolve("screenshots"), SHOT_DIR]);
}

async function runScenario(browser, scenarioName, viewportName) {
  const scenario = SCENARIOS[scenarioName];
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewportName],
    locale: "zh-CN",
  });
  const held = [];
  await context.addInitScript(() => {
    localStorage.setItem(
      "synq-quota-v8",
      JSON.stringify({
        state: {
          onboardingComplete: true,
          demoMode: false,
          adapterHint: false,
          agentAvailability: { claude: true, grok: false, codex: false },
          captureEnabled: { claude: true, grok: false, codex: false },
          events: [],
          realEvents: [],
          liveClaude: false,
          liveGrok: false,
          liveCodex: false,
          official: { claude: null, grok: null, codex: null },
        },
        version: 0,
      }),
    );
  });
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
  await context.route("**/_serverFn/**", async (route) => {
    const request = route.request();
    if (isRequest(request, AVAILABILITY_ID, "pullAgentAvailability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized({ claude: true, grok: false, codex: false }),
      });
      return;
    }
    if (isRequest(request, OFFICIAL_ID, "pullOfficialQuota")) {
      if (scenario.mode === "error") {
        await route.abort("internetdisconnected");
        return;
      }
      if (scenario.mode === "hold") {
        await new Promise((resolveHold) => held.push(resolveHold));
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized(scenario.official ?? { claude: null, grok: null, codex: null }),
      });
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  const diagnostics = { consoleErrors: [], pageErrors: [], requestFailures: [], httpErrors: [] };
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (scenario.mode === "error" && message.text().includes("ERR_INTERNET_DISCONNECTED")) return;
    diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error?.message || error)));
  page.on("requestfailed", (request) => {
    if (scenario.mode === "error" && isRequest(request, OFFICIAL_ID, "pullOfficialQuota")) return;
    diagnostics.requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  try {
    const response = await page.goto(BASE, { waitUntil: "domcontentloaded" });
    if (response?.status() !== 200) throw new Error(`homepage status ${response?.status()}`);
    const card = cardAround(page, "Claude Code");
    await card.waitFor();
    for (const text of scenario.present) {
      await card.getByText(text, { exact: true }).first().waitFor();
    }
    for (const text of scenario.absent) {
      if (await card.getByText(text, { exact: true }).count()) {
        throw new Error(`unexpected text: ${text}`);
      }
    }
    if (scenario.expectNoAlerts) {
      const alertCount = await page.evaluate(() => {
        const raw = localStorage.getItem("synq-quota-v8");
        return raw ? (JSON.parse(raw)?.state?.alerts?.length ?? 0) : 0;
      });
      if (alertCount !== 0) throw new Error(`stale quota emitted ${alertCount} alerts`);
    }
    const size = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    if (size.scrollWidth > size.clientWidth) {
      throw new Error(`horizontal overflow ${size.scrollWidth} > ${size.clientWidth}`);
    }
    if (
      diagnostics.consoleErrors.length ||
      diagnostics.pageErrors.length ||
      diagnostics.requestFailures.length ||
      diagnostics.httpErrors.length
    ) {
      throw new Error(JSON.stringify(diagnostics));
    }
    if ((scenarioName === "full" || scenarioName === "stale") && viewportName === "desktop") {
      await page.screenshot({
        path: shotPath(`quota-source-${scenarioName}-${viewportName}.png`),
        fullPage: true,
      });
    }
    report.consoleErrors.push(...diagnostics.consoleErrors);
    report.pageErrors.push(...diagnostics.pageErrors);
    report.requestFailures.push(...diagnostics.requestFailures);
    report.httpErrors.push(...diagnostics.httpErrors);
  } finally {
    while (held.length) held.shift()();
    await context.close();
  }
}

const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  for (const viewportName of Object.keys(VIEWPORTS)) {
    for (const scenarioName of Object.keys(SCENARIOS)) {
      const name = `${scenarioName}-${viewportName}`;
      if (ONLY_CASE && ONLY_CASE !== name) continue;
      try {
        await runScenario(browser, scenarioName, viewportName);
        report.passed += 1;
        report.cases.push({ name, ok: true });
        console.log(`PASS ${name}`);
      } catch (error) {
        report.failed += 1;
        report.cases.push({ name, ok: false, error: String(error?.message || error) });
        console.error(`FAIL ${name} — ${String(error?.message || error)}`);
      }
    }
  }
} finally {
  await browser.close();
}

const reportPath = "/tmp/synq-quota-source-e2e.json";
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report ${reportPath}`);
if (report.failed) process.exit(1);
