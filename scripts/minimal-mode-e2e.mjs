#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

for (const key of [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
])
  delete process.env[key];
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";
const BASE = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopShot = checkedOutputPath(
  resolve(repoRoot, "screenshots", "minimal-mode-desktop.png"),
  [repoRoot],
);
const mobileShot = checkedOutputPath(resolve(repoRoot, "screenshots", "minimal-mode-mobile.png"), [
  repoRoot,
]);
mkdirSync(dirname(desktopShot), { recursive: true });
const ALL_AGENTS = { claude: true, grok: true, codex: true };
const CLAUDE_ONLY = { claude: true, grok: false, codex: false };
const NO_AGENTS = { claude: false, grok: false, codex: false };
function serializeAvailability(availability) {
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
            v: [flag(availability.claude), flag(availability.grok), flag(availability.codex)],
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
  return url.includes("cHVsbEFnZW50QXZhaWxhYmlsaXR5") || url.includes("pullAgentAvailability");
}
function attachDiagnostics(page, diagnostics) {
  page.on("console", (msg) => {
    if (msg.type() === "error") diagnostics.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(String(error?.message || error));
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "failed";
    if (
      request.url().includes("/_serverFn/") &&
      !isAvailabilityRequest(request) &&
      failure.includes("net::ERR_FAILED")
    )
      return;
    diagnostics.requestFailures.push(`${request.method()} ${request.url()} ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      diagnostics.httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
  });
}
function assertDiagnostics(diagnostics) {
  const filteredConsoleErrors = diagnostics.consoleErrors.filter(
    (message) => message !== "Failed to load resource: net::ERR_FAILED",
  );
  const entries = [
    ...filteredConsoleErrors.map((content) => `console error: ${content}`),
    ...diagnostics.pageErrors.map((content) => `pageerror: ${content}`),
    ...diagnostics.requestFailures.map((content) => `request failed: ${content}`),
    ...diagnostics.httpErrors.map((content) => `HTTP error: ${content}`),
  ];
  assert.equal(entries.length, 0, `runtime diagnostics found errors:\n${entries.join("\n")}`);
}
function cardAround(page, heading) {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
}
const AGENT_CARD_HEADINGS = ["Claude Code", "Grok", "Codex"];
const AGENT_ID_BY_HEADING = { "Claude Code": "claude", Grok: "grok", Codex: "codex" };

async function assertFullAgentCardDetails(page) {
  for (const heading of AGENT_CARD_HEADINGS) {
    const card = cardAround(page, heading);
    const labels = await card.locator("dt").allTextContents();
    const windowMetric = heading === "Codex" ? "本窗推理" : "加权用量";
    assert.deepEqual(labels.slice(0, 4), [
      "本窗 token",
      windowMetric,
      "本周 token",
      "本周 API 等价",
    ]);
    assert.equal(await card.getByText("本周 token", { exact: true }).count(), 1);
    assert.equal(await card.getByText("本周 API 等价", { exact: true }).count(), 1);
    assert.equal(await card.getByText("可计价 token 覆盖率", { exact: true }).count(), 1);
    assert.equal(await card.getByText("价格版本", { exact: true }).count(), 1);
    assert.ok((await card.locator("dt").count()) > 2, `${heading} should keep full details`);
  }
  const claude = cardAround(page, "Claude Code");
  assert.equal(await claude.getByText("本窗 token", { exact: true }).count(), 1);
  assert.equal(await claude.getByText("加权用量", { exact: true }).count(), 1);
  assert.equal(await claude.getByText("5h API 等价", { exact: true }).count(), 1);
  const grok = cardAround(page, "Grok");
  assert.equal(await grok.getByText("本窗 token", { exact: true }).count(), 1);
  assert.equal(await grok.getByText("加权用量", { exact: true }).count(), 1);
  assert.equal(await grok.getByText("5h API 等价", { exact: true }).count(), 0);
  const codex = cardAround(page, "Codex");
  assert.equal(await codex.getByText("本窗 token", { exact: true }).count(), 1);
  assert.equal(await codex.getByText("本窗推理", { exact: true }).count(), 1);
  assert.equal(await codex.getByText("本周 credit 等价", { exact: true }).count(), 1);
  assert.equal(await codex.getByText("5h API 等价", { exact: true }).count(), 1);
}

async function assertMinimalAgentCardDetails(page) {
  const hiddenCopy = [
    "本窗 token",
    "本窗推理",
    "加权用量",
    "5h API 等价",
    "本周 credit 等价",
    "本地价格覆盖率",
    "可计价 token 覆盖率",
    "可计价事件覆盖率",
    "价格版本",
    "并行任务",
    "实时会话",
    "本周尚无模型拆分",
    "官方共享周池",
  ];
  for (const heading of AGENT_CARD_HEADINGS) {
    const card = cardAround(page, heading);
    const labels = await card.locator("dt").allTextContents();
    assert.deepEqual(labels, ["本周已用 token", "本周用量", "本周预估总 token", "本周预估总用量"]);
    assert.equal(await card.locator("dd").count(), 4);
    for (const value of await card.locator("dd").allTextContents())
      assert.match(value.trim(), /\S+/, `${heading} should render every weekly value`);
    assert.equal(
      (
        await card
          .getByText("本周预估总用量", { exact: true })
          .locator("xpath=..")
          .locator("dd")
          .textContent()
      )?.trim(),
      "样本不足",
    );
    assert.equal(await card.getByText("本周 token", { exact: true }).count(), 0);
    assert.equal(await card.getByText("本周 API 等价", { exact: true }).count(), 0);
    assert.equal(await card.getByText("本周额度", { exact: true }).count(), 0);
    assert.equal(await card.getByText("本周剩余", { exact: true }).count(), 1);
    assert.equal(await card.getByText("已用", { exact: true }).count(), 1);
    for (const status of ["充足", "留意", "将尽"])
      assert.equal(await card.getByText(status, { exact: true }).count(), 0);
    assert.equal(await card.getByLabel(/^套餐：.+ · 配置路径：~\//).count(), 1);
    const agent = AGENT_ID_BY_HEADING[heading];
    const remaining = card.locator(`[data-testid="quota-${agent}-week-remaining"]`);
    await remaining.waitFor();
    assert.match((await remaining.getAttribute("class")) ?? "", /text-(ok|warn|crit)/);
    assert.equal(await card.getByText(/后刷新|等待刷新/).count(), 0);
    assert.equal(await card.getByText("5 小时窗", { exact: false }).count(), 0);
    assert.equal(await card.getByText(/燃烧|%\/时|预计.*耗尽/).count(), 0);
    assert.equal(await card.getByText("本地日志覆盖", { exact: false }).count(), 0);
    assert.equal(await card.getByText(/官方周额度|官方快照周额度|本地估算周用量/).count(), 0);
    assert.equal(await card.getByText(/Claude Desktop 历史利用率|官方 OAuth 利用率/).count(), 0);
    assert.equal(await card.getByText(/官方实时账单|官方账单日志/).count(), 0);
    assert.equal(await card.getByText(/官方实时额度|官方会话额度/).count(), 0);
    for (const copy of hiddenCopy)
      assert.equal(await card.getByText(copy, { exact: true }).count(), 0, `${heading}: ${copy}`);
  }
}
async function openView(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}
async function persistedMinimalMode(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("balance-quota-v8");
    return raw ? JSON.parse(raw).state?.minimalMode : undefined;
  });
}
async function newSeededPage(browser, { state, availability, viewport, persistVersion = 2 }) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const diagnostics = { consoleErrors: [], pageErrors: [], requestFailures: [], httpErrors: [] };
  context.on("page", (openedPage) => attachDiagnostics(openedPage, diagnostics));
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await context.route("**/_serverFn/**", async (route) => {
    const request = route.request();
    if (isAvailabilityRequest(request)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serializeAvailability(availability),
      });
      return;
    }
    await route.abort("failed");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(BASE, { waitUntil: "commit" });
  await page.evaluate(
    ({ persistedState, persistVersion: version }) =>
      localStorage.setItem("balance-quota-v8", JSON.stringify({ state: persistedState, version })),
    { persistedState: state, persistVersion },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "监控", exact: true }).waitFor();
  return { context, page, diagnostics };
}
function geekSwitch(page) {
  return page.getByRole("switch", { name: "极客模式" });
}
async function assertAdvicePlanOneLine(page) {
  const timeline = cardAround(page, "协同时间线");
  const title = timeline.getByRole("heading", { name: "协同计划", exact: true });
  const section = timeline.locator('[aria-labelledby="collaboration-plan-title"]');
  const firstTip = section.locator("li").first();
  await title.waitFor();
  const titleBox = await title.boundingBox();
  const tipBox = await firstTip.boundingBox();
  const sectionBox = await section.boundingBox();
  assert.ok(titleBox && tipBox && sectionBox, "collaboration plan boxes must exist");
  assert.ok(
    Math.abs(titleBox.y + titleBox.height / 2 - (tipBox.y + tipBox.height / 2)) <= 16,
    `plan title and tips should share a row: title=${titleBox.y} tip=${tipBox.y}`,
  );
  assert.ok(
    tipBox.x >= titleBox.x + titleBox.width - 8,
    `tips should sit to the right of the title: titleX=${titleBox.x} tipX=${tipBox.x}`,
  );
  assert.ok(sectionBox.height <= 72, `collaboration plan too tall: ${sectionBox.height}`);
  const agentLabel = timeline.getByText("Codex", { exact: true });
  const labelBox = await agentLabel.boundingBox();
  if (labelBox) {
    assert.ok(
      Math.abs(titleBox.x - labelBox.x) <= 12,
      `plan title should align with agent labels: plan=${titleBox.x} label=${labelBox.x}`,
    );
  }
}
async function assertFullMode(page) {
  const timeline = cardAround(page, "协同时间线");
  await timeline.getByRole("heading", { name: "协同计划", exact: true }).waitFor();
  assert.equal(await timeline.getByText("now", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "协同建议", exact: true }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "实时流水", exact: true }).count(), 1);
  assert.equal(await page.getByText("当前是演示数据", { exact: false }).count(), 1);
  await assertFullAgentCardDetails(page);
}
async function assertMinimalMode(page) {
  await page.getByText("更紧的窗口", { exact: true }).waitFor();
  for (const heading of ["协同时间线", "Claude Code", "Grok", "Codex", "近 24 小时 token"])
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  await assertMinimalAgentCardDetails(page);
  await page
    .getByRole("img", {
      name: `协同时间线：${AGENT_CARD_HEADINGS.length} 路 Agent 共享同一口 5 小时时钟`,
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("img", {
      name: `近 24 小时 token：按小时叠加，便于看 ${AGENT_CARD_HEADINGS.length} 路 Agent 燃烧节奏`,
      exact: true,
    })
    .waitFor();
  const timeline = cardAround(page, "协同时间线");
  await timeline.getByRole("heading", { name: "协同计划", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "协同建议", exact: true }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "实时流水", exact: true }).count(), 0);
  assert.equal(await page.getByText("当前是演示数据", { exact: false }).count(), 0);
  const mainBox = await page.locator("main").boundingBox();
  const chartBox = await cardAround(page, "近 24 小时 token").boundingBox();
  assert.ok(mainBox && chartBox, "main and chart bounds must exist");
  assert.ok(
    chartBox.width >= mainBox.width - 64,
    `token chart should span the content width: ${chartBox.width} < ${mainBox.width - 64}`,
  );
}
async function assertDesktopMinimalLayout(page) {
  const cards = [
    cardAround(page, "Claude Code"),
    cardAround(page, "Grok"),
    cardAround(page, "Codex"),
  ];
  const boxes = await Promise.all(cards.map((card) => card.boundingBox()));
  boxes.forEach((box) => assert.ok(box, "desktop agent card must have bounds"));
  assert.ok(Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y)) <= 1);
  const timeline = cardAround(page, "协同时间线");
  for (const lane of ["Claude", "Grok", "Codex"])
    assert.equal(await timeline.getByText(lane, { exact: true }).count(), 1);
  const tight = page
    .getByText("更紧的窗口", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
  const tightBox = await tight.boundingBox();
  const timelineBox = await timeline.boundingBox();
  assert.ok(tightBox && timelineBox, "tight window and timeline cards must have bounds");
  assert.ok(
    Math.abs(tightBox.y + tightBox.height - (timelineBox.y + timelineBox.height)) <= 2,
    `top row cards should share a bottom edge: tight=${tightBox.y + tightBox.height} timeline=${timelineBox.y + timelineBox.height}`,
  );
}
async function assertMobileOrder(page) {
  const cards = [
    page
      .getByText("更紧的窗口", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]"),
    cardAround(page, "协同时间线"),
    cardAround(page, "Claude Code"),
    cardAround(page, "Grok"),
    cardAround(page, "Codex"),
    cardAround(page, "近 24 小时 token"),
  ];
  const boxes = await Promise.all(cards.map((card) => card.boundingBox()));
  boxes.forEach((box) => assert.ok(box, "every compact-mode card must have bounds"));
  for (let index = 1; index < boxes.length; index += 1)
    assert.ok(boxes[index - 1].y < boxes[index].y, `mobile card order failed at index ${index}`);
}
async function assertNonTargetViews(page) {
  await openView(page, "设置");
  await page.getByRole("heading", { name: "Claude Code 套餐", exact: true }).waitFor();
  await openView(page, "报告");
  await page.getByRole("heading", { name: "十四日热力", exact: true }).waitFor();
  await openView(page, "调度");
  await page.locator('[data-testid="orchestrator-panel"]').waitFor();
  await openView(page, "监控");
}
async function assertNoOverflow(page) {
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(
    size.scrollWidth <= size.clientWidth,
    `horizontal overflow ${size.scrollWidth} > ${size.clientWidth}`,
  );
}
async function assertFitsViewport(page) {
  await assertNoOverflow(page);
  const size = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      rootScroll: document.documentElement.scrollHeight,
      rootClient: document.documentElement.clientHeight,
      mainScroll: main?.scrollHeight ?? 0,
      mainClient: main?.clientHeight ?? 0,
    };
  });
  assert.ok(
    size.rootScroll <= size.rootClient + 1,
    `page vertical overflow ${size.rootScroll} > ${size.rootClient}`,
  );
  assert.ok(
    size.mainScroll <= size.mainClient + 1,
    `main vertical overflow ${size.mainScroll} > ${size.mainClient}`,
  );
}
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const { context, page, diagnostics } = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: true,
      adapterHint: true,
      agentAvailability: ALL_AGENTS,
    },
    persistVersion: 0,
    availability: ALL_AGENTS,
    viewport: { width: 1280, height: 900 },
  });
  await page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("balance-quota-v8");
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed.version === 2 && parsed.state?.minimalMode === true;
  });
  await assertMinimalMode(page);
  await assertAdvicePlanOneLine(page);
  await assertFitsViewport(page);
  await openView(page, "设置");
  const geek = geekSwitch(page);
  await geek.waitFor();
  assert.equal(await geek.getAttribute("data-state"), "unchecked");
  assert.equal(await persistedMinimalMode(page), true);
  await geek.click();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("balance-quota-v8");
    return raw ? JSON.parse(raw).state?.minimalMode === false : false;
  });
  assert.equal(await persistedMinimalMode(page), false);
  await openView(page, "监控");
  await assertFullMode(page);
  await assertAdvicePlanOneLine(page);
  await openView(page, "设置");
  await geekSwitch(page).click();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("balance-quota-v8");
    return raw ? JSON.parse(raw).state?.minimalMode === true : false;
  });
  assert.equal(await persistedMinimalMode(page), true);
  await openView(page, "监控");
  await assertMinimalMode(page);
  await assertDesktopMinimalLayout(page);
  await assertFitsViewport(page);
  await page.getByRole("button", { name: "全部暂停", exact: true }).click();
  const resume = page.getByRole("button", { name: "开始协同", exact: true });
  await resume.waitFor();
  await resume.click();
  await page.getByRole("button", { name: "全部暂停", exact: true }).waitFor();
  await page.screenshot({ path: desktopShot, fullPage: true });
  await assertNonTargetViews(page);
  const tray = await context.newPage();
  tray.setDefaultTimeout(20_000);
  await tray.goto(new URL("/tray", BASE).toString(), { waitUntil: "domcontentloaded" });
  await tray.getByText("3 个订阅", { exact: true }).waitFor();
  await tray.getByText("现在该用", { exact: true }).waitFor();
  await tray.getByText("推荐", { exact: true }).waitFor();
  for (const name of ["Claude Code", "Grok", "Codex"]) {
    assert.ok(
      (await tray.getByText(name, { exact: true }).count()) >= 1,
      `${name} should appear in the tray`,
    );
  }
  await tray.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "协同时间线", exact: true }).waitFor();
  await assertMinimalMode(page);
  await openView(page, "设置");
  assert.equal(await geekSwitch(page).getAttribute("data-state"), "unchecked");
  await page.setViewportSize({ width: 390, height: 844 });
  await openView(page, "监控");
  await assertMinimalMode(page);
  await assertAdvicePlanOneLine(page);
  await assertNoOverflow(page);
  await assertMobileOrder(page);
  await page.screenshot({ path: mobileShot, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openView(page, "设置");
  await geekSwitch(page).click();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("balance-quota-v8");
    return raw ? JSON.parse(raw).state?.minimalMode === false : false;
  });
  assert.equal(await persistedMinimalMode(page), false);
  await openView(page, "监控");
  await assertFullMode(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "实时流水", exact: true }).waitFor();
  await openView(page, "设置");
  assert.equal(await geekSwitch(page).getAttribute("data-state"), "checked");
  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value() {
        throw new DOMException("storage blocked", "QuotaExceededError");
      },
    });
  });
  const blockedSwitch = geekSwitch(page);
  await blockedSwitch.click();
  assert.equal(await blockedSwitch.getAttribute("data-state"), "unchecked");
  await openView(page, "监控");
  await assertMinimalMode(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "实时流水", exact: true }).waitFor();
  await assertFullMode(page);
  assertDiagnostics(diagnostics);
  await context.close();
  const legacy = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: true,
      adapterHint: true,
      agentAvailability: ALL_AGENTS,
    },
    persistVersion: 0,
    availability: ALL_AGENTS,
    viewport: { width: 1280, height: 900 },
  });
  await legacy.page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
  await assertMinimalMode(legacy.page);
  await openView(legacy.page, "设置");
  assert.equal(await geekSwitch(legacy.page).getAttribute("data-state"), "unchecked");
  assert.equal(await persistedMinimalMode(legacy.page), true);
  assertDiagnostics(legacy.diagnostics);
  await legacy.context.close();
  const single = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: false,
      adapterHint: true,
      agentAvailability: CLAUDE_ONLY,
    },
    availability: CLAUDE_ONLY,
    viewport: { width: 1280, height: 900 },
  });
  await single.page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
  await single.page.getByRole("heading", { name: "协同时间线", exact: true }).waitFor();
  await single.page.getByRole("heading", { name: "近 24 小时 token", exact: true }).waitFor();
  assert.equal(await single.page.getByRole("heading", { name: "Grok", exact: true }).count(), 0);
  assert.equal(await single.page.getByRole("heading", { name: "Codex", exact: true }).count(), 0);
  assert.equal(
    await single.page.getByRole("heading", { name: "协同计划", exact: true }).count(),
    0,
  );
  assert.equal(
    await single.page.locator('[aria-labelledby="collaboration-plan-title"]').count(),
    0,
  );
  assert.equal(
    await single.page.getByRole("heading", { name: "实时流水", exact: true }).count(),
    0,
  );
  await assertNoOverflow(single.page);
  await openView(single.page, "设置");
  assert.equal(await geekSwitch(single.page).getAttribute("data-state"), "unchecked");
  assertDiagnostics(single.diagnostics);
  await single.context.close();
  const empty = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: false,
      adapterHint: true,
      agentAvailability: NO_AGENTS,
    },
    availability: NO_AGENTS,
    viewport: { width: 390, height: 844 },
  });
  await empty.page.getByRole("heading", { name: "未发现可监控 Agent", exact: true }).waitFor();
  await empty.page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  assert.equal(
    await empty.page.getByRole("heading", { name: "协同时间线", exact: true }).count(),
    0,
  );
  assert.equal(await empty.page.getByText("更紧的窗口", { exact: true }).count(), 0);
  for (const heading of ["Claude Code", "Grok", "Codex", "近 24 小时 token"])
    assert.equal(await empty.page.getByRole("heading", { name: heading, exact: true }).count(), 0);
  await assertNoOverflow(empty.page);
  await empty.page.getByRole("button", { name: "打开设置", exact: true }).click();
  assert.equal(await geekSwitch(empty.page).getAttribute("data-state"), "unchecked");
  assertDiagnostics(empty.diagnostics);
  await empty.context.close();
  console.log(
    "PASS minimal mode covers persistence, storage failure, full/minimal layouts, non-target views, single/zero agents, and desktop/mobile viewports",
  );
} finally {
  await browser.close();
}
