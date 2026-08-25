#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const HISTORY_ID = "cHVsbE9mZmljaWFsSGlzdG9yeQ";

function productionServerFnId(name) {
  const ssrDir = resolve(".vercel/output/functions/__server.func/_ssr");
  if (!existsSync(ssrDir)) return null;
  for (const file of readdirSync(ssrDir).filter(
    (entry) => entry.startsWith("routes-") && entry.endsWith(".mjs"),
  )) {
    const source = readFileSync(resolve(ssrDir, file), "utf8");
    const match = source.match(new RegExp(`var ${name} = [^;]+createSsrRpc\\("([a-f0-9]{64})"\\)`));
    if (match) return match[1];
  }
  return null;
}

const AVAILABILITY_IDS = [AVAILABILITY_ID, productionServerFnId("pullAgentAvailability")].filter(
  Boolean,
);
const OFFICIAL_IDS = [OFFICIAL_ID, productionServerFnId("pullOfficialQuota")].filter(Boolean);
const HISTORY_IDS = [HISTORY_ID, productionServerFnId("pullOfficialHistory")].filter(Boolean);
const BOOTSTRAP_IDS = [
  Buffer.from("pullQuotaBootstrap").toString("base64url"),
  productionServerFnId("pullQuotaBootstrap"),
].filter(Boolean);
const CLAUDE_USAGE_IDS = [
  Buffer.from("pullClaudeUsage").toString("base64url"),
  productionServerFnId("pullClaudeUsage"),
].filter(Boolean);
const GROK_USAGE_IDS = [
  Buffer.from("pullGrokUsage").toString("base64url"),
  productionServerFnId("pullGrokUsage"),
].filter(Boolean);
const CODEX_USAGE_IDS = [
  Buffer.from("pullCodexUsage").toString("base64url"),
  productionServerFnId("pullCodexUsage"),
].filter(Boolean);
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const E2E_NOW = Date.now();
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
  const fetchedAt = partial.fetchedAt ?? Date.now();
  const defaultResetsAt = E2E_NOW + 5 * 24 * 60 * 60 * 1000;
  const modelWeekLimits = "modelWeekLimits" in partial
    ? partial.modelWeekLimits
    : { fable: { usedPct: 26, resetsAt: defaultResetsAt } };
  const poolStale = partial.modelWeekLimitsStale ?? false;
  const quotaPools = partial.quotaPools ?? (modelWeekLimits
    ? Object.entries(modelWeekLimits).map(([model, limit]) => ({
        id: `seven_day_${model}`,
        kind: "model-week",
        usagePercent: limit.usedPct,
        startsAt: (limit.resetsAt ?? defaultResetsAt) - 7 * 24 * 60 * 60 * 1000,
        resetsAt: limit.resetsAt ?? defaultResetsAt,
        durationMs: 7 * 24 * 60 * 60 * 1000,
        models: [model],
        exactUsedUsd: null,
        exactLimitUsd: null,
        fetchedAt,
        stale: poolStale,
      }))
    : []);
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
    modelWeekLimits,
    quotaPools,
    source: "oauth-usage",
    fetchedAt,
    windowKind: "five_hour",
    ...partial,
  };
}

function antigravityOfficialSlice(partial = {}) {
  const fetchedAt = E2E_NOW;
  const weekReset = E2E_NOW + 4 * 24 * 60 * 60 * 1000;
  const fiveHourReset = E2E_NOW + 3 * 60 * 60 * 1000;
  const quotaPool = (
    id,
    label,
    quotaGroup,
    quotaWindow,
    usagePercent,
    resetsAt,
    durationMs,
  ) => ({
    id,
    label,
    kind: "quota-window",
    quotaGroup,
    quotaWindow,
    usagePercent,
    startsAt: resetsAt - durationMs,
    resetsAt,
    durationMs,
    models: [],
    exactUsedUsd: null,
    exactLimitUsd: null,
    fetchedAt,
    stale: false,
  });
  return officialSlice({
    agent: "antigravity",
    windowPct: 55,
    weekPct: 62,
    windowResetsAt: fiveHourReset,
    weekResetsAt: weekReset,
    weekStartedAt: weekReset - 7 * 24 * 60 * 60 * 1000,
    planLabel: null,
    modelWeekLimits: undefined,
    quotaPools: [
      quotaPool("gemini-weekly", "Gemini Models · 每周", "gemini", "weekly", 28, weekReset, 7 * 24 * 60 * 60 * 1000),
      quotaPool("gemini-5h", "Gemini Models · 5 小时", "gemini", "five_hour", 55, fiveHourReset, 5 * 60 * 60 * 1000),
      quotaPool("3p-weekly", "Claude and GPT models · 每周", "claude-gpt", "weekly", 62, weekReset, 7 * 24 * 60 * 60 * 1000),
      quotaPool("3p-5h", "Claude and GPT models · 5 小时", "claude-gpt", "five_hour", 20, fiveHourReset, 5 * 60 * 60 * 1000),
    ],
    source: "antigravity-quota-summary",
    fetchedAt,
    ...partial,
  });
}

function antigravityAlertScenario(slice) {
  return {
    persistVersion: 3,
    cardHeading: "Antigravity",
    availability: { claude: false, grok: false, codex: false, antigravity: true },
    state: {
      minimalMode: true,
      alertWindowPct: 80,
      alertWeekPct: 85,
      agentAvailability: { claude: false, grok: false, codex: false, antigravity: true },
      captureEnabled: { claude: false, grok: false, codex: false, antigravity: false },
    },
    official: { claude: null, grok: null, codex: null, antigravity: slice },
    present: [],
    absent: [],
  };
}

function cachedQuotaEvent(event) {
  return {
    idHash: createHash("sha256")
      .update(`${event.agent}\0${event.id}`, "utf8")
      .digest("hex"),
    agent: event.agent,
    model: event.model,
    modelRaw: event.modelRaw,
    ts: event.ts,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
  };
}

function usageEvent(id, ts, tokensIn = 1_000_000) {
  return {
    id,
    agent: "claude",
    model: "sonnet",
    modelRaw: "claude-sonnet-5",
    ts,
    sessionId: "quota-e2e",
    task: "额度 E2E fixture",
    tokensIn,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningMin: 0,
  };
}

function priorWindowFixture() {
  const resetAt = E2E_NOW - 60 * 60 * 1000;
  const startAt = resetAt - FIVE_HOURS_MS;
  // Generate enough history points to produce sufficient slopes for calibration
  const points = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30];
  const step = Math.floor((resetAt - startAt) / (points.length + 1));
  const history = points.map((windowPct, index) => officialSlice({
    fetchedAt: startAt + (index + 1) * step,
    windowPct,
    windowResetsAt: resetAt,
    windowDurationMs: FIVE_HOURS_MS,
    source: "quota-e2e-history",
  }));
  const historicalEvents = points.slice(1).map((_, index) =>
    usageEvent(`prior-${index}`, startAt + (index + 1) * step - 1_000),
  );
  const currentMixEvent = usageEvent("current-mix", E2E_NOW - 1_000, 1_000);
  return { history, events: [...historicalEvents, currentMixEvent] };
}

const PRIOR = priorWindowFixture();

function persistedState(extra = {}) {
  return {
    onboardingComplete: true,
    demoMode: false,
    minimalMode: false,
    adapterHint: false,
    agentAvailability: { claude: true, grok: false, codex: false, antigravity: false },
    captureEnabled: { claude: true, grok: false, codex: false, antigravity: false },
    events: [],
    realEvents: [],
    liveClaude: false,
    liveGrok: false,
    liveCodex: false,
    official: { claude: null, grok: null, codex: null, antigravity: null },
    quotaSamples: [],
    calibrationTruncatedBeforeMs: null,
    cacheHistoryTruncated: false,
    cacheTruncatedBeforeMs: null,
    ...extra,
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
    official: { claude: officialSlice(), grok: null, codex: null, antigravity: null },
    present: [
      "官方窗口剩余",
      "5 小时窗（官方）",
      "本周额度（官方）",
      "Fable 5 周池（官方）",
      "24%",
      "34%",
      "26%",
    ],
    absent: ["当前显示本地估算", "官方快照"],
  },
  antigravity: {
    persistVersion: 3,
    cardHeading: "Antigravity",
    antigravityGeek: true,
    expectedSanitizedOfficial: true,
    availability: { claude: false, grok: false, codex: false, antigravity: true },
    state: {
      minimalMode: true,
      agentAvailability: { claude: false, grok: false, codex: false, antigravity: true },
      captureEnabled: { claude: false, grok: false, codex: false, antigravity: false },
    },
    official: {
      claude: null,
      grok: null,
      codex: null,
      antigravity: antigravityOfficialSlice(),
    },
    present: [],
    absent: [],
  },
  "antigravity-alert-five-hour": {
    ...antigravityAlertScenario(antigravityOfficialSlice({
      windowPct: 90,
      weekPct: 34,
      quotaPools: [],
    })),
    expectedAlertMessage: "Antigravity 5 小时窗已用 90%",
    expectedAlertLatch: "antigravityWin",
    expectedInactiveAlertLatch: "antigravityWeek",
  },
  "antigravity-alert-week": {
    ...antigravityAlertScenario(antigravityOfficialSlice({
      windowPct: 10,
      weekPct: 90,
      quotaPools: [],
    })),
    expectedAlertMessage: "Antigravity 本周额度已用 90%",
    expectedAlertLatch: "antigravityWeek",
    expectedInactiveAlertLatch: "antigravityWin",
  },
  "antigravity-alert-week-only": {
    ...antigravityAlertScenario(antigravityOfficialSlice({
      windowKind: "weekly",
      windowPct: null,
      weekPct: 90,
      quotaPools: [],
    })),
    expectedAlertMessage: "Antigravity 本周额度已用 90%",
    expectedAlertLatch: "antigravityWeek",
    expectedInactiveAlertLatch: "antigravityWin",
  },
  "antigravity-alert-stale": {
    ...antigravityAlertScenario(antigravityOfficialSlice({
      windowPct: 90,
      weekPct: 90,
      windowStale: true,
      weekStale: true,
      quotaPools: [],
    })),
    expectNoAlerts: true,
  },
  partial: {
    official: {
      claude: officialSlice({ windowPct: null, modelWeekLimits: undefined }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    present: [
      "部分官方额度暂未返回；缺失项显示本地估算。",
      "本地估算窗口剩余",
      "5 小时窗用量（本地估算）",
      "本周额度（官方）",
      "34%",
      "充足",
    ],
    absent: ["5 小时窗（官方）", "Fable 5 周池（官方）"],
  },
  stale: {
    persistVersion: 2,
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
      antigravity: null,
    },
    present: [
      "官方接口暂不可用；标为“官方快照”的值来自上次成功读取。",
      "官方快照窗口剩余",
      "5 小时窗（官方快照）",
      "本周额度（官方快照）",
      "Fable 5 周池（官方快照）",
      "96%",
      "95%",
      "94.0%",
      "官方快照",
    ],
    absent: ["5 小时窗（官方）", "本周额度（官方）", "将尽"],
    state: {
      minimalMode: false,
      alerts: [],
      alertLatches: {
        claudeWin: false,
        claudeWeek: false,
        claudeFable: true,
        grokWin: false,
        grokWeek: false,
        codexWin: false,
        codexWeek: false,
      },
    },
    expectNoAlerts: true,
    expectPreservedAlertLatch: "claudeFable",
    expectedPreservedAlertCount: 0,
  },
  "alert-once": {
    official: {
      claude: officialSlice({
        windowPct: 90,
        weekPct: 34,
        modelWeekLimits: undefined,
        quotaPools: [],
      }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    state: {
      minimalMode: true,
      alertWindowPct: 80,
      alertWeekPct: 85,
    },
    present: ["本周额度", "34%"],
    absent: ["官方快照"],
    expectedAlertMessage: "Claude Code 5 小时窗已用 90%",
    expectedAlertLatch: "claudeWin",
    expectedInactiveAlertLatch: "claudeWeek",
  },
  "alert-once-weekly": {
    official: {
      claude: officialSlice({
        windowKind: "weekly",
        windowPct: null,
        weekPct: 90,
        modelWeekLimits: undefined,
        quotaPools: [],
      }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    state: { minimalMode: true, alertWindowPct: 80, alertWeekPct: 85 },
    present: ["本周额度", "90%"],
    absent: ["官方快照"],
    expectedAlertMessage: "Claude Code 本周额度已用 90%",
    expectedAlertLatch: "claudeWeek",
    expectedInactiveAlertLatch: "claudeWin",
  },
  "stale-recovery-alert-once": {
    officialSequence: [
      {
        claude: officialSlice({ windowPct: 90, weekPct: 34, quotaPools: [] }),
        grok: null,
        codex: null,
        antigravity: null,
      },
      {
        claude: officialSlice({
          windowPct: 90,
          weekPct: 34,
          windowStale: true,
          quotaPools: [],
        }),
        grok: null,
        codex: null,
        antigravity: null,
      },
      {
        claude: officialSlice({ windowPct: 90, weekPct: 34, quotaPools: [] }),
        grok: null,
        codex: null,
        antigravity: null,
      },
    ],
    state: { minimalMode: true, alertWindowPct: 80, alertWeekPct: 85 },
    present: ["本周额度", "34%"],
    absent: [],
    expectedAlertMessage: "Claude Code 5 小时窗已用 90%",
    expectedAlertLatch: "claudeWin",
    expectedInactiveAlertLatch: "claudeWeek",
    stepOfficialSequenceBeforeReload: true,
  },
  "fable-missing": {
    persistVersion: 2,
    official: {
      claude: officialSlice({
        windowPct: 24,
        weekPct: 34,
        modelWeekLimits: undefined,
        quotaPools: [],
      }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    state: {
      minimalMode: false,
      alerts: [],
      alertLatches: {
        claudeWin: false,
        claudeWeek: false,
        claudeFable: true,
        grokWin: false,
        grokWeek: false,
        codexWin: false,
        codexWeek: false,
      },
    },
    present: ["本周额度（官方）", "34%"],
    absent: ["Fable 5 周池（官方）", "官方快照"],
    expectNoAlerts: true,
    expectPreservedAlertLatch: "claudeFable",
    expectedPreservedAlertCount: 0,
  },
  "demo-latch-reload": {
    official: { claude: null, grok: null, codex: null, antigravity: null },
    state: {
      demoMode: true,
      alertWindowPct: 99,
      alertWeekPct: 99,
      alerts: [],
      alertLatches: {
        claudeWin: true,
        claudeWeek: false,
        claudeFable: false,
        grokWin: false,
        grokWeek: false,
        codexWin: false,
        codexWeek: false,
      },
    },
    present: [],
    absent: [],
    expectOfficialRequest: false,
    expectPreservedAlertLatch: "claudeWin",
    expectedPreservedAlertCount: 0,
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
  pools: {
    official: {
      claude: officialSlice({
        fetchedAt: E2E_NOW,
        quotaPools: [
          {
            id: "seven_day_sonnet",
            kind: "model-week",
            usagePercent: 75.5,
            startsAt: E2E_NOW - 2 * 24 * 60 * 60 * 1000,
            resetsAt: E2E_NOW + 5 * 24 * 60 * 60 * 1000,
            durationMs: 7 * 24 * 60 * 60 * 1000,
            models: ["sonnet"],
            exactUsedUsd: null,
            exactLimitUsd: null,
            fetchedAt: E2E_NOW,
            stale: false,
          },
          {
            id: "seven_day_opus",
            kind: "model-week",
            usagePercent: 10.25,
            startsAt: E2E_NOW - 2 * 24 * 60 * 60 * 1000,
            resetsAt: E2E_NOW + 5 * 24 * 60 * 60 * 1000,
            durationMs: 7 * 24 * 60 * 60 * 1000,
            models: ["opus"],
            exactUsedUsd: null,
            exactLimitUsd: null,
            fetchedAt: E2E_NOW,
            stale: false,
          },
          {
            id: "seven_day_fable",
            kind: "model-week",
            usagePercent: 26,
            startsAt: E2E_NOW - 2 * 24 * 60 * 60 * 1000,
            resetsAt: E2E_NOW + 5 * 24 * 60 * 60 * 1000,
            durationMs: 7 * 24 * 60 * 60 * 1000,
            models: ["fable"],
            exactUsedUsd: null,
            exactLimitUsd: null,
            fetchedAt: E2E_NOW,
            stale: false,
          },
          {
            id: "extra_usage",
            kind: "extra-usage",
            usagePercent: 42.5,
            startsAt: null,
            resetsAt: null,
            durationMs: null,
            models: [],
            exactUsedUsd: 42.5,
            exactLimitUsd: 100,
            fetchedAt: E2E_NOW,
            stale: false,
          },
        ],
      }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    history: [],
    present: [
      "Sonnet 周池（官方）",
      "Opus 周池（官方）",
      "Fable 5 周池（官方）",
      "已用 $42.5 / 上限 $100 · 精确剩余 $57.5",
    ],
    absent: ["估算额外用量剩余", "快照仅供参考"],
    accessibilityNames: ["独立额度池"],
  },
  "historical-prior": {
    state: { events: PRIOR.events, realEvents: PRIOR.events },
    bootstrapEvents: PRIOR.events.map(cachedQuotaEvent),
    official: {
      claude: officialSlice({
        fetchedAt: E2E_NOW,
        windowPct: 1,
        windowResetsAt: E2E_NOW + 4 * 60 * 60 * 1000,
        windowDurationMs: FIVE_HOURS_MS,
      }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    history: PRIOR.history,
    present: ["· 检测到本机日志之外的额度消耗", "无可用校准"],
    absent: ["当前窗口样本"],
  },
  truncated: {
    state: {
      calibrationTruncatedBeforeMs: E2E_NOW - 30 * 60 * 1000,
    },
    official: {
      claude: officialSlice({
        fetchedAt: E2E_NOW,
        windowPct: 8,
        windowResetsAt: E2E_NOW + 4 * 60 * 60 * 1000,
        windowDurationMs: FIVE_HOURS_MS,
      }),
      grok: null,
      codex: null,
      antigravity: null,
    },
    history: [],
    present: ["· 本地校准历史已截断，区间已关闭", "样本不足"],
    absent: ["当前窗口样本", "历史窗口先验"],
  },
};

function isRequest(request, ids, name) {
  const url = request.url();
  if (!url.includes("/_serverFn/")) return false;
  if (ids.some((id) => url.includes(id)) || url.includes(name)) return true;
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
  let officialSeen = 0;
  let officialStage = 0;
  const serverFnRequests = [];
  const scannerBodies = [];
  const officialResponseBodies = [];
  await context.addInitScript(({ state, version }) => {
    if (localStorage.getItem("balance-quota-v8") == null) {
      localStorage.setItem(
        "balance-quota-v8",
        JSON.stringify({ state, version }),
      );
    }
  }, {
    state: persistedState(scenario.state ?? {}),
    version: scenario.persistVersion ?? 2,
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
    serverFnRequests.push(`${request.method()} ${request.url()}`);
    if (isRequest(request, AVAILABILITY_IDS, "pullAgentAvailability")) {
      const availabilityFixture = scenario.availability ?? {
        claude: true,
        grok: false,
        codex: false,
        antigravity: false,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized(availabilityFixture),
      });
      return;
    }
    if (isRequest(request, BOOTSTRAP_IDS, "pullQuotaBootstrap")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized({
          events: scenario.bootstrapEvents ?? [],
          nextOffset: null,
          savedAt: scenario.bootstrapEvents?.length ? E2E_NOW : null,
          historyTruncated: false,
          truncatedBeforeMs: null,
          snapshotKey: scenario.bootstrapEvents?.length ? "a".repeat(64) : null,
          restart: false,
        }),
      });
      return;
    }
    if (isRequest(request, CLAUDE_USAGE_IDS, "pullClaudeUsage")) {
      scannerBodies.push(request.postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized({ events: [], live: null, active: [], roots: [], filesRead: 0 }),
      });
      return;
    }
    if (isRequest(request, GROK_USAGE_IDS, "pullGrokUsage")) {
      scannerBodies.push(request.postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized({ events: [], live: null, active: [], roots: [], filesRead: 0 }),
      });
      return;
    }
    if (isRequest(request, CODEX_USAGE_IDS, "pullCodexUsage")) {
      scannerBodies.push(request.postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized({
          events: [],
          live: null,
          active: [],
          roots: [],
          filesRead: 0,
          official: null,
          officialHistory: [],
        }),
      });
      return;
    }
    if (isRequest(request, OFFICIAL_IDS, "pullOfficialQuota")) {
      officialSeen += 1;
      if (scenario.mode === "error") {
        await route.abort("internetdisconnected");
        return;
      }
      if (scenario.mode === "hold") {
        await new Promise((resolveHold) => held.push(resolveHold));
      }
      const officialSequence = scenario.officialSequence;
      const officialFixture = officialSequence?.length
        ? officialSequence[Math.min(officialStage, officialSequence.length - 1)]
        : (scenario.official ?? { claude: null, grok: null, codex: null, antigravity: null });
      const officialBody = serialized(officialFixture);
      officialResponseBodies.push(officialBody);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: officialBody,
      });
      return;
    }
    if (isRequest(request, HISTORY_IDS, "pullOfficialHistory")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-tss-serialized": "true" },
        body: serialized(scenario.history ?? []),
      });
      return;
    }
    if (new URL(request.url()).pathname.includes("_serverFn")) {
      throw new Error(`unmocked serverFn in isolated quota E2E: ${request.url()}`);
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
    if (scenario.mode === "error" && isRequest(request, OFFICIAL_IDS, "pullOfficialQuota")) return;
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
    const card = cardAround(page, scenario.cardHeading ?? "Claude Code");
    await card.waitFor();
    if (scenario.expectOfficialRequest !== false && officialSeen < 1) {
      throw new Error(`official fixture was not intercepted: ${JSON.stringify(serverFnRequests)}`);
    }
    for (const text of scenario.present) {
      try {
        await card.getByText(text, { exact: true }).first().waitFor();
      } catch (error) {
        throw new Error(
          `missing expected text ${JSON.stringify(text)}; card text=${JSON.stringify(await card.innerText())}`,
          { cause: error },
        );
      }
    }
    for (const text of scenario.absent) {
      if (await card.getByText(text, { exact: true }).count()) {
        throw new Error(`unexpected text: ${text}`);
      }
    }
    if (scenario.antigravityGeek) {
      assert.equal(
        await card.getByTestId("quota-antigravity-gemini-remaining").textContent(),
        "45%",
      );
      assert.equal(
        await card.getByTestId("quota-antigravity-claude-gpt-remaining").textContent(),
        "38%",
      );
      assert.equal(
        await page.getByTestId("tightest-quota-remaining").textContent(),
        "38%",
      );
      assert.equal(await card.getByTestId("quota-antigravity-primary-remaining").count(), 0);
      assert.equal(await card.getByRole("button", { name: /采集|暂停/ }).count(), 0);
      await page.getByRole("button", { name: "设置" }).click();
      const officialPlan = page.getByRole("status", {
        name: "Antigravity 官方额度，自动读取，无需选择套餐",
      });
      await officialPlan.waitFor();
      assert.equal(await officialPlan.getByRole("button").count(), 0);
      await page.getByRole("switch", { name: "极客模式" }).click();
      await page.getByRole("button", { name: "监控" }).click();
      assert.equal(
        await card.getByTestId("quota-antigravity-primary-remaining").textContent(),
        "38%",
      );
      for (const label of [
        "Gemini Models · 每周（官方）",
        "Gemini Models · 5 小时（官方）",
        "Claude and GPT models · 每周（官方）",
        "Claude and GPT models · 5 小时（官方）",
      ]) {
        assert.equal(
          await card.getByText(label, { exact: true }).count(),
          1,
          `missing ${label}; card=${JSON.stringify(await card.innerText())}`,
        );
      }
      assert.equal(await card.getByText(/API 等价/).count(), 0);
    }
    if (scenario.expectedSanitizedOfficial) {
      assert.ok(officialResponseBodies.length > 0);
      const delivered = officialResponseBodies.join("\n");
      for (const secretMarker of ["Bearer ", "access_token", "refresh_token", "Authorization"]) {
        assert.equal(delivered.includes(secretMarker), false);
      }
    }
    if (scenario.expectNoAlerts) {
      const alertCount = await page.evaluate(() => {
        const raw = localStorage.getItem("balance-quota-v8");
        return raw ? (JSON.parse(raw)?.state?.alerts?.length ?? 0) : 0;
      });
      if (alertCount !== 0) throw new Error(`stale quota emitted ${alertCount} alerts`);
    }
    if (scenario.expectedAlertMessage && scenario.expectedAlertLatch) {
      await page.waitForFunction((latchKey) => {
        const raw = localStorage.getItem("balance-quota-v8");
        if (!raw) return false;
        const state = JSON.parse(raw).state;
        return state.alerts?.length === 1 && state.alertLatches?.[latchKey] === true;
      }, scenario.expectedAlertLatch);
      const firstMessage = await page.evaluate(() => {
        const raw = localStorage.getItem("balance-quota-v8");
        return raw ? JSON.parse(raw).state.alerts[0]?.message : null;
      });
      assert.equal(firstMessage, scenario.expectedAlertMessage);
      const firstToast = page.locator("[data-sonner-toast]").first();
      await firstToast.waitFor({ state: "visible" });
      if (scenario.stepOfficialSequenceBeforeReload) {
        for (let stage = 1; stage < scenario.officialSequence.length; stage += 1) {
          const seenBeforeStage = officialSeen;
          officialStage = stage;
          const deadline = Date.now() + 20_000;
          while (officialSeen <= seenBeforeStage) {
            if (Date.now() >= deadline) {
              throw new Error(`official sequence stage ${stage} was not requested`);
            }
            await page.waitForTimeout(250);
          }
          await page.waitForTimeout(500);
        }
      }
      await firstToast.waitFor({ state: "detached", timeout: 10_000 });

      await page.reload({ waitUntil: "domcontentloaded" });
      await card.waitFor();
      await page.waitForTimeout(3_000);
      const afterReload = await page.evaluate(({ activeKey, inactiveKey }) => {
        const raw = localStorage.getItem("balance-quota-v8");
        const state = raw ? JSON.parse(raw).state : null;
        return {
          alerts: state?.alerts?.length ?? 0,
          activeWarned: state?.alertLatches?.[activeKey] ?? false,
          inactiveWarned: inactiveKey
            ? (state?.alertLatches?.[inactiveKey] ?? false)
            : false,
          toastMessages: [...document.querySelectorAll("[data-sonner-toast]")].map((toast) => ({
            text: toast.textContent,
            removed: toast.getAttribute("data-removed"),
            mounted: toast.getAttribute("data-mounted"),
          })),
        };
      }, {
        activeKey: scenario.expectedAlertLatch,
        inactiveKey: scenario.expectedInactiveAlertLatch ?? null,
      });
      assert.deepEqual(afterReload, {
        alerts: 1,
        activeWarned: true,
        inactiveWarned: false,
        toastMessages: [],
      });
    }
    if (scenario.expectPreservedAlertLatch) {
      await page.waitForTimeout(3_000);
      const beforeReload = await page.evaluate((latchKey) => {
        const raw = localStorage.getItem("balance-quota-v8");
        const state = raw ? JSON.parse(raw).state : null;
        return {
          latch: state?.alertLatches?.[latchKey] ?? false,
          alerts: state?.alerts?.length ?? 0,
          toastMessages: [...document.querySelectorAll("[data-sonner-toast]")].map((toast) =>
            toast.textContent
          ),
        };
      }, scenario.expectPreservedAlertLatch);
      assert.deepEqual(beforeReload, {
        latch: true,
        alerts: scenario.expectedPreservedAlertCount,
        toastMessages: [],
      });

      await page.reload({ waitUntil: "domcontentloaded" });
      await card.waitFor();
      await page.waitForTimeout(3_000);
      const afterReload = await page.evaluate((latchKey) => {
        const raw = localStorage.getItem("balance-quota-v8");
        const state = raw ? JSON.parse(raw).state : null;
        return {
          latch: state?.alertLatches?.[latchKey] ?? false,
          alerts: state?.alerts?.length ?? 0,
          toastMessages: [...document.querySelectorAll("[data-sonner-toast]")].map((toast) =>
            toast.textContent
          ),
        };
      }, scenario.expectPreservedAlertLatch);
      assert.deepEqual(afterReload, beforeReload);
    }
    for (const name of scenario.accessibilityNames ?? []) {
      await page.getByLabel(name, { exact: true }).waitFor({ state: "visible" });
    }
    if (scenario.bootstrapEvents?.length) {
      const l1 = page.getByTestId("quota-claude-weekly-l1");
      await l1.waitFor({ state: "visible" });
      const l1Before = await l1.textContent();
      const samplesBefore = await page.evaluate(() => {
        const raw = localStorage.getItem("balance-quota-v8");
        return raw ? (JSON.parse(raw).state.quotaSamples?.length ?? 0) : 0;
      });
      await page.waitForTimeout(3_000);
      assert.ok(scannerBodies.length > 0, "scanner must be called at least once");
      assert.equal(await l1.textContent(), l1Before);
      assert.equal(await page.evaluate(() => {
        const raw = localStorage.getItem("balance-quota-v8");
        return raw ? (JSON.parse(raw).state.quotaSamples?.length ?? 0) : 0;
      }), samplesBefore);
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
    if ((scenarioName === "full" || scenarioName === "stale" || scenarioName === "pools" || scenarioName === "historical-prior" || scenarioName === "truncated" || scenarioName === "antigravity") && viewportName === "desktop") {
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

const reportPath = "/tmp/balance-quota-source-e2e.json";
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report ${reportPath}`);
if (report.failed) process.exit(1);
