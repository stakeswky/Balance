# 简约模式实施计划

日期：2026-08-22
基线：`origin/main@d9b34fd`
工作区：`/Volumes/data/dev/synq-minimal-mode`
分支：`feat/minimal-mode`
规格：`docs/specs/2026-08-22-minimal-mode.md`

## 硬规则

- 严格按 Step 0 → Step 1 → Step 2 → Step 3 → Step 4 执行，不跳步、不合并步骤。
- Step 1 至 Step 3 均执行测试先红、实现后绿；每步完成类型检查和构建后才能提交。
- 一步一 commit，不使用 `--no-verify`、`--amend` 或 squash。
- 每个 commit 的 `Verified-by:` footer 使用该步骤最后一次真实通过输出。
- 子代理只允许修改本计划当前步骤列出的文件；禁止扩 scope。
- `/Volumes/data` 上的验证必须把 exit code 写入 `/tmp`，输出 drain sentinel，并用 `git show HEAD` 复核提交。
- 最终合并、push、部署均不在本计划授权范围内。

## 已核对的真实接口

- `QuotaState` 位于 `src/lib/quota/store.ts:33`，现有偏好字段由 Zustand `persist` 和 `partialize` 保存。
- `SettingsPanel()` 无 props，直接通过 `useQuota` selector 读取状态，并使用 `Switch` 的 `checked`、`aria-label`、`onCheckedChange`。
- `Dashboard()` 通过 `useQuota` selector 读取状态；监控页板块位于 `src/components/balance/dashboard.tsx:493-708`。
- `AdviceCard({ meters }: { meters: readonly MeterSnapshot[] })` 位于 `src/components/balance/advice-card.tsx`，建议来源是 `routingAdvice(meters)`。
- `DualTimeline({ agents, events, now })` 的 props 是 `readonly AgentId[]`、`UsageEvent[]`、`number`，无需为了展示协同计划而扩展。
- `CardTitle` 渲染 `h2`；嵌入区使用语义上更低一级的 `h3`。
- E2E 使用 Playwright `chromium`，本地入口为 `http://127.0.0.1:8080/`，持久化 key 为 `balance-quota-v8`。

## Step 0：锁定规格与计划文档

**文件**

- `docs/specs/2026-08-22-minimal-mode.md`
- `docs/plans/2026-08-22-minimal-mode.md`

**动作**

1. 确认规格状态为“已确认”。
2. 对规格执行占位符扫描，并人工核对本计划中的每个代码块都可直接执行。
3. 在新 worktree 安装锁文件指定的依赖，并执行文档门禁：

```bash
npm ci > /tmp/synq-minimal-step0-npm-ci.log 2>&1
npm_ci_code=$?
printf '%s\n' "$npm_ci_code" > /tmp/synq-minimal-step0-npm-ci.exit
tail -n 30 /tmp/synq-minimal-step0-npm-ci.log
printf 'DRAIN_SENTINEL step0-npm-ci exit=%s\n' "$npm_ci_code"
test "$npm_ci_code" -eq 0

git add docs/specs/2026-08-22-minimal-mode.md
git add -f docs/plans/2026-08-22-minimal-mode.md
git diff --cached --check > /tmp/synq-minimal-step0-diff.log 2>&1
diff_code=$?
printf '%s\n' "$diff_code" > /tmp/synq-minimal-step0-diff.exit
tail -n 30 /tmp/synq-minimal-step0-diff.log
printf 'DRAIN_SENTINEL step0-diff exit=%s\n' "$diff_code"
test "$diff_code" -eq 0

rg -n "FIXME|待补充|待填写" docs/specs/2026-08-22-minimal-mode.md \
  > /tmp/synq-minimal-step0-placeholder.log 2>&1
placeholder_rg_code=$?
if [ "$placeholder_rg_code" -eq 1 ]; then placeholder_code=0; else placeholder_code=1; fi
printf '%s\n' "$placeholder_code" > /tmp/synq-minimal-step0-placeholder.exit
tail -n 30 /tmp/synq-minimal-step0-placeholder.log
printf 'DRAIN_SENTINEL step0-placeholder exit=%s\n' "$placeholder_code"
test "$placeholder_code" -eq 0
```

最后一条命令通过表示规格中未发现占位符。

**提交**

```bash
git commit -m "docs: define minimal dashboard mode" \
  -m "Verified-by: DRAIN_SENTINEL step0-npm-ci exit=0
Verified-by: DRAIN_SENTINEL step0-diff exit=0
Verified-by: DRAIN_SENTINEL step0-placeholder exit=0"
git show -s --format=%B HEAD | rg '^Verified-by: DRAIN_SENTINEL step0-(npm-ci|diff|placeholder) exit=0$'
git show --stat --oneline HEAD
```

**验收**

- 两份文档均进入 commit；由于 `docs/plans/` 被 `.gitignore` 忽略，添加计划文件时使用 `git add -f`。
- `git show --stat HEAD` 只包含上述两份文档。

## Step 1：持久化简约模式偏好

**文件**

- 修改 `src/lib/quota/store.test.ts`
- 修改 `src/lib/quota/store.ts`

### 1A. 先写失败测试

在 `src/lib/quota/store.test.ts` 的初始状态测试之后加入：

```ts
test("minimal mode defaults off, toggles, and is selected for persistence", () => {
  const eventsBefore = useQuota.getState().events;
  assert.equal(initialState.minimalMode, false);

  useQuota.getState().setMinimalMode(true);

  const state = useQuota.getState();
  assert.equal(state.minimalMode, true);
  assert.equal(state.events, eventsBefore);
  const partialize = useQuota.persist.getOptions().partialize;
  assert.ok(partialize);
  const persisted = partialize(state) as Partial<typeof state>;
  assert.equal(persisted.minimalMode, true);
});
```

运行：

```bash
node --test --experimental-strip-types src/lib/quota/store.test.ts \
  > /tmp/synq-minimal-step1-red.log 2>&1
red_code=$?
printf '%s\n' "$red_code" > /tmp/synq-minimal-step1-red.exit
tail -n 30 /tmp/synq-minimal-step1-red.log
printf 'DRAIN_SENTINEL step1-red exit=%s\n' "$red_code"
test "$red_code" -ne 0
```

预期失败原因：`minimalMode` 与 `setMinimalMode` 尚未存在。

### 1B. 实现完整状态契约

对 `src/lib/quota/store.ts` 应用以下精确修改：

```diff
 export interface QuotaState {
   claudePlanId: string;
   grokPlanId: string;
   codexPlanId: string;
   weekBoostPct: number;
   events: UsageEvent[];
   realEvents: UsageEvent[];
   liveClaude: boolean;
   liveGrok: boolean;
   liveCodex: boolean;
   demoMode: boolean;
+  minimalMode: boolean;
   agentAvailability: AgentAvailability;
```

```diff
   setAgentAvailability: (availability: AgentAvailability) => void;
   setOnboardingComplete: (complete: boolean) => void;
   setDemoMode: (on: boolean) => void;
+  setMinimalMode: (on: boolean) => void;
   toggleLive: (agent: AgentId) => void;
```

```diff
       liveClaude: false,
       liveGrok: false,
       liveCodex: false,
       demoMode: false,
+      minimalMode: false,
       agentAvailability: { ...EMPTY_AGENT_AVAILABILITY },
```

```diff
       setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
       setDemoMode: (on) => {
```

在 `setDemoMode` 方法结束后、`toggleLive` 方法之前加入：

```ts
      setMinimalMode: (minimalMode) => set({ minimalMode }),
```

在 `partialize` 中加入：

```diff
         liveClaude: s.liveClaude,
         liveGrok: s.liveGrok,
         liveCodex: s.liveCodex,
         demoMode: s.demoMode,
+        minimalMode: s.minimalMode,
         agentAvailability: s.agentAvailability,
```

### 1C. 验证

依次运行：

```bash
node --test --experimental-strip-types src/lib/quota/store.test.ts \
  > /tmp/synq-minimal-step1-store.log 2>&1
store_code=$?
printf '%s\n' "$store_code" > /tmp/synq-minimal-step1-store.exit
tail -n 30 /tmp/synq-minimal-step1-store.log
printf 'DRAIN_SENTINEL step1-store exit=%s\n' "$store_code"
test "$store_code" -eq 0

npm run typecheck > /tmp/synq-minimal-step1-typecheck.log 2>&1
typecheck_code=$?
printf '%s\n' "$typecheck_code" > /tmp/synq-minimal-step1-typecheck.exit
tail -n 30 /tmp/synq-minimal-step1-typecheck.log
printf 'DRAIN_SENTINEL step1-typecheck exit=%s\n' "$typecheck_code"
test "$typecheck_code" -eq 0

npm run build > /tmp/synq-minimal-step1-build.log 2>&1
build_code=$?
printf '%s\n' "$build_code" > /tmp/synq-minimal-step1-build.exit
tail -n 30 /tmp/synq-minimal-step1-build.log
printf 'DRAIN_SENTINEL step1-build exit=%s\n' "$build_code"
test "$build_code" -eq 0
```

**提交**

```bash
git add src/lib/quota/store.ts src/lib/quota/store.test.ts
git commit -m "feat(settings): persist minimal dashboard mode" \
  -m "Verified-by: DRAIN_SENTINEL step1-store exit=0
Verified-by: DRAIN_SENTINEL step1-typecheck exit=0
Verified-by: DRAIN_SENTINEL step1-build exit=0"
git show -s --format=%B HEAD | rg '^Verified-by: DRAIN_SENTINEL step1-(store|typecheck|build) exit=0$'
git show --stat --oneline HEAD
```

**验收**

- 默认值为 `false`，旧持久化数据自然合并到默认值。
- setter 只修改 `minimalMode`。
- `partialize` 保存该字段。
- store 单测、类型检查、构建全部通过。

## Step 2：把协同建议合并为时间线内的协同计划

**文件**

- 新增 `scripts/minimal-mode-e2e.mjs`
- 修改 `package.json`
- 修改 `src/components/balance/advice-card.tsx`
- 修改 `src/components/balance/dashboard.tsx`

### 2A. 先写失败的真实浏览器测试

新增 `scripts/minimal-mode-e2e.mjs`，完整内容如下：

```js
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
```

在 `package.json` 的 `scripts` 中加入：

```diff
     "screenshots:public": "node scripts/capture-public-screenshots.mjs",
+    "test:e2e:minimal": "node scripts/minimal-mode-e2e.mjs",
     "db:migrate": "node scripts/migrate.mjs",
```

启动开发服务后运行：

```bash
npm run test:e2e:minimal > /tmp/synq-minimal-step2-red.log 2>&1
red_code=$?
printf '%s\n' "$red_code" > /tmp/synq-minimal-step2-red.exit
tail -n 30 /tmp/synq-minimal-step2-red.log
printf 'DRAIN_SENTINEL step2-red exit=%s\n' "$red_code"
test "$red_code" -ne 0
```

预期失败原因：时间线卡内还没有“协同计划”。

### 2B. 实现嵌入式协同计划

将 `src/components/balance/advice-card.tsx` 完整替换为：

```tsx
import { CardHint } from "@/components/ui/card";
import { routingAdvice } from "@/lib/quota/engine";
import type { MeterSnapshot } from "@/lib/quota/types";

export function AdvicePlan({
  meters,
}: {
  meters: readonly MeterSnapshot[];
}) {
  const tips = routingAdvice(meters);
  if (!tips.length) return null;

  return (
    <section className="mt-5 border-t border-line pt-5" aria-labelledby="collaboration-plan-title">
      <h3 id="collaboration-plan-title" className="text-sm font-medium tracking-tight text-ink">
        协同计划
      </h3>
      <CardHint className="mt-1">按可见 Agent 的窗口松紧，决定下一趟任务走谁</CardHint>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {tips.map((tip) => (
          <li key={tip.title} className="rounded-md bg-raised px-3 py-3">
            <p className="text-sm font-medium">{tip.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-mute">{tip.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

在 `src/components/balance/dashboard.tsx` 中修改 import：

```diff
-import { AdviceCard } from "@/components/balance/advice-card";
+import { AdvicePlan } from "@/components/balance/advice-card";
```

在 `DualTimeline` 后加入协同计划：

```diff
                 </div>
                 <DualTimeline agents={visibleAgents} events={visibleEvents} now={now} />
+                {adviceMeters.length ? <AdvicePlan meters={adviceMeters} /> : null}
               </Card>
```

删除独立卡片渲染：

```diff
-            {adviceMeters.length ? <AdviceCard meters={adviceMeters} /> : null}
-
             <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
```

### 2C. 验证

开发服务保持运行，依次执行：

```bash
npm run test:e2e:minimal > /tmp/synq-minimal-step2-e2e.log 2>&1
e2e_code=$?
printf '%s\n' "$e2e_code" > /tmp/synq-minimal-step2-e2e.exit
tail -n 30 /tmp/synq-minimal-step2-e2e.log
printf 'DRAIN_SENTINEL step2-e2e exit=%s\n' "$e2e_code"
test "$e2e_code" -eq 0

npm run typecheck > /tmp/synq-minimal-step2-typecheck.log 2>&1
typecheck_code=$?
printf '%s\n' "$typecheck_code" > /tmp/synq-minimal-step2-typecheck.exit
tail -n 30 /tmp/synq-minimal-step2-typecheck.log
printf 'DRAIN_SENTINEL step2-typecheck exit=%s\n' "$typecheck_code"
test "$typecheck_code" -eq 0

npm run build > /tmp/synq-minimal-step2-build.log 2>&1
build_code=$?
printf '%s\n' "$build_code" > /tmp/synq-minimal-step2-build.exit
tail -n 30 /tmp/synq-minimal-step2-build.log
printf 'DRAIN_SENTINEL step2-build exit=%s\n' "$build_code"
test "$build_code" -eq 0
```

**提交**

```bash
git add scripts/minimal-mode-e2e.mjs package.json \
  src/components/balance/advice-card.tsx src/components/balance/dashboard.tsx
git commit -m "refactor(dashboard): merge collaboration plan into timeline" \
  -m "Verified-by: DRAIN_SENTINEL step2-e2e exit=0
Verified-by: DRAIN_SENTINEL step2-typecheck exit=0
Verified-by: DRAIN_SENTINEL step2-build exit=0"
git show -s --format=%B HEAD | rg '^Verified-by: DRAIN_SENTINEL step2-(e2e|typecheck|build) exit=0$'
git show --stat --oneline HEAD
```

**验收**

- “协同计划”与五小时时间轴位于同一个 Card DOM 范围。
- 页面不存在“协同建议”标题。
- 完整模式仍显示“实时流水”。
- E2E、类型检查、构建全部通过。

## Step 3：接入设置开关与简约布局

**文件**

- 修改 `scripts/minimal-mode-e2e.mjs`
- 修改 `src/components/balance/settings-panel.tsx`
- 修改 `src/components/balance/dashboard.tsx`

### 3A. 先扩展失败的真实浏览器测试

将 `scripts/minimal-mode-e2e.mjs` 完整替换为：

```js
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
]) {
  delete process.env[key];
}
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const BASE = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopShot = checkedOutputPath(
  resolve(repoRoot, "screenshots", "minimal-mode-desktop.png"),
  [repoRoot],
);
const mobileShot = checkedOutputPath(
  resolve(repoRoot, "screenshots", "minimal-mode-mobile.png"),
  [repoRoot],
);
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
            v: [
              flag(availability.claude),
              flag(availability.grok),
              flag(availability.codex),
            ],
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

function cardAround(page, heading) {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
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

async function newSeededPage(browser, { state, availability, viewport }) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
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
  await page.evaluate((persistedState) => {
    localStorage.setItem(
      "balance-quota-v8",
      JSON.stringify({ state: persistedState, version: 0 }),
    );
  }, state);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "监控", exact: true }).waitFor();
  return { context, page };
}

async function assertFullMode(page) {
  const timeline = cardAround(page, "协同时间线");
  await timeline.getByRole("heading", { name: "协同计划", exact: true }).waitFor();
  assert.equal(await timeline.getByText("5 小时滚动窗", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "协同建议", exact: true }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "实时流水", exact: true }).count(), 1);
  assert.equal(await page.getByText("当前是演示数据", { exact: false }).count(), 1);
}

async function assertMinimalMode(page) {
  await page.getByText("更紧的窗口", { exact: true }).waitFor();
  for (const heading of ["协同时间线", "Claude Code", "Grok", "Codex", "近 24 小时 token"]) {
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  }
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
  for (let index = 1; index < boxes.length; index += 1) {
    assert.ok(
      boxes[index - 1].y < boxes[index].y,
      `mobile card order failed at index ${index}`,
    );
  }
}

async function assertNonTargetViews(page) {
  await openView(page, "设置");
  await page.getByRole("heading", { name: "Claude Code 套餐", exact: true }).waitFor();
  await openView(page, "报告");
  await page.getByRole("heading", { name: "十四日热力", exact: true }).waitFor();
  await openView(page, "插件");
  await page.getByRole("heading", { name: "适配器", exact: true }).waitFor();
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

const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const { context, page } = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: true,
      minimalMode: false,
      adapterHint: true,
      agentAvailability: ALL_AGENTS,
    },
    availability: ALL_AGENTS,
    viewport: { width: 1280, height: 900 },
  });
  await page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
  await assertFullMode(page);

  await openView(page, "设置");
  const minimalSwitch = page.getByRole("switch", { name: "简约模式" });
  await minimalSwitch.waitFor();
  assert.equal(await minimalSwitch.getAttribute("data-state"), "unchecked");
  await minimalSwitch.click();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("balance-quota-v8");
    return raw ? JSON.parse(raw).state?.minimalMode === true : false;
  });
  assert.equal(await persistedMinimalMode(page), true);

  await openView(page, "监控");
  await assertMinimalMode(page);
  await assertNoOverflow(page);
  const pause = page.getByRole("button", { name: "全部暂停", exact: true });
  await pause.click();
  const resume = page.getByRole("button", { name: "开始协同", exact: true });
  await resume.waitFor();
  await resume.click();
  await page.getByRole("button", { name: "全部暂停", exact: true }).waitFor();
  await page.screenshot({ path: desktopShot, fullPage: true });
  await assertNonTargetViews(page);

  const tray = await context.newPage();
  tray.setDefaultTimeout(20_000);
  await tray.goto(new URL("/tray", BASE).toString(), { waitUntil: "domcontentloaded" });
  await tray.getByRole("heading", { name: "周限额", exact: true }).waitFor();
  await tray.getByText("3 个订阅", { exact: true }).waitFor();
  await tray.close();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "协同时间线", exact: true }).waitFor();
  await assertMinimalMode(page);
  await openView(page, "设置");
  assert.equal(
    await page.getByRole("switch", { name: "简约模式" }).getAttribute("data-state"),
    "checked",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await openView(page, "监控");
  await assertMinimalMode(page);
  await assertNoOverflow(page);
  await assertMobileOrder(page);
  await page.screenshot({ path: mobileShot, fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openView(page, "设置");
  const checkedSwitch = page.getByRole("switch", { name: "简约模式" });
  await checkedSwitch.click();
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
  assert.equal(
    await page.getByRole("switch", { name: "简约模式" }).getAttribute("data-state"),
    "unchecked",
  );

  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value() {
        throw new DOMException("storage blocked", "QuotaExceededError");
      },
    });
  });
  const blockedSwitch = page.getByRole("switch", { name: "简约模式" });
  await blockedSwitch.click();
  assert.equal(await blockedSwitch.getAttribute("data-state"), "checked");
  await openView(page, "监控");
  await assertMinimalMode(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "实时流水", exact: true }).waitFor();
  await assertFullMode(page);

  await context.close();

  const legacy = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: true,
      adapterHint: true,
      agentAvailability: ALL_AGENTS,
    },
    availability: ALL_AGENTS,
    viewport: { width: 1280, height: 900 },
  });
  await legacy.page.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
  await assertFullMode(legacy.page);
  await openView(legacy.page, "设置");
  assert.equal(
    await legacy.page.getByRole("switch", { name: "简约模式" }).getAttribute("data-state"),
    "unchecked",
  );
  await legacy.context.close();

  const single = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: false,
      minimalMode: true,
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
  assert.equal(await single.page.getByRole("heading", { name: "协同计划", exact: true }).count(), 0);
  assert.equal(
    await single.page.locator('[aria-labelledby="collaboration-plan-title"]').count(),
    0,
  );
  assert.equal(await single.page.getByRole("heading", { name: "实时流水", exact: true }).count(), 0);
  await assertNoOverflow(single.page);
  await openView(single.page, "设置");
  assert.equal(
    await single.page.getByRole("switch", { name: "简约模式" }).getAttribute("data-state"),
    "checked",
  );
  await single.context.close();

  const empty = await newSeededPage(browser, {
    state: {
      onboardingComplete: true,
      demoMode: false,
      minimalMode: true,
      adapterHint: true,
      agentAvailability: NO_AGENTS,
    },
    availability: NO_AGENTS,
    viewport: { width: 390, height: 844 },
  });
  await empty.page
    .getByRole("heading", { name: "未发现可监控 Agent", exact: true })
    .waitFor();
  await empty.page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  assert.equal(await empty.page.getByRole("heading", { name: "协同时间线", exact: true }).count(), 0);
  assert.equal(await empty.page.getByText("更紧的窗口", { exact: true }).count(), 0);
  for (const heading of ["Claude Code", "Grok", "Codex", "近 24 小时 token"]) {
    assert.equal(await empty.page.getByRole("heading", { name: heading, exact: true }).count(), 0);
  }
  await assertNoOverflow(empty.page);
  await empty.page.getByRole("button", { name: "打开设置", exact: true }).click();
  assert.equal(
    await empty.page.getByRole("switch", { name: "简约模式" }).getAttribute("data-state"),
    "checked",
  );
  await empty.context.close();

  console.log(
    "PASS minimal mode covers persistence, storage failure, full/minimal layouts, non-target views, single/zero agents, and desktop/mobile viewports",
  );
} finally {
  await browser.close();
}
```

运行：

```bash
npm run test:e2e:minimal > /tmp/synq-minimal-step3-red.log 2>&1
red_code=$?
printf '%s\n' "$red_code" > /tmp/synq-minimal-step3-red.exit
tail -n 30 /tmp/synq-minimal-step3-red.log
printf 'DRAIN_SENTINEL step3-red exit=%s\n' "$red_code"
test "$red_code" -ne 0
```

预期失败原因：设置页还没有“简约模式”开关。

### 3B. 实现设置入口

在 `src/components/balance/settings-panel.tsx` 的 selector 区加入：

```diff
   const liveClaude = useQuota((s) => s.liveClaude);
   const liveGrok = useQuota((s) => s.liveGrok);
   const liveCodex = useQuota((s) => s.liveCodex);
   const demoMode = useQuota((s) => s.demoMode);
+  const minimalMode = useQuota((s) => s.minimalMode);
   const agentAvailability = useQuota((s) => s.agentAvailability);
```

在“日志采集”Card 之后、`PlansPanel` 之前加入：

```tsx
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>简约模式</CardTitle>
            <CardHint className="mt-1">
              主页面只保留额度摘要、协同时间线、Agent 卡和 24 小时 token。
            </CardHint>
          </div>
          <Switch
            checked={minimalMode}
            aria-label="简约模式"
            onCheckedChange={(on) => {
              useQuota.getState().setMinimalMode(on);
              toast.message(on ? "已开启简约模式" : "已恢复完整模式");
            }}
          />
        </div>
      </Card>
```

### 3C. 实现主页面精简规则

在 `src/components/balance/dashboard.tsx` 的 selector 区加入：

```diff
   const liveClaude = useQuota((s) => s.liveClaude);
   const liveGrok = useQuota((s) => s.liveGrok);
   const liveCodex = useQuota((s) => s.liveCodex);
   const demoMode = useQuota((s) => s.demoMode);
+  const minimalMode = useQuota((s) => s.minimalMode);
   const claudeWriting = useQuota((s) => s.claudeWriting);
```

隐藏顶部提示条：

```diff
-        {adapterHint && view === "monitor" && visibleAgents.length ? (
+        {adapterHint && !minimalMode && view === "monitor" && visibleAgents.length ? (
```

让 token 图表在简约模式独占整行，并隐藏实时流水：

```diff
-            <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
+            <section
+              className={
+                minimalMode ? "grid gap-5" : "grid gap-5 lg:grid-cols-[1.2fr_0.8fr]"
+              }
+            >
               <Card>
                 <CardTitle>近 24 小时 token</CardTitle>
                 <CardHint className="mt-1">
                   按小时叠加，便于看 {visibleAgents.length} 路 Agent 燃烧节奏
                 </CardHint>
                 <div className="mt-3">
                   <UsageChart agents={visibleAgents} events={visibleEvents} now={now} />
                 </div>
               </Card>
-              <Card>
-                <CardTitle>实时流水</CardTitle>
-                <CardHint className="mt-1">点一条看完整会话</CardHint>
-                <div className="mt-3">
-                  <EventFeed events={visibleEvents} now={now} onOpen={setSessionId} />
-                </div>
-              </Card>
+              {!minimalMode ? (
+                <Card>
+                  <CardTitle>实时流水</CardTitle>
+                  <CardHint className="mt-1">点一条看完整会话</CardHint>
+                  <div className="mt-3">
+                    <EventFeed events={visibleEvents} now={now} onOpen={setSessionId} />
+                  </div>
+                </Card>
+              ) : null}
             </section>
```

### 3D. 验证

开发服务保持运行，依次执行：

```bash
npm run test:e2e:minimal > /tmp/synq-minimal-step3-e2e.log 2>&1
e2e_code=$?
printf '%s\n' "$e2e_code" > /tmp/synq-minimal-step3-e2e.exit
tail -n 30 /tmp/synq-minimal-step3-e2e.log
printf 'DRAIN_SENTINEL step3-e2e exit=%s\n' "$e2e_code"
test "$e2e_code" -eq 0

node --test --experimental-strip-types src/lib/quota/store.test.ts \
  > /tmp/synq-minimal-step3-store.log 2>&1
store_code=$?
printf '%s\n' "$store_code" > /tmp/synq-minimal-step3-store.exit
tail -n 30 /tmp/synq-minimal-step3-store.log
printf 'DRAIN_SENTINEL step3-store exit=%s\n' "$store_code"
test "$store_code" -eq 0

npm test > /tmp/synq-minimal-step3-test.log 2>&1
test_code=$?
printf '%s\n' "$test_code" > /tmp/synq-minimal-step3-test.exit
tail -n 30 /tmp/synq-minimal-step3-test.log
printf 'DRAIN_SENTINEL step3-test exit=%s\n' "$test_code"
test "$test_code" -eq 0

npm run lint > /tmp/synq-minimal-step3-lint.log 2>&1
lint_code=$?
printf '%s\n' "$lint_code" > /tmp/synq-minimal-step3-lint.exit
tail -n 30 /tmp/synq-minimal-step3-lint.log
printf 'DRAIN_SENTINEL step3-lint exit=%s\n' "$lint_code"
test "$lint_code" -eq 0

npm run typecheck > /tmp/synq-minimal-step3-typecheck.log 2>&1
typecheck_code=$?
printf '%s\n' "$typecheck_code" > /tmp/synq-minimal-step3-typecheck.exit
tail -n 30 /tmp/synq-minimal-step3-typecheck.log
printf 'DRAIN_SENTINEL step3-typecheck exit=%s\n' "$typecheck_code"
test "$typecheck_code" -eq 0

npm run build > /tmp/synq-minimal-step3-build.log 2>&1
build_code=$?
printf '%s\n' "$build_code" > /tmp/synq-minimal-step3-build.exit
tail -n 30 /tmp/synq-minimal-step3-build.log
printf 'DRAIN_SENTINEL step3-build exit=%s\n' "$build_code"
test "$build_code" -eq 0
```

**提交**

```bash
git add scripts/minimal-mode-e2e.mjs \
  src/components/balance/settings-panel.tsx src/components/balance/dashboard.tsx
git commit -m "feat(dashboard): add persistent minimal mode" \
  -m "Verified-by: DRAIN_SENTINEL step3-e2e exit=0
Verified-by: DRAIN_SENTINEL step3-store exit=0
Verified-by: DRAIN_SENTINEL step3-test exit=0
Verified-by: DRAIN_SENTINEL step3-lint exit=0
Verified-by: DRAIN_SENTINEL step3-typecheck exit=0
Verified-by: DRAIN_SENTINEL step3-build exit=0"
git show -s --format=%B HEAD | rg '^Verified-by: DRAIN_SENTINEL step3-(e2e|store|test|lint|typecheck|build) exit=0$'
git show --stat --oneline HEAD
```

**验收**

- 开关默认关闭，可开启、刷新保持、关闭、再次刷新保持；旧数据缺字段回落为关闭。
- localStorage 写入失败时当前会话仍可切换，刷新后安全回落为完整模式。
- 简约模式保留目标四类内容，隐藏提示条和实时流水。
- 协同计划在两种模式都位于时间线卡内部。
- 无建议时不渲染协同计划 section；单 Agent 与无 Agent 状态有独立断言。
- “全部暂停”和“开始协同”在合并后的时间线卡中可往返操作。
- token 图表卡在简约模式占满内容宽度。
- 报告、插件、设置与托盘内容在简约模式仍可访问。
- 1280×900 与 390×844 均无横向溢出，手机卡片顺序严格符合规格。
- E2E、store 单测、全量测试、lint、类型检查、构建全部通过。

## Step 4：集成终审与真实运行验收

本步骤默认不修改业务代码。若发现问题，只允许修改能复现问题的测试及直接导致问题的业务文件；先保存失败证据，再创建独立修复 commit，不改写前三个 commit。每个修复 commit 同样附真实 `Verified-by:` footer，并重新运行 Step 3D 的全部门禁。

### 4A. 对抗式终审

并行检查三个 lens：

1. correctness：持久化、默认值、完整/简约条件渲染、空态。
2. spec consistency：四类保留内容、两类隐藏内容、协同计划合并、非目标不变。
3. regression/accessibility：设置 Switch 可访问名称、heading 层级、手机溢出、完整模式实时流水。

### 4B. 真实应用路径

按 `verify-before-done` 执行：

1. 启动真实 `npm run dev`。
2. 浏览器进入设置，开启简约模式。
3. 返回监控页，核对桌面目标板块和隐藏板块。
4. 刷新并确认状态保持。
5. 切到 390×844，核对顺序和无横向滚动。
6. 关闭简约模式，返回监控页确认实时流水恢复、协同计划仍嵌在时间线。
7. 在时间线卡执行“全部暂停 → 开始协同”，确认按钮和 Agent 采集状态可往返。
8. 保存桌面和手机运行时截图，人工检查文字截断、重叠、空白和卡片宽度。

### 4C. `/Volumes/data` 防假绿命令

每条最终验证命令使用同一模式：

```bash
npm test > /tmp/synq-minimal-npm-test.log 2>&1
test_code=$?
printf '%s\n' "$test_code" > /tmp/synq-minimal-npm-test.exit
tail -n 30 /tmp/synq-minimal-npm-test.log
printf 'DRAIN_SENTINEL npm-test exit=%s\n' "$test_code"
test "$test_code" -eq 0
```

对 `npm run lint`、`npm run typecheck`、`npm run build`、`npm run test:e2e:minimal` 分别使用独立的 `/tmp/synq-minimal-*.log` 和 `.exit` 文件。

最后执行：

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git show --stat --oneline HEAD
```

## Plan 自检

### Spec coverage

| Spec 子项 | 对应步骤 |
|---|---|
| 设置开关、默认关闭、持久化 | Step 1、Step 3 |
| 简约模式四类保留内容 | Step 3 |
| 隐藏提示条、独立建议卡、实时流水 | Step 2、Step 3 |
| 协同计划合并进时间线且算法不变 | Step 2 |
| 完整模式保留实时流水 | Step 2、Step 3 |
| 暂停/开始协同按钮仍可用 | Step 3 专用 E2E、Step 4 真实验收 |
| 单 Agent、无 Agent、无建议空态 | Step 3 专用 E2E、Step 4 review |
| 旧数据与 localStorage 失败降级 | Step 1、Step 3 专用 E2E |
| 桌面和手机响应式 | Step 3 E2E、Step 4 真实验收 |
| 报告、插件、设置、托盘非目标不变 | Step 3 专用 E2E、Step 4 review |

### Placeholder scan

- 所有新增文件均给出完整内容。
- 所有修改均给出精确 diff 或完整 JSX。
- 没有未填写代码块或待定 API。

### Type consistency

- Zustand 字段与 setter 同时加入 `QuotaState`、initializer 和 `partialize`。
- `Switch.onCheckedChange` 接收布尔值，直接传给 `setMinimalMode(on)`。
- `AdvicePlan` 继续接收 `readonly MeterSnapshot[]`，不改变建议算法签名。
- `DualTimeline` 签名不变。
- Dashboard 仍用现有 `EventFeed` 和 `UsageChart` props。

### Step size

- Step 1 只建立状态契约。
- Step 2 只调整协同建议的展示位置。
- Step 3 只接入开关和条件布局。
- 每个代码步骤可在一次 agent turn 内完成并独立验证、提交。
