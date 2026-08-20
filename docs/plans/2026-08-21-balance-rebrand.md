# 余量 / Balance 品牌迁移实施计划

对应规格：`docs/designs/2026-08-21-balance-rebrand.md`
日期：2026-08-21
状态：待执行
执行 worktree：`/Volumes/data/dev/synq-balance-rebrand`
执行分支：`feat/balance-rebrand`

## 0. 已验证基线与硬规则

- 基线 `HEAD`：`eb63c3867068c5c950e58545be784bd0361a5622`。
- `npm test`：274 passed，0 failed；`npm run typecheck`：exit 0。
- 主机为 Apple Silicon；Node 25.9.0、Rust/Cargo 1.88.0 可用。
- Docker/Colima 当前不可用，但本里程碑不依赖数据库容器或 testcontainers。
- 完整 Xcode 未安装；现有 Tauri 构建使用 Apple Command Line Tools，沿用已经验证的构建链。
- 主 checkout 有用户未提交截图、计划和设计文档；全部代码、测试、构建和提交只在 milestone worktree 中完成。
- 子代理只用于探索和评审；代码修改、方案取舍、提交与最终验证由主代理完成。
- 所有文件修改使用 `apply_patch`；每个实现 step 先跑出目标测试失败，再实现，再跑绿。
- 每个 commit 只显式 stage 本 step 文件；禁止 `git add .`、`--no-verify`、amend 和 squash。
- 每个 commit 使用仓库配置 `Jiamin <stakeswky@gmail.com>`，并带来自真实输出的 `Verified-by:` trailer。
- `/Volumes/data` 上所有长 Gate 写 exit code 到 `/tmp`，输出 drain sentinel，再用 `git show` 核验提交。

## Step 1：提交规格与计划

### 修改

新增：

- `docs/designs/2026-08-21-balance-rebrand.md`
- `docs/plans/2026-08-21-balance-rebrand.md`

### Gate

```bash
npx prettier --check \
  docs/designs/2026-08-21-balance-rebrand.md \
  docs/plans/2026-08-21-balance-rebrand.md
git diff --check
```

只 stage 上述两份文档。提交标题：

```text
docs: specify Balance rebrand
```

## Step 2：Web、PWA 与 README 品牌迁移

### 2.1 失败测试

新增 `scripts/balance-web-brand.test.mjs`，完整内容：

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("web and PWA surfaces use the Balance brand", () => {
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
  assert.match(settings, /余量只读本机 Agent 日志/);
  assert.doesNotMatch(settings, /Synq 只读本机 Agent 日志/);

  const pwa = read("scripts/grok-pwa-shared.mjs");
  assert.match(pwa, /export const DEFAULT_APP_NAME = "Balance"/);
  assert.doesNotMatch(pwa, /export const DEFAULT_APP_NAME = "Grok App"/);

  const pwaTest = read("scripts/grok-pwa-plugin.test.mjs");
  assert.match(pwaTest, /appNameFromHost\("localhost:8080"\), "Balance"/);
  assert.match(pwaTest, /appNameFromHost\("172\.17\.154\.217:8080"\), "Balance"/);
  assert.doesNotMatch(pwaTest, /"Grok App"/);
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
  assert.match(readme, /alt="Balance desktop quota dashboard"/);
  assert.match(readme, /alt="Balance mobile quota dashboard"/);
  assert.match(readme, /`Balance-macos-arm64`/);
  assert.match(readme, /`Balance-macos-arm64\.app\.zip`/);
  assert.doesNotMatch(readme, /`Synq-macos-arm64/);
});

test("onboarding browser assertions follow the new UI copy", () => {
  const e2e = read("scripts/onboarding-e2e.mjs");
  assert.match(e2e, /余量初始设置/);
  assert.match(e2e, /homepage is HTTP 200 with Balance title/);
  assert.match(e2e, /title\.includes\("Balance"\)/);
  assert.doesNotMatch(e2e, /Synq 初始设置/);
});
```

运行并保存失败证据：

```bash
node --test scripts/balance-web-brand.test.mjs
```

预期三个测试均因旧品牌或旧 package name 失败。

### 2.2 实现

执行以下精确替换：

| 文件                                     | 旧值                                    | 新值                                              |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `package.json`                           | `"name": "app-builder-workspace"`       | `"name": "balance"`                               |
| `package-lock.json` 顶层与根 package     | `app-builder-workspace`                 | `balance`                                         |
| `src/routes/__root.tsx`                  | `const APP_NAME = "Synq"`               | `const APP_NAME = "Balance"`                      |
| `src/routes/__root.tsx`                  | `Synq — Claude × Grok × Codex 额度监控` | `余量 / Balance — Claude × Grok × Codex 额度监控` |
| `src/components/synq/header.tsx`         | `>Synq</span>`                          | `>余量</span>`                                    |
| `src/components/synq/onboarding.tsx`     | `Synq 初始设置`                         | `余量初始设置`                                    |
| `src/components/synq/onboarding.tsx`     | `Synq 只检查本机数据目录`               | `余量只检查本机数据目录`                          |
| `src/components/synq/settings-panel.tsx` | `Synq 只读本机 Agent 日志`              | `余量只读本机 Agent 日志`                         |
| `scripts/onboarding-e2e.mjs`             | 所有用户界面断言 `Synq 初始设置`        | `余量初始设置`                                    |
| `scripts/onboarding-e2e.mjs`             | case 名与 title 断言中的 `Synq`         | `Balance`                                         |
| `scripts/grok-pwa-shared.mjs`            | `DEFAULT_APP_NAME = "Grok App"`         | `DEFAULT_APP_NAME = "Balance"`                    |
| `scripts/grok-pwa-plugin.test.mjs`       | 所有安全 fallback 期望 `Grok App`       | 所有安全 fallback 期望 `Balance`                  |

把 README 的当前产品文案精确改为：

```md
# 余量 / Balance

余量（Balance）是一个本地优先的 Claude Code、Grok CLI / Grok Build 和 Codex CLI 配额监控面板。它读取本机 Agent 会话日志和供应商官方订阅百分比，把实际模型/token 用量折算成公开 API 价格等价，并给出 5 小时窗、周窗和剩余额度区间。
```

两张图片 alt 改为 `Balance desktop quota dashboard` 与 `Balance mobile quota dashboard`。macOS 段落中的 artifact、zip 和应用名改为 `Balance-macos-arm64`、`Balance-macos-arm64.app.zip` 和 `Balance`。快速开始与隐私段落中的产品主语改为“余量”。

### 2.3 Gate 与提交

```bash
node --test scripts/balance-web-brand.test.mjs
npm test
npm run typecheck
npm run build
git diff --check
```

只 stage：

```text
README.md
package.json
package-lock.json
scripts/balance-web-brand.test.mjs
scripts/grok-pwa-plugin.test.mjs
scripts/grok-pwa-shared.mjs
scripts/onboarding-e2e.mjs
src/components/synq/header.tsx
src/components/synq/onboarding.tsx
src/components/synq/settings-panel.tsx
src/routes/__root.tsx
```

提交标题：

```text
feat: rebrand the web app as Balance
```

## Step 3：macOS 应用、DMG 和 CI 品牌迁移

### 3.1 失败测试

新增 `scripts/balance-desktop-brand.test.mjs`，完整内容：

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("Tauri publishes Balance without changing the bundle identity", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "Balance");
  assert.equal(config.identifier, "com.synq.desktop");
  assert.deepEqual(config.bundle.externalBin, ["binaries/synq-node"]);
  assert.equal(config.bundle.resources["../.output"], "synq-server");

  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /name = "synq-desktop"/);
  assert.match(cargo, /name = "synq_desktop_lib"/);
});

test("native UI and startup error use Balance while health stays compatible", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /\.title\("Balance"\)/);
  assert.match(
    rust,
    /const HEALTH_BODY: &str = "\{\\"app\\":\\"synq\\",\\"mode\\":\\"desktop\\"\}"/,
  );
  assert.match(rust, /const SIDECAR_BIN: &str = "synq-node"/);
  assert.doesNotMatch(rust, /\.title\("Synq"\)/);
  assert.doesNotMatch(rust, /Synq/);

  const errorPage = read("src-tauri/dist/startup-error.html");
  assert.match(errorPage, /<title>Balance 无法启动<\/title>/);
  assert.match(errorPage, /Balance 无法启动本地服务/);
  assert.doesNotMatch(errorPage, /Synq 无法启动/);

  const nativeSmoke = read("scripts/macos-ui-smoke.swift");
  assert.match(nativeSmoke, /title == "Balance"/);
  assert.match(nativeSmoke, /余量初始设置/);
  assert.match(nativeSmoke, /Balance 无法启动本地服务/);
  assert.doesNotMatch(nativeSmoke, /Synq/);
});

test("desktop verification and CI use Balance artifact paths", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["desktop:verify:dmg"], /Balance_0\.1\.0_aarch64\.dmg/);

  for (const script of [
    "scripts/verify-macos-app.sh",
    "scripts/verify-macos-crash-cleanup.sh",
    "scripts/verify-macos-env-isolation.sh",
    "scripts/verify-macos-startup-error.sh",
  ]) {
    const source = read(script);
    assert.match(source, /bundle\/macos\/Balance\.app/);
    assert.doesNotMatch(source, /bundle\/macos\/Synq\.app/);
  }

  const appVerifier = read("scripts/verify-macos-app.sh");
  assert.match(appVerifier, /\[ "$ui_title" != "Balance" \]/);

  const workflow = read(".github/workflows/macos-arm64.yml");
  assert.match(workflow, /bundle\/macos\/Balance\.app/);
  assert.match(workflow, /artifacts\/Balance-macos-arm64\.app\.zip/);
  assert.match(workflow, /name: Balance-macos-arm64/);
  assert.match(workflow, /Contents\/MacOS\/synq-desktop/);
  assert.match(workflow, /Contents\/MacOS\/synq-node/);
  assert.doesNotMatch(workflow, /Synq-macos-arm64/);
});
```

运行并保存失败证据：

```bash
node --test scripts/balance-desktop-brand.test.mjs
```

预期三个测试因 `Synq.app`、窗口标题、启动失败页和 artifact 旧名失败。

### 3.2 实现

执行以下精确替换：

| 文件                                      | 旧值                                          | 新值                                             |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| `src-tauri/tauri.conf.json`               | `"productName": "Synq"`                       | `"productName": "Balance"`                       |
| `src-tauri/src/lib.rs`                    | `.title("Synq")`                              | `.title("Balance")`                              |
| `src-tauri/src/lib.rs`                    | 面向人的日志与错误中的 `Synq`                 | `Balance`                                        |
| `src-tauri/dist/startup-error.html`       | 页面标题和正文中的 `Synq`                     | `Balance`                                        |
| `src-tauri/capabilities/default.json`     | `Minimal capability for Synq desktop windows` | `Minimal capability for Balance desktop windows` |
| `src-tauri/gen/schemas/capabilities.json` | 同一 description                              | Balance description                              |
| `src/lib/db.ts`                           | `Synq desktop runtime`                        | `Balance desktop runtime`                        |
| `scripts/macos-ui-smoke.swift`            | 用户可见、窗口和诊断文案中的 `Synq`           | `Balance`；onboarding 改为 `余量初始设置`        |
| 四个 `scripts/verify-macos-*.sh`          | 默认 `bundle/macos/Synq.app`                  | `bundle/macos/Balance.app`                       |
| `scripts/verify-macos-app.sh`             | `ui_title` 期望 `Synq`                        | `Balance`                                        |
| `package.json`                            | DMG `Synq_0.1.0_aarch64.dmg`                  | `Balance_0.1.0_aarch64.dmg`                      |
| `.github/workflows/macos-arm64.yml`       | `Synq.app`、Synq zip/artifact                 | `Balance.app`、Balance zip/artifact              |
| `scripts/macos-workflow.test.mjs`         | Synq zip 正则                                 | Balance zip 正则                                 |
| `scripts/tauri-scaffold.test.mjs`         | 旧标题 fallback 断言                          | 明确断言 `title == "Balance"`                    |

以下内部值必须保持原文：

```text
com.synq.desktop
synq-desktop
synq_desktop_lib
synq-node
synq-server
SYNQ_DESKTOP
SYNQ_PARENT_PID
{"app":"synq","mode":"desktop"}
127.0.0.1:4780
```

### 3.3 Gate 与提交

```bash
node --test scripts/balance-desktop-brand.test.mjs
node --test scripts/macos-workflow.test.mjs scripts/tauri-scaffold.test.mjs
npm test
npm run typecheck
npm run desktop:test
npm run desktop:build
test -d src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Balance.app
test -f src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Balance_0.1.0_aarch64.dmg
git diff --check
```

只 stage 本 step 新测试及上表实际修改文件。提交标题：

```text
feat(desktop): package Balance app artifacts
```

## Step 4：锁定升级兼容并刷新公开截图

### 4.1 失败测试

新增 `scripts/balance-upgrade-compatibility.test.mjs`，完整内容：

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("Balance keeps the Synq persistence and desktop protocol identifiers", () => {
  const store = read("src/lib/quota/store.ts");
  assert.match(store, /name: "synq-quota-v8"/);
  assert.match(store, /removeItem\("synq-quota-v7"\)/);

  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.identifier, "com.synq.desktop");

  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /const SIDECAR_HOST: &str = "127\.0\.0\.1"/);
  assert.match(rust, /const SIDECAR_PORT: u16 = 4780/);
  assert.match(rust, /\{\\"app\\":\\"synq\\",\\"mode\\":\\"desktop\\"\}/);

  const official = read("src/lib/quota/official.server.ts");
  assert.match(official, /"Application Support", "Synq", "official-quota\.json"/);
});

test("installed screenshot capture follows Balance without changing storage", () => {
  const capture = read("scripts/capture-public-screenshots.mjs");
  assert.match(capture, /\/Applications\/Balance\.app\/Contents\/Resources\/synq-server/);
  assert.doesNotMatch(capture, /\/Applications\/Synq\.app/);
  assert.match(capture, /localStorage\.setItem\("synq-quota-v8"/);
  assert.match(capture, /localStorage\.getItem\("synq-quota-v8"/);
  assert.match(capture, /余量 \/ Balance/);
  assert.match(capture, /getByText\("余量", \{ exact: true \}\)/);
});

test("native verification reads the persisted settings through the Balance UI", () => {
  const plans = read("src/components/synq/plans-panel.tsx");
  assert.match(plans, /aria-label=\{active \? `\$\{p\.name\}，当前套餐` : p\.name\}/);

  const nativeSmoke = read("scripts/macos-ui-smoke.swift");
  assert.match(nativeSmoke, /BALANCE_EXPECTED_SETTINGS/);
  assert.match(nativeSmoke, /native-persistence-ok/);
  assert.match(nativeSmoke, /，当前套餐/);

  const appVerifier = read("scripts/verify-macos-app.sh");
  assert.match(appVerifier, /BALANCE_EXPECTED_SETTINGS/);
  assert.match(appVerifier, /native-persistence-ok/);
});

test("README documents the in-place upgrade contract", () => {
  const readme = read("README.md");
  assert.match(readme, /## 从 Synq 升级/);
  assert.match(readme, /`com\.synq\.desktop`/);
  assert.match(readme, /`synq-quota-v8`/);
  assert.match(readme, /`127\.0\.0\.1:4780`/);
  assert.match(readme, /Application Support\/Synq\/official-quota\.json/);
});
```

运行并保存失败证据：

```bash
node --test scripts/balance-upgrade-compatibility.test.mjs
```

预期 installed capture 路径和 README 升级说明失败；兼容标识断言必须保持通过。

### 4.2 实现

把 `scripts/capture-public-screenshots.mjs` 的已安装 bundle 扫描路径改为：

```js
"/Applications/Balance.app/Contents/Resources/synq-server/server/_ssr",
```

在截图脚本加载页面后增加硬断言：页面 title 包含 `余量 / Balance`，且页头存在唯一的 `getByText("余量", { exact: true })`。断言失败时不得写入公开截图。

在 `src/components/synq/plans-panel.tsx` 的套餐按钮加入不会改变视觉布局的可访问名称：

```tsx
aria-label={active ? `${p.name}，当前套餐` : p.name}
```

在 `scripts/macos-ui-smoke.swift` 中完整加入以下持久化快照解析合同：

```swift
private struct PersistedSettings: Decodable {
  let claudePlanId: String
  let grokPlanId: String
  let codexPlanId: String
  let weekBoostPct: Int
  let alertWindowPct: Int
  let alertWeekPct: Int
  let onboardingComplete: Bool
}

private struct PersistenceSnapshot: Decodable {
  let version: Int
  let state: PersistedSettings
}

private let expectedSettings: PersistenceSnapshot? = {
  guard let path = ProcessInfo.processInfo.environment["BALANCE_EXPECTED_SETTINGS"] else {
    return nil
  }
  do {
    return try JSONDecoder().decode(
      PersistenceSnapshot.self,
      from: Data(contentsOf: URL(fileURLWithPath: path))
    )
  } catch {
    fail("could not decode Balance persistence snapshot: \(error)")
  }
}()

private let planNameById = [
  "claude-pro": "Claude Pro",
  "claude-max-5x": "Claude Max 5×",
  "claude-max-20x": "Claude Max 20×",
  "claude-api": "Anthropic API",
  "grok-free": "Grok",
  "grok-super": "SuperGrok",
  "grok-heavy": "SuperGrok Heavy",
  "grok-api": "xAI API",
  "chatgpt-plus": "ChatGPT Plus",
  "chatgpt-pro-5x": "ChatGPT Pro 5×",
  "chatgpt-pro-20x": "ChatGPT Pro 20×",
  "chatgpt-team": "ChatGPT Business",
  "openai-api": "OpenAI API",
]
```

把 `waitForInitialAppState` 的结果保存为 `observedInitialState`，原有 switch 使用该值。进入设置页后，如 `expectedSettings` 非空，则执行以下完整验证：

```swift
if let expected = expectedSettings {
  if expected.state.onboardingComplete,
     observedInitialState != .dashboard {
    fail("Balance did not restore the completed onboarding state")
  }

  for planId in [
    expected.state.claudePlanId,
    expected.state.grokPlanId,
    expected.state.codexPlanId,
  ] {
    guard let planName = planNameById[planId] else {
      fail("unknown persisted plan id: \(planId)")
    }
    _ = waitForButton("\(planName)，当前套餐", timeout: 10)
  }

  waitForExactText("五小时窗 \(expected.state.alertWindowPct)%", timeout: 10)
  waitForExactText("本周额度 \(expected.state.alertWeekPct)%", timeout: 10)
  waitForExactText("\(expected.state.weekBoostPct)%", timeout: 10)
  FileHandle.standardError.write(Data("native-persistence-ok\n".utf8))
}
```

`InitialAppState` 改为遵循 `Equatable`，以允许上述比较。`scripts/verify-macos-app.sh` 在 `BALANCE_EXPECTED_SETTINGS` 非空时必须断言 native smoke 的 stderr 含独立一行 `native-persistence-ok`；未出现即失败。这样安装验收会通过真实 WebKit UI 回读旧套餐、阈值、加成和 onboarding 状态，而不修改用户设置。

在 README 的 macOS app 段落后加入：

```md
## 从 Synq 升级

Balance 是 Synq 的原地品牌升级。桌面应用继续使用 bundle identifier `com.synq.desktop`、固定 origin `127.0.0.1:4780` 和持久化 key `synq-quota-v8`；官方成功快照仍位于 `~/Library/Application Support/Synq/official-quota.json`。因此覆盖安装后，既有套餐、阈值、采样设置和最后一次官方额度快照会继续可用。
```

运行新 `Balance.app` 后执行：

```bash
npm run screenshots:public
```

覆盖 README 引用的：

```text
screenshots/claude-grok-quota-desktop.png
screenshots/claude-grok-quota-mobile.png
```

截图脚本必须验证 title/页头为新品牌、官方示例值、隐私表面、错误集合和横向溢出。使用 `view_image` 人工检查两张最终 PNG。

### 4.3 Gate 与提交

```bash
node --test scripts/balance-upgrade-compatibility.test.mjs
npm run screenshots:public
npm test
npm run typecheck
git diff --check
```

只 stage：

```text
README.md
scripts/balance-upgrade-compatibility.test.mjs
scripts/capture-public-screenshots.mjs
scripts/macos-ui-smoke.swift
scripts/verify-macos-app.sh
screenshots/claude-grok-quota-desktop.png
screenshots/claude-grok-quota-mobile.png
src/components/synq/plans-panel.tsx
```

提交标题：

```text
test: lock Balance upgrade compatibility
```

## Step 5：真实 build、安装和旧数据连续性验收

### 5.1 构建 Gate

按顺序执行并分别写 `/tmp/balance-*.exit`：

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run desktop:test
npm run desktop:build
npm run desktop:verify
```

必须得到：

- JavaScript/TypeScript 测试真实通过数与 0 failed。
- lint 0 errors；既有 warning 单独记录。
- Vercel build 和 desktop node-server build 成功。
- Rust tests 0 failed。
- `Balance.app`、DMG、arm64、codesign、环境隔离、native UI、crash cleanup、startup-error 和 `hdiutil verify` 全绿。

### 5.2 安装前证据

```bash
set -euo pipefail
OLD_APP=/Applications/Synq.app
NEW_BUILD=/Volumes/data/dev/synq-balance-rebrand/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Balance.app
NEW_APP=/Applications/Balance.app
OLD_APP_BINARY="$OLD_APP/Contents/MacOS/synq-desktop"
OLD_SIDECAR_BINARY="$OLD_APP/Contents/MacOS/synq-node"
NEW_APP_BINARY="$NEW_APP/Contents/MacOS/synq-desktop"
NEW_SIDECAR_BINARY="$NEW_APP/Contents/MacOS/synq-node"

test -d "$OLD_APP"
test "$(plutil -extract CFBundleIdentifier raw "$OLD_APP/Contents/Info.plist")" = "com.synq.desktop"
test -d "$NEW_BUILD"
test "$(plutil -extract CFBundleIdentifier raw "$NEW_BUILD/Contents/Info.plist")" = "com.synq.desktop"
```

先同时退出可能存在的 Synq 与 Balance 实例。只检查精确 bundle 可执行文件；如果任一进程或 4780 listener 仍存在，则在任何移动操作前停止：

```bash
exact_pids() {
  ps -Ao pid=,command= | awk -v binary="$1" '$2 == binary { print $1 }'
}

osascript -e 'tell application "Synq" to quit' || true
osascript -e 'tell application "Balance" to quit' || true
for attempt in $(seq 1 20); do
  running=""
  for binary in \
    "$OLD_APP_BINARY" "$OLD_SIDECAR_BINARY" \
    "$NEW_APP_BINARY" "$NEW_SIDECAR_BINARY"; do
    running="$running$(exact_pids "$binary")"
  done
  listener=$(lsof -nP -iTCP:4780 -sTCP:LISTEN -t || true)
  if [ -z "$running$listener" ]; then break; fi
  sleep 0.5
done
for binary in \
  "$OLD_APP_BINARY" "$OLD_SIDECAR_BINARY" \
  "$NEW_APP_BINARY" "$NEW_SIDECAR_BINARY"; do
  test -z "$(exact_pids "$binary")"
done
test -z "$(lsof -nP -iTCP:4780 -sTCP:LISTEN -t || true)"
```

在应用完全退出后，从真实 `com.synq.desktop` WebKit LocalStorage SQLite 中只提取非敏感设置子集。数据库值是 UTF-16LE BLOB；以下函数要求恰好一个数据库和 `synq-quota-v8` 记录：

```bash
snapshot_storage() {
  output=$1
  storage_root="$HOME/Library/WebKit/com.synq.desktop/WebsiteData/Default"
  storage_db=""
  matching_rows=0
  while IFS= read -r candidate; do
    row_count=$(sqlite3 "$candidate" \
      "select count(*) from ItemTable where key='synq-quota-v8';")
    case "$row_count" in
      0) ;;
      1)
        storage_db=$candidate
        matching_rows=$((matching_rows + 1))
        ;;
      *)
        echo "unexpected duplicate synq-quota-v8 rows in $candidate" >&2
        return 1
        ;;
    esac
  done < <(find "$storage_root" -path '*/LocalStorage/localstorage.sqlite3' -type f -print)
  test "$matching_rows" -eq 1
  test -n "$storage_db"
  storage_hex=$(sqlite3 "$storage_db" \
    "select hex(value) from ItemTable where key='synq-quota-v8';")
  test -n "$storage_hex"
  printf '%s' "$storage_hex" | xxd -r -p | iconv -f UTF-16LE -t UTF-8 |
    jq -S '{version, state: {
      claudePlanId: .state.claudePlanId,
      grokPlanId: .state.grokPlanId,
      codexPlanId: .state.codexPlanId,
      weekBoostPct: .state.weekBoostPct,
      alertWindowPct: .state.alertWindowPct,
      alertWeekPct: .state.alertWeekPct,
      onboardingComplete: .state.onboardingComplete,
      captureEnabled: .state.captureEnabled
    }}' > "$output"
  jq -e '
    (.version | type == "number") and
    (.state.claudePlanId | type == "string") and
    (.state.grokPlanId | type == "string") and
    (.state.codexPlanId | type == "string") and
    (.state.onboardingComplete | type == "boolean")
  ' "$output" >/dev/null
}

snapshot_storage /tmp/balance-storage.before.json
```

官方快照保存原始可恢复副本，同时只生成 `version` 与额度 slice 的脱敏比较文件，不输出 token 或账号字段：

```bash
OFFICIAL_PATH="$HOME/Library/Application Support/Synq/official-quota.json"
rm -f /tmp/balance-official.exists
if [ -f "$OFFICIAL_PATH" ]; then
  cp "$OFFICIAL_PATH" /tmp/balance-official-quota.raw.before.json
  jq -S '{version, claudeSlice: .claude.slice}' "$OFFICIAL_PATH" \
    > /tmp/balance-official-quota.before.json
  printf '%s\n' present > /tmp/balance-official.exists
fi

find "$HOME/Library/WebKit/com.synq.desktop" -type f -print | sort \
  > /tmp/balance-webkit-files.before
wc -l /tmp/balance-webkit-files.before
```

### 5.3 安装

预检 `/Applications` 与废纸篓权限，使用唯一临时目录和原子 rename。失败 trap 会报告保留的 staging 路径；如果旧 `Balance.app` 已移走但最终 rename 失败，会先恢复旧 app：

```bash
test -w /Applications
test -d "$HOME/.Trash"
test -w "$HOME/.Trash"
INSTALL_ROOT=$(mktemp -d /Applications/.balance-install.XXXXXX)
INSTALLING="$INSTALL_ROOT/Balance.app"
PREVIOUS_ROOT=""
PREVIOUS_APP=""

install_failure() {
  status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ]; then
    if [ ! -e "$NEW_APP" ] && [ -n "$PREVIOUS_APP" ] && [ -e "$PREVIOUS_APP" ]; then
      mv "$PREVIOUS_APP" "$NEW_APP" || true
    fi
    printf 'Balance install stopped; inspect retained staging path: %s\n' "$INSTALL_ROOT" >&2
  fi
  exit "$status"
}
trap install_failure EXIT INT TERM HUP

ditto "$NEW_BUILD" "$INSTALLING"
codesign --verify --deep --strict "$INSTALLING"
test "$(plutil -extract CFBundleIdentifier raw "$INSTALLING/Contents/Info.plist")" = "com.synq.desktop"
if [ -e "$NEW_APP" ]; then
  PREVIOUS_ROOT=$(mktemp -d "$HOME/.Trash/Balance-previous.XXXXXX")
  PREVIOUS_APP="$PREVIOUS_ROOT/Balance.app"
  mv "$NEW_APP" "$PREVIOUS_APP"
fi
mv "$INSTALLING" "$NEW_APP"
rmdir "$INSTALL_ROOT"
trap - EXIT INT TERM HUP
```

禁止删除 `~/Library/Application Support/Synq`、WebKit profile、localStorage 或任何 Agent 数据目录。

### 5.4 安装版真实验收

```bash
sh scripts/verify-macos-env-isolation.sh /Applications/Balance.app
BALANCE_EXPECTED_SETTINGS=/tmp/balance-storage.before.json \
  sh scripts/verify-macos-app.sh /Applications/Balance.app
sh scripts/verify-macos-crash-cleanup.sh /Applications/Balance.app
sh scripts/verify-macos-startup-error.sh /Applications/Balance.app
```

额外验证：

```bash
open -n /Applications/Balance.app
curl --noproxy '*' -fsS http://127.0.0.1:4780/api/desktop-health
lsof -nP -iTCP:4780 -sTCP:LISTEN
```

验收：

- body 精确为 `{"app":"synq","mode":"desktop"}`。
- 只监听 `127.0.0.1:4780`。
- native 窗口标题为 `Balance`，设置页能看到本机监控，Claude/Grok/Codex 检测完成。
- 旧官方快照仍在同一路径且 JSON 可解析；新应用没有创建替代的 `Application Support/Balance` 快照。
- `com.synq.desktop` 的 WebKit/container 路径继续存在，升级没有清除其内容。
- 退出后 app、sidecar 和端口全部消失。

所有 app 验证脚本退出并确认 4780 已关闭后，重新提取同一设置子集并逐字节比较。再验证官方快照没有丢失：允许 OAuth 成功后用更晚的 slice 更新，但不允许旧 slice 变成空或时间倒退。

```bash
test -z "$(lsof -nP -iTCP:4780 -sTCP:LISTEN -t || true)"
snapshot_storage /tmp/balance-storage.after.json
cmp /tmp/balance-storage.before.json /tmp/balance-storage.after.json

if [ -f /tmp/balance-official.exists ]; then
  test -f "$OFFICIAL_PATH"
  jq -S '{version, claudeSlice: .claude.slice}' "$OFFICIAL_PATH" \
    > /tmp/balance-official-quota.after.json
  jq -e -s '
    .[0].version == .[1].version and
    (.[0].claudeSlice == null or
      (.[1].claudeSlice != null and
       (.[1].claudeSlice.fetchedAt // 0) >= (.[0].claudeSlice.fetchedAt // 0)))
  ' /tmp/balance-official-quota.before.json \
    /tmp/balance-official-quota.after.json >/dev/null
fi
test ! -f "$HOME/Library/Application Support/Balance/official-quota.json"
```

全部通过后，把旧 `/Applications/Synq.app` 移入废纸篓：

```bash
REPLACED_ROOT=$(mktemp -d "$HOME/.Trash/Synq-replaced.XXXXXX")
mv /Applications/Synq.app "$REPLACED_ROOT/Synq.app"
```

该操作可从废纸篓恢复，最终安装路径只保留 `/Applications/Balance.app`。

Step 5 不修改源码，不创建 commit。

## Step 6：终审、合并、推送与 GitHub 原地重命名

### 6.1 对抗终审

并行只读评审：

- correctness：品牌表面、测试、产物路径和构建脚本是否一致。
- compatibility/security：identifier、origin、storage key、快照、health、sidecar 和权限是否未漂移。
- publication：README、截图、作者、staged scope、仓库 rename 边界与隐私。

所有 finding 修复后重新跑对应 Gate；修复必须单独 commit，不 amend。

### 6.2 合并 main

先执行身份和权限硬 Gate；任何一项不匹配都停止，不自动改写身份：

```bash
test "$(git config user.name)" = "Jiamin"
test "$(git config user.email)" = "stakeswky@gmail.com"
test "$(gh api user --jq .login)" = "stakeswky"
test "$(gh repo view stakeswky/synq --json viewerPermission --jq .viewerPermission)" = "ADMIN"
gh auth status

bad_identity=$(
  git log --format='%an|%ae|%cn|%ce' main..feat/balance-rebrand |
    awk '$0 != "Jiamin|stakeswky@gmail.com|Jiamin|stakeswky@gmail.com"'
)
test -z "$bad_identity"
```

在主 checkout 保存用户未提交状态的机器可比快照，并拒绝 feature 与用户 untracked 路径碰撞：

```bash
cd /Volumes/data/dev/synq
git rev-parse main > /tmp/balance-main-before.sha
git status --porcelain=v1 -uall -z > /tmp/balance-main-status.before
git diff --binary > /tmp/balance-main-unstaged.before.patch
git diff --cached --binary > /tmp/balance-main-staged.before.patch
git ls-files --others --exclude-standard -z > /tmp/balance-main-untracked.before
COPYFILE_DISABLE=1 bsdtar -cf - --null --no-recursion \
  -T /tmp/balance-main-untracked.before | shasum -a 256 \
  > /tmp/balance-main-untracked-content.before.sha256
git diff --name-only -z > /tmp/balance-main-unstaged.paths.z
git diff --cached --name-only -z > /tmp/balance-main-staged.paths.z
git diff --name-only -z main...feat/balance-rebrand > /tmp/balance-feature.paths.z
perl -0 -e '
  use strict;
  use warnings;
  my ($feature_path, @user_paths) = @ARGV;
  local $/ = "\0";
  open my $feature_fh, "<", $feature_path or die "$feature_path: $!";
  my %feature;
  while (my $path = <$feature_fh>) {
    chomp $path;
    $feature{$path} = 1;
  }
  for my $user_path (@user_paths) {
    open my $user_fh, "<", $user_path or die "$user_path: $!";
    while (my $path = <$user_fh>) {
      chomp $path;
      print $path, "\0" if $feature{$path};
    }
  }
' /tmp/balance-feature.paths.z \
  /tmp/balance-main-unstaged.paths.z \
  /tmp/balance-main-staged.paths.z \
  /tmp/balance-main-untracked.before \
  > /tmp/balance-path-collisions.z
test ! -s /tmp/balance-path-collisions.z
```

然后合并：

```bash
git merge --no-ff feat/balance-rebrand -m "merge: rebrand Synq as Balance" \
  -m "Verified-by: Balance web, production, and packaged macOS E2E"
```

合并后重新生成三类快照并逐字节比较；任何差异都停止推送：

```bash
git status --porcelain=v1 -uall -z > /tmp/balance-main-status.after
git diff --binary > /tmp/balance-main-unstaged.after.patch
git diff --cached --binary > /tmp/balance-main-staged.after.patch
git diff --name-only -z > /tmp/balance-main-unstaged.after.paths.z
git diff --cached --name-only -z > /tmp/balance-main-staged.after.paths.z
git ls-files --others --exclude-standard -z > /tmp/balance-main-untracked.after
COPYFILE_DISABLE=1 bsdtar -cf - --null --no-recursion \
  -T /tmp/balance-main-untracked.after | shasum -a 256 \
  > /tmp/balance-main-untracked-content.after.sha256
cmp /tmp/balance-main-status.before /tmp/balance-main-status.after
cmp /tmp/balance-main-unstaged.before.patch /tmp/balance-main-unstaged.after.patch
cmp /tmp/balance-main-staged.before.patch /tmp/balance-main-staged.after.patch
cmp /tmp/balance-main-unstaged.paths.z /tmp/balance-main-unstaged.after.paths.z
cmp /tmp/balance-main-staged.paths.z /tmp/balance-main-staged.after.paths.z
cmp /tmp/balance-main-untracked.before /tmp/balance-main-untracked.after
cmp /tmp/balance-main-untracked-content.before.sha256 \
  /tmp/balance-main-untracked-content.after.sha256
test "$(git show -s --format='%an|%ae|%cn|%ce' HEAD)" = \
  "Jiamin|stakeswky@gmail.com|Jiamin|stakeswky@gmail.com"
git show --stat HEAD
git log --oneline -5
```

### 6.3 推送与仓库重命名

用户已授权本次 push 与仓库原地重命名。先把验证后的 main 推送到旧远端：

```bash
git push origin main:main
git fetch origin --prune
sync_counts=$(git rev-list --left-right --count origin/main...main)
test "$sync_counts" = "$(printf '0\t0')"
```

用同一个规范化函数记录迁移前后的 repo metadata、所有 branch SHA、workflow 状态、全部既有运行身份、tag 和 release；可变的 workflow run status 不进入快照。6.3 与 6.4 的命令在同一个 shell session 中连续执行，保证函数和失败 trap 可用：

```bash
snapshot_repo() {
  repo=$1
  output=$2
  meta=$(gh repo view "$repo" --json visibility,defaultBranchRef,isArchived |
    jq '{visibility, defaultBranch: .defaultBranchRef.name, isArchived}')
  branches=$(gh api --paginate --slurp "repos/$repo/branches?per_page=100" |
    jq 'add | map({name, protected, sha: .commit.sha}) | sort_by(.name)')
  workflows=$(gh workflow list -R "$repo" --all --json id,name,path,state |
    jq 'sort_by(.id)')
  runs=$(gh api --paginate --slurp "repos/$repo/actions/runs?per_page=100" |
    jq '[.[] | .workflow_runs[] |
      {id, workflow_id, name, event, head_sha}] | sort_by(.id)')
  tags=$(gh api --paginate --slurp "repos/$repo/tags?per_page=100" |
    jq 'add | map({name, sha: .commit.sha}) | sort_by(.name)')
  releases=$(gh api --paginate --slurp "repos/$repo/releases?per_page=100" |
    jq 'add | map({id, tag_name, draft, prerelease}) | sort_by(.id)')
  jq -n \
    --argjson meta "$meta" \
    --argjson branches "$branches" \
    --argjson workflows "$workflows" \
    --argjson runs "$runs" \
    --argjson tags "$tags" \
    --argjson releases "$releases" \
    '{meta: $meta, branches: $branches, workflows: $workflows,
      runs: $runs, tags: $tags, releases: $releases}' > "$output"
}

snapshot_repo stakeswky/synq /tmp/balance-repo.before.json
jq -e '.meta == {visibility:"PRIVATE",defaultBranch:"main",isArchived:false}' \
  /tmp/balance-repo.before.json
jq -e --arg main_sha "$(git rev-parse main)" \
  '.branches | any(.name == "main" and .sha == $main_sha)' \
  /tmp/balance-repo.before.json
jq -e '.branches | map(.name) | index("main") != null' /tmp/balance-repo.before.json
jq -e '.branches | map(.name) | index("publish/quota-monitoring") != null' \
  /tmp/balance-repo.before.json
jq -e '.workflows | any(.path == ".github/workflows/macos-arm64.yml" and .state == "active")' \
  /tmp/balance-repo.before.json
```

执行 rename 前安装退出 trap。任一步失败时，trap 都会重新探测服务端真实名称，把 fetch/push origin 对齐到实际仓库，并保留 `/tmp/balance-repo.before.json` 供幂等续验。流程本身同时支持“旧名尚在”和“服务端已完成但客户端命令失败”：

```bash
reconcile_remote_to_actual_repo() {
  new_owner=$(gh repo view stakeswky/Balance --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
  old_owner=$(gh repo view stakeswky/synq --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
  if [ "$new_owner" = "stakeswky/Balance" ]; then
    actual_owner=stakeswky/Balance
    actual_url=https://github.com/stakeswky/Balance
  elif [ "$old_owner" = "stakeswky/synq" ]; then
    actual_owner=stakeswky/synq
    actual_url=https://github.com/stakeswky/synq
  else
    echo "repository rename state is ambiguous" >&2
    return 2
  fi
  git remote set-url origin "$actual_url"
  git remote set-url --push origin "$actual_url"
  printf '%s\n' "$actual_owner" > /tmp/balance-repo.actual-owner
}

migration_failure() {
  status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ]; then
    reconcile_remote_to_actual_repo || true
    printf 'Balance repository migration stopped at state: %s\n' \
      "$(cat /tmp/balance-repo.actual-owner 2>/dev/null || printf unknown)" >&2
    printf '%s\n' \
      'Keep /tmp/balance-repo.before.json and rerun the idempotent rename/Gate block.' >&2
  fi
  exit "$status"
}
trap migration_failure EXIT INT TERM HUP

reconcile_remote_to_actual_repo
if [ "$(cat /tmp/balance-repo.actual-owner)" = "stakeswky/synq" ]; then
  rename_status=0
  gh repo rename -R stakeswky/synq Balance -y || rename_status=$?
  reconcile_remote_to_actual_repo
  if [ "$(cat /tmp/balance-repo.actual-owner)" != "stakeswky/Balance" ]; then
    echo "repository rename was not applied (gh status $rename_status)" >&2
    exit 1
  fi
fi
test "$(cat /tmp/balance-repo.actual-owner)" = "stakeswky/Balance"
git fetch origin --prune
```

### 6.4 远端 Gate

```bash
test "$(git remote get-url origin)" = "https://github.com/stakeswky/Balance"
test "$(git remote get-url --push origin)" = "https://github.com/stakeswky/Balance"
snapshot_repo stakeswky/Balance /tmp/balance-repo.after.json
jq 'del(.runs)' /tmp/balance-repo.before.json > /tmp/balance-repo.before.stable.json
jq 'del(.runs)' /tmp/balance-repo.after.json > /tmp/balance-repo.after.stable.json
cmp /tmp/balance-repo.before.stable.json /tmp/balance-repo.after.stable.json
jq -e -s '
  .[0].runs as $before |
  .[1].runs as $after |
  all($before[]; . as $run | any($after[]; . == $run))
' /tmp/balance-repo.before.json /tmp/balance-repo.after.json >/dev/null

sync_counts=$(git rev-list --left-right --count origin/main...main)
test "$sync_counts" = "$(printf '0\t0')"
base_sha=$(cat /tmp/balance-main-before.sha)
bad_identity=$(
  git log --format='%an|%ae|%cn|%ce' "$base_sha"..origin/main |
    awk '$0 != "Jiamin|stakeswky@gmail.com|Jiamin|stakeswky@gmail.com"'
)
test -z "$bad_identity"

git ls-remote --heads --tags origin
gh repo view stakeswky/Balance \
  --json name,nameWithOwner,defaultBranchRef,visibility,isArchived,url,viewerPermission
gh workflow list -R stakeswky/Balance --all
gh run list -R stakeswky/Balance --limit 20
trap - EXIT INT TERM HUP
```

验收：

- `main` 本地/远端为 0 ahead、0 behind。
- 仓库为 `stakeswky/Balance`、默认 `main`、PRIVATE、未 archived。
- `main` 与 `publish/quota-monitoring` SHA 与 rename 前一致；这里的 rename 前快照是在 feature 合并并成功 push 后生成，`main` 已经是最终 merge commit。
- workflow 保持 active，所有 rename 前的 run 身份仍存在；允许 push 异步产生新 run，tag/release 数量不变。
- 新 commit 和 merge commit 作者/提交者均为 `Jiamin <stakeswky@gmail.com>`。
- 三份主 checkout 快照逐字节一致，用户的 tracked diff 和 untracked 文件都没有被 stage、改写或提交。
- 如果 rename 未发生、已经发生或中途 Gate 失败，失败 trap 都把 `origin` 对齐到服务端真实仓库；保留迁移前快照后可幂等重跑 rename/Gate，不执行破坏性的自动回滚。

最后移除 milestone worktree；不删除主 checkout 中用户原有未提交文件。

## 7. 四关自检

### Spec coverage

覆盖 Web/PWA、README、package slug、macOS 窗口/app/DMG/artifact、旧数据连续性、真实安装、截图、作者、merge/push 和 GitHub 原地重命名。规格中的每个包含项均映射到 Step 2 至 Step 6。

### Placeholder scan

新增三个测试文件均给出完整可执行代码；所有修改都有精确字符串或完整 Markdown 内容；所有命令使用明确路径和目标，没有未完成标记、伪代码或省略实现。

### Type consistency

- React 只修改字符串常量，不改变组件 prop 或路由类型。
- Tauri 继续使用现有 `productName`、`identifier` 和 Rust `WebviewWindowBuilder.title` API。
- workflow 只改路径和 artifact 名，action SHA 与 job 顺序不变。
- Zustand `persist` 配置、官方快照函数、健康 route、Rust parser 和 sidecar 类型不变。

### Step size

- Step 2 是独立 Web/README 品牌单元。
- Step 3 是独立 desktop distribution 品牌单元。
- Step 4 是独立升级兼容与公开截图单元。
- Step 5 是无源码变更的真实安装验收。
- Step 6 是终审、集成和已授权的外部 rename 操作。
