#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]) {
  delete process.env[key];
}
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const BASE = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const SHOT_DIR = resolve(process.argv[3] || "screenshots");
const PROD = process.argv.includes("--prod");
mkdirSync(SHOT_DIR, { recursive: true });

const DEMO_TASKS = [
  "重构鉴权中间件",
  "接 Grok 会话日志",
  "生成 API client",
  "三路时间线",
  "写 SuperGrok 套餐",
];

const SENTINEL_SAMPLE = {
  windowId: "e2e-sentinel-window",
  agent: "claude",
  product: null,
  timestampMs: 1_700_000_000_000,
  usedPercent: 10,
  cumulativeObservedUsd: 1,
  pricedTokenCoverage: 1,
  modelMix: {},
  pricingVersion: "e2e",
};

const report = {
  base: BASE,
  passed: 0,
  failed: 0,
  cases: [],
  availabilityUrl: null,
  availabilityBody: null,
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  httpErrors: [],
};

function shotPath(name) {
  return checkedOutputPath(resolve(SHOT_DIR, name), [resolve("screenshots"), SHOT_DIR]);
}

function serializeAvailability(avail) {
  const flag = (on) => (on ? { t: 2, s: 2 } : { t: 2, s: 3 });
  return JSON.stringify({
    t: 10,
    i: 0,
    p: {
      k: ["result", "error", "context"],
      v: [
        {
          t: 10,
          i: 1,
          p: {
            k: ["claude", "grok", "codex"],
            v: [flag(avail.claude), flag(avail.grok), flag(avail.codex)],
          },
          o: 0,
        },
        { t: 2, s: 1 },
        { t: 11, i: 2, p: { k: [], v: [] }, o: 0 },
      ],
    },
    o: 0,
  });
}

function isAvailabilityRequest(request) {
  const url = request.url();
  if (!url.includes("/_serverFn/") || request.method() !== "GET") return false;
  return (
    url.includes("cHVsbEFnZW50QXZhaWxhYmlsaXR5") || url.includes("pullAgentAvailability")
  );
}

function attachDiagnostics(page, bucket) {
  page.on("console", (msg) => {
    if (msg.type() === "error") bucket.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    bucket.pageErrors.push(String(err?.message || err));
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText || "failed";
    if (failure.includes("net::ERR_FAILED") && isAvailabilityRequest(req)) return;
    bucket.requestFailures.push(`${req.method()} ${req.url()} ${failure}`);
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status >= 400) bucket.httpErrors.push(`${status} ${res.request().method()} ${res.url()}`);
  });
}

async function newPage(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    locale: "zh-CN",
  });
  await context.clearCookies();
  await context.route(/https:\/\/(grok\.com|fonts\.(gstatic|googleapis)\.com)\//, async (route) => {
    const type = route.request().resourceType();
    await route.fulfill({
      status: 200,
      contentType: type === "script" ? "application/javascript" : type === "stylesheet" ? "text/css" : "application/octet-stream",
      body: "",
    });
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(20_000);
  page.setDefaultTimeout(20_000);
  const bucket = { consoleErrors: [], pageErrors: [], requestFailures: [], httpErrors: [] };
  attachDiagnostics(page, bucket);
  return { context, page, bucket };
}

async function clearOriginStorage(page) {
  await page.goto(BASE, { waitUntil: "commit" });
  await page.evaluate(() => {
    localStorage.removeItem("synq-quota-v8");
    sessionStorage.clear();
  });
}

async function seedPersist(page, patch) {
  await page.goto(BASE, { waitUntil: "commit" });
  await page.evaluate((next) => {
    const raw = localStorage.getItem("synq-quota-v8");
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    parsed.state = { ...(parsed.state || {}), ...next };
    localStorage.setItem("synq-quota-v8", JSON.stringify(parsed));
  }, patch);
}

async function interceptAvailability(page, options = {}) {
  let seen = 0;
  const held = [];
  await page.route("**/_serverFn/**", async (route) => {
    const request = route.request();
    if (!isAvailabilityRequest(request)) {
      await route.continue();
      return;
    }
    seen += 1;
    report.availabilityUrl ??= request.url();
    if (options.failFirst && seen === 1) {
      await route.abort("internetdisconnected");
      return;
    }
    if (options.hold && seen === 1) {
      await new Promise((resolve) => held.push(resolve));
    }
    if (options.payload) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serializeAvailability(options.payload),
      });
      return;
    }
    await route.continue();
  });
  return {
    seen: () => seen,
    release: () => {
      while (held.length) held.shift()();
    },
  };
}

async function startFresh(page, interceptOptions) {
  await clearOriginStorage(page);
  const hook = interceptOptions ? await interceptAvailability(page, interceptOptions) : { seen: () => 0, release() {} };
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  return hook;
}

async function waitForOnboarding(page) {
  await page.getByText("Synq 初始设置").waitFor({ timeout: 20_000 });
}

async function enterWorkbench(page) {
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "监控" }).waitFor({ timeout: 20_000 });
}

async function openView(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}

function cardAround(page, heading) {
  return page.getByRole("heading", { name: heading, exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function persistState(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("synq-quota-v8");
    return raw ? JSON.parse(raw) : null;
  });
}

async function bodyText(page) {
  return page.locator("body").innerText();
}

function record(name, ok, details) {
  report.cases.push({ name, ok, details });
  if (ok) report.passed += 1;
  else report.failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${details ? ` — ${details}` : ""}`);
}

async function assertCase(name, fn) {
  try {
    const details = await fn();
    record(name, true, details || "");
  } catch (error) {
    record(name, false, String(error?.message || error));
  }
}

const LABELS = {
  claude: { card: "Claude Code", lane: "Claude", plan: "Claude Code 套餐", reportPlan: "若换 Claude 套餐", reportShare: "Claude 模型占比", import: "默认 Claude" },
  grok: { card: "Grok", lane: "Grok", plan: "Grok 套餐", reportPlan: "若换 Grok 套餐", reportShare: "Grok 模型占比", import: "默认 Grok" },
  codex: { card: "Codex", lane: "Codex", plan: "Codex 套餐", reportPlan: "若换 Codex 套餐", reportShare: "Codex 模型占比", import: "默认 Codex" },
};

async function assertOneAgent(page, agent) {
  const present = LABELS[agent];
  const hidden = Object.entries(LABELS)
    .filter(([id]) => id !== agent)
    .map(([, value]) => value);
  await page.getByText("1 路 Agent 额度").waitFor({ timeout: 15_000 });
  await page.getByRole("heading", { name: present.card, exact: true }).waitFor();
  const timeline = cardAround(page, "协同时间线");
  await timeline.getByText(present.lane, { exact: true }).waitFor();
  for (const other of hidden) {
    if (await timeline.getByText(other.lane, { exact: true }).count()) {
      throw new Error(`timeline still shows ${other.lane}`);
    }
  }
  const grokSeries = await page.locator('path[stroke="var(--color-grok)"]').count();
  const claudeSeries = await page.locator('path[stroke="var(--color-claude)"]').count();
  const codexSeries = await page.locator('path[stroke="var(--color-codex)"]').count();
  if (agent === "claude" && (grokSeries || codexSeries)) throw new Error("chart still has Grok/Codex series");
  if (agent === "grok" && (claudeSeries || codexSeries)) throw new Error("chart still has Claude/Codex series");
  if (agent === "codex" && (claudeSeries || grokSeries)) throw new Error("chart still has Claude/Grok series");

  const advice = page.locator("main").filter({ hasText: "节奏" });
  const adviceText = (await advice.count()) ? await page.locator("main").innerText() : await bodyText(page);
  for (const other of hidden) {
    if (adviceText.includes(`把重活交给 ${other.lane}`) || adviceText.includes(`${other.lane} 先歇`) || adviceText.includes(`${other.card} 切到`)) {
      throw new Error(`advice mentioned ${other.lane}`);
    }
  }

  const feed = cardAround(page, "实时流水");
  for (const other of hidden) {
    if (await feed.getByText(other.card, { exact: false }).count()) {
      throw new Error(`event feed mentioned ${other.card}`);
    }
  }
  const eventButton = feed.locator("button").first();
  if (await eventButton.count()) {
    await eventButton.click();
    const dialog = page.getByRole("dialog");
    if (await dialog.count()) {
      const dialogText = await dialog.innerText();
      for (const other of hidden) {
        if (dialogText.includes(other.card) || dialogText.includes(other.lane) && other.lane !== present.lane) {
          if (dialogText.includes(other.card)) throw new Error(`session dialog mentioned ${other.card}`);
        }
      }
      await page.keyboard.press("Escape");
    }
  }

  await openView(page, "设置");
  const capture = cardAround(page, "日志采集");
  await capture.getByText(present.card, { exact: true }).waitFor();
  for (const other of hidden) {
    if (await capture.getByText(other.card, { exact: true }).count()) {
      throw new Error(`capture settings still show ${other.card}`);
    }
  }
  await page.getByRole("heading", { name: present.plan, exact: true }).waitFor();
  for (const other of hidden) {
    if (await page.getByRole("heading", { name: other.plan, exact: true }).count()) {
      throw new Error(`plans still show ${other.plan}`);
    }
  }

  await openView(page, "插件");
  const adapters = cardAround(page, "适配器");
  await adapters.getByText(present.card === "Claude Code" ? "Claude Code" : present.card === "Grok" ? "Grok CLI / Grok Build" : "Codex CLI").waitFor();
  for (const other of hidden) {
    const adapterName = other.card === "Claude Code" ? "Claude Code" : other.card === "Grok" ? "Grok CLI / Grok Build" : "Codex CLI";
    if (await adapters.getByText(adapterName, { exact: true }).count()) {
      throw new Error(`adapter card still shows ${adapterName}`);
    }
  }
  const imports = cardAround(page, "导入用量");
  await imports.getByRole("button", { name: present.import }).waitFor();
  for (const other of hidden) {
    if (await imports.getByRole("button", { name: other.import }).count()) {
      throw new Error(`import targets still show ${other.import}`);
    }
  }

  await openView(page, "报告");
  await page.getByRole("heading", { name: present.reportPlan, exact: true }).waitFor();
  await page.getByRole("heading", { name: present.reportShare, exact: true }).waitFor();
  for (const other of hidden) {
    if (await page.getByRole("heading", { name: other.reportPlan, exact: true }).count()) {
      throw new Error(`report still shows ${other.reportPlan}`);
    }
    if (await page.getByRole("heading", { name: other.reportShare, exact: true }).count()) {
      throw new Error(`report still shows ${other.reportShare}`);
    }
  }
  await openView(page, "监控");
}

const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  await assertCase("dev homepage is HTTP 200 with Synq title", async () => {
    const { context, page } = await newPage(browser, { width: 1280, height: 900 });
    const response = await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const title = await page.title();
    const status = response?.status() ?? 0;
    if (status !== 200) throw new Error(`status ${status}`);
    if (!title.includes("Synq")) throw new Error(`title ${title}`);
    await context.close();
    return `${status} ${title}`;
  });

  await assertCase("first-run onboarding detects all three local agents", async () => {
    const { context, page, bucket } = await newPage(browser, { width: 1280, height: 900 });
    try {
      const hook = await startFresh(page, { hold: !PROD });
      await waitForOnboarding(page);
      if (!PROD) {
        await page.getByText("检测中").first().waitFor({ timeout: 5_000 });
        hook.release();
      }
      await page.getByText("已找到").nth(2).waitFor({ timeout: 20_000 });
      const foundCount = await page.getByText("已找到").count();
      if (foundCount < 3) throw new Error(`found labels ${foundCount}`);
      if (!PROD && hook.seen() < 1) throw new Error("availability request was not intercepted");
      await enterWorkbench(page);
      await page.getByText("3 路 Agent 额度").waitFor();
      for (const name of ["Claude Code", "Grok", "Codex"]) {
        await page.getByRole("heading", { name, exact: true }).waitFor();
      }
      await page.getByRole("heading", { name: "协同时间线" }).waitFor();
      await page.screenshot({ path: shotPath("onboarding-e2e-desktop.png"), fullPage: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "监控" }).waitFor({ timeout: 20_000 });
      if (await page.getByText("Synq 初始设置").count()) throw new Error("onboarding returned after refresh");
      report.consoleErrors.push(...bucket.consoleErrors);
      report.pageErrors.push(...bucket.pageErrors);
      report.requestFailures.push(...bucket.requestFailures);
      report.httpErrors.push(...bucket.httpErrors);
      if (bucket.pageErrors.length) throw new Error(`pageErrors ${bucket.pageErrors.join(" | ")}`);
      return `availability=${report.availabilityUrl}`;
    } finally {
      await context.close();
    }
  });

  await assertCase("demo mode rebuilds three synthetic agents and restores real logs", async () => {
    const { context, page, bucket } = await newPage(browser, { width: 1280, height: 900 });
    await startFresh(page, {});
    await waitForOnboarding(page);
    await page.getByText("已找到").nth(2).waitFor({ timeout: 20_000 });
    await enterWorkbench(page);
    await seedPersist(page, { quotaSamples: [SENTINEL_SAMPLE], onboardingComplete: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "设置" }).waitFor({ timeout: 20_000 });
    const before = await persistState(page);
    const beforeCount = before?.state?.quotaSamples?.length ?? 0;
    if (!before?.state?.quotaSamples?.some((item) => item.windowId === SENTINEL_SAMPLE.windowId)) {
      throw new Error("sentinel sample missing before demo toggle");
    }
    await openView(page, "设置");
    const demoSwitch = page.getByRole("switch", { name: "演示数据" });
    await demoSwitch.waitFor();
    const box = await demoSwitch.boundingBox();
    if (!box || box.height < 44 || box.width < 44) {
      throw new Error(`demo switch hit target ${JSON.stringify(box)}`);
    }
    if ((await demoSwitch.getAttribute("data-state")) !== "unchecked") {
      throw new Error("demo switch was not off by default");
    }
    await demoSwitch.click();
    await page.getByText("已开启演示数据").waitFor({ timeout: 10_000 });
    await openView(page, "监控");
    for (const name of ["Claude Code", "Grok", "Codex"]) {
      await page.getByRole("heading", { name, exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "重置演示" }).waitFor();
    await page.screenshot({ path: shotPath("onboarding-e2e-demo.png"), fullPage: true });
    const during = await persistState(page);
    if (during?.state?.demoMode !== true) throw new Error("demoMode was not persisted on");
    if ((during?.state?.quotaSamples?.length ?? 0) < beforeCount) {
      throw new Error("quotaSamples shrank after enabling demo");
    }
    if (!during.state.quotaSamples.some((item) => item.windowId === SENTINEL_SAMPLE.windowId)) {
      throw new Error("sentinel sample disappeared after enabling demo");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "重置演示" }).waitFor({ timeout: 20_000 });
    for (const name of ["Claude Code", "Grok", "Codex"]) {
      await page.getByRole("heading", { name, exact: true }).waitFor();
    }
    await openView(page, "设置");
    const afterReloadSwitch = page.getByRole("switch", { name: "演示数据" });
    if ((await afterReloadSwitch.getAttribute("data-state")) !== "checked") {
      throw new Error("demo switch did not stay on after refresh");
    }
    await afterReloadSwitch.click();
    await page.getByText("已恢复本机数据").waitFor({ timeout: 10_000 });
    if ((await afterReloadSwitch.getAttribute("data-state")) !== "unchecked") {
      throw new Error("demo switch did not turn off");
    }
    await openView(page, "监控");
    await page.waitForTimeout(2800);
    const text = await bodyText(page);
    if (text.includes("当前是演示数据") || (await page.getByRole("button", { name: "重置演示" }).count())) {
      throw new Error("demo chrome remained after turning demo off");
    }
    for (const task of DEMO_TASKS) {
      if (text.includes(task)) throw new Error(`synthetic task remained: ${task}`);
    }
    const after = await persistState(page);
    if (after?.state?.demoMode !== false) throw new Error("demoMode remained true");
    if ((after?.state?.quotaSamples?.length ?? 0) < beforeCount) {
      throw new Error("quotaSamples shrank after disabling demo");
    }
    if (!after.state.quotaSamples.some((item) => item.windowId === SENTINEL_SAMPLE.windowId)) {
      throw new Error("sentinel sample disappeared after disabling demo");
    }
    report.consoleErrors.push(...bucket.consoleErrors);
    report.pageErrors.push(...bucket.pageErrors);
    report.requestFailures.push(...bucket.requestFailures);
    report.httpErrors.push(...bucket.httpErrors);
    await context.close();
    return `samples ${beforeCount} -> ${after.state.quotaSamples.length}`;
  });

  for (const [name, payload] of PROD ? [] : [
    ["claude-only", { claude: true, grok: false, codex: false }],
    ["grok-only", { claude: false, grok: true, codex: false }],
    ["codex-only", { claude: false, grok: false, codex: true }],
  ]) {
    const agent = name.replace("-only", "");
    await assertCase(`${name} hides the other agents across monitor/settings/plugin/report`, async () => {
      const { context, page, bucket } = await newPage(browser, { width: 1280, height: 900 });
      await startFresh(page, { payload });
      await waitForOnboarding(page);
      await page.getByText("已找到").first().waitFor({ timeout: 20_000 });
      await enterWorkbench(page);
      await assertOneAgent(page, agent);
      if (name === "claude-only") {
        await page.screenshot({ path: shotPath("onboarding-e2e-one-agent.png"), fullPage: true });
      }
      report.consoleErrors.push(...bucket.consoleErrors);
      report.pageErrors.push(...bucket.pageErrors);
      report.requestFailures.push(...bucket.requestFailures);
      report.httpErrors.push(...bucket.httpErrors);
      await context.close();
    });
  }

  if (!PROD) await assertCase("zero agents shows recoverable empty states", async () => {
    const { context, page, bucket } = await newPage(browser, { width: 1280, height: 900 });
    await startFresh(page, { payload: { claude: false, grok: false, codex: false } });
    await waitForOnboarding(page);
    await page.getByText("未检测到").nth(2).waitFor({ timeout: 20_000 });
    await enterWorkbench(page);
    await page.getByRole("heading", { name: "未发现可监控 Agent" }).waitFor();
    await page.getByRole("button", { name: "打开设置" }).waitFor();
    await page.screenshot({ path: shotPath("onboarding-e2e-empty.png"), fullPage: true });
    await page.getByRole("button", { name: "打开设置" }).click();
    await page.getByText("暂未检测到本机 Agent").waitFor();
    await page.getByRole("button", { name: "重新检测" }).waitFor();
    const demoSwitch = page.getByRole("switch", { name: "演示数据" });
    await demoSwitch.waitFor();
    await openView(page, "报告");
    await page.getByRole("heading", { name: "暂无可报告的 Agent" }).waitFor();
    await openView(page, "插件");
    await page.getByRole("heading", { name: "事件协议" }).waitFor();
    const imports = cardAround(page, "导入用量");
    const merge = imports.getByRole("button", { name: "并入额度" });
    if (!(await merge.isDisabled())) throw new Error("import button should be disabled with 0 agents");
    const body = await bodyText(page);
    if (!body.trim()) throw new Error("blank plugin page");
    await openView(page, "设置");
    await demoSwitch.click();
    await page.getByText("已开启演示数据").waitFor({ timeout: 10_000 });
    await openView(page, "监控");
    for (const heading of ["Claude Code", "Grok", "Codex"]) {
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    }
    report.consoleErrors.push(...bucket.consoleErrors);
    report.pageErrors.push(...bucket.pageErrors);
    report.requestFailures.push(...bucket.requestFailures);
    report.httpErrors.push(...bucket.httpErrors);
    await context.close();
  });

  if (!PROD) await assertCase("onboarding network error stays on the setup page and retries", async () => {
    const { context, page, bucket } = await newPage(browser, { width: 1280, height: 900 });
    const hook = await startFresh(page, { failFirst: true });
    await waitForOnboarding(page);
    await page.getByText("无法检测本机 Agent，请稍后重试").waitFor({ timeout: 20_000 });
    const retry = page.getByRole("button", { name: "重新检测" });
    if (await retry.isDisabled()) throw new Error("retry stayed disabled");
    if (await page.getByText("检测中").count()) throw new Error("stuck in checking after error");
    await retry.click();
    await page.getByText("已找到").nth(2).waitFor({ timeout: 20_000 });
    report.consoleErrors.push(...bucket.consoleErrors);
    report.pageErrors.push(...bucket.pageErrors);
    report.requestFailures.push(...bucket.requestFailures);
    report.httpErrors.push(...bucket.httpErrors);
    await context.close();
  });

  if (!PROD) await assertCase("returning users see LoadingShell instead of stale agent cards", async () => {
    const { context, page, bucket } = await newPage(browser, { width: 1280, height: 900 });
    await seedPersist(page, {
      onboardingComplete: true,
      demoMode: false,
      agentAvailability: { claude: true, grok: true, codex: true },
    });
    const hook = await interceptAvailability(page, {
      payload: { claude: true, grok: false, codex: false },
      hold: true,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(250);
    const during = await bodyText(page);
    if (during.includes("Claude Code") || during.includes("协同时间线") || during.includes("Synq 初始设置")) {
      throw new Error(`stale workbench flashed: ${during.slice(0, 180)}`);
    }
    hook.release();
    await page.getByText("1 路 Agent 额度").waitFor({ timeout: 20_000 });
    await page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
    if (await page.getByRole("heading", { name: "Grok", exact: true }).count()) {
      throw new Error("stale Grok card remained after delayed detect");
    }
    report.consoleErrors.push(...bucket.consoleErrors);
    report.pageErrors.push(...bucket.pageErrors);
    report.requestFailures.push(...bucket.requestFailures);
    report.httpErrors.push(...bucket.httpErrors);
    await context.close();
  });

  await assertCase("desktop and mobile viewports have no horizontal overflow", async () => {
    for (const viewport of [
      { name: "desktop", width: 1280, height: 900, shot: "onboarding-e2e-desktop.png" },
      { name: "mobile", width: 390, height: 844, shot: "onboarding-e2e-mobile.png" },
    ]) {
      const { context, page, bucket } = await newPage(browser, viewport);
      await startFresh(page, {});
      await waitForOnboarding(page);
      await page.getByText("已找到").nth(2).waitFor({ timeout: 20_000 });
      const onboardingOverflow = await overflow(page);
      if (onboardingOverflow.scrollWidth > onboardingOverflow.clientWidth) {
        throw new Error(`${viewport.name} onboarding overflow ${onboardingOverflow.scrollWidth}>${onboardingOverflow.clientWidth}`);
      }
      await enterWorkbench(page);
      await page.getByRole("button", { name: "监控" }).waitFor();
      const workbenchOverflow = await overflow(page);
      if (workbenchOverflow.scrollWidth > workbenchOverflow.clientWidth) {
        throw new Error(`${viewport.name} workbench overflow ${workbenchOverflow.scrollWidth}>${workbenchOverflow.clientWidth}`);
      }
      if (viewport.name === "mobile") {
        await page.screenshot({ path: shotPath(viewport.shot), fullPage: true });
      }
      report.consoleErrors.push(...bucket.consoleErrors);
      report.pageErrors.push(...bucket.pageErrors);
      report.requestFailures.push(...bucket.requestFailures);
      report.httpErrors.push(...bucket.httpErrors);
      await context.close();
    }
  });
} finally {
  await browser.close();
}

const unique = (items) => [...new Set(items)];
const expectedAbort = (item) => item.includes("ERR_INTERNET_DISCONNECTED");
report.consoleErrors = unique(report.consoleErrors.filter((item) => !expectedAbort(item)));
report.pageErrors = unique(report.pageErrors);
report.requestFailures = unique(report.requestFailures.filter((item) => !expectedAbort(item)));
report.httpErrors = unique(
  report.httpErrors.filter(
    (item) =>
      !item.includes("/.well-known/") &&
      !item.includes("favicon") &&
      !item.includes("grok.com") &&
      !item.includes("fonts.gstatic.com") &&
      !item.includes("fonts.googleapis.com"),
  ),
);

const out = resolve("/tmp/synq-onboarding-e2e.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: { passed: report.passed, failed: report.failed, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, requestFailures: report.requestFailures.length, httpErrors: report.httpErrors.length }, cases: report.cases, consoleErrors: report.consoleErrors, pageErrors: report.pageErrors, requestFailures: report.requestFailures, httpErrors: report.httpErrors, availabilityUrl: report.availabilityUrl }, null, 2));
process.exit(report.failed ? 1 : 0);
