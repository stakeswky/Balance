#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const APP_BUNDLE = resolve(
  process.env.BALANCE_DESKTOP_APP ??
    join(ROOT, "src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/Balance.app"),
);
const APP_EXECUTABLE = join(APP_BUNDLE, "Contents/MacOS/balance-desktop");
const FIXTURE = join(ROOT, "scripts/fixtures/fake-agent-cli.mjs");
const ORIGIN = "http://127.0.0.1:4780";
const STATUS_LABELS = {
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "意外中断",
};

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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function runGit(cwd, args) {
  return run("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: join(cwd, ".git-test-home"),
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function createRepository(root, name, mode = "success") {
  const repository = join(root, name);
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  writeFileSync(join(repository, "README.md"), `# ${name}\n`, { mode: 0o600 });
  if (mode !== "success") {
    writeFileSync(join(repository, ".balance-fake-mode"), `${mode}\n`, { mode: 0o600 });
  }
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["add", "README.md", ...(mode === "success" ? [] : [".balance-fake-mode"])]);
  runGit(repository, [
    "-c",
    "user.name=Balance Desktop E2E",
    "-c",
    "user.email=balance-desktop-e2e@localhost",
    "commit",
    "-m",
    "test: initialize desktop orchestration fixture",
  ]);
  return {
    path: realpathSync(repository),
    branch: runGit(repository, ["branch", "--show-current"]),
    head: runGit(repository, ["rev-parse", "HEAD"]),
  };
}

function createFakeAgentExecutable(root) {
  const executable = join(root, "balance-fake-agent.mjs");
  const source = readFileSync(FIXTURE, "utf8").replace(/^#![^\n]*\n/, `#!${process.execPath}\n`);
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
}

function readRuns(stateDirectory) {
  const runsRoot = join(stateDirectory, "runs");
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .map((entry) => {
      const path = join(runsRoot, entry.name, "run.json");
      return { path, value: JSON.parse(readFileSync(path, "utf8")) };
    })
    .sort((left, right) => left.value.createdAt - right.value.createdAt);
}

function latestRun(stateDirectory) {
  return readRuns(stateDirectory).at(-1) ?? null;
}

function readEvents(stateDirectory, runId) {
  const path = join(stateDirectory, "runs", runId, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForRun(stateDirectory, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = latestRun(stateDirectory);
    if (current && predicate(current.value)) return current;
    await sleep(100);
  }
  throw new Error(`timed out waiting for persisted run in ${stateDirectory}`);
}

function eventPids(events) {
  const pids = new Set(
    events
      .filter((record) => record.event?.type === "process_started")
      .map((record) => record.event.pid),
  );
  for (const record of events) {
    const matches = JSON.stringify(record.event).matchAll(/fake descendant PID (\d+)/g);
    for (const match of matches) pids.add(Number(match[1]));
  }
  return [...pids];
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidsGone(pids, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidAlive(pid))) return;
    await sleep(100);
  }
  throw new Error(`processes still alive: ${pids.filter(pidAlive).join(", ")}`);
}

async function waitForToken(stateDirectory, previous = null) {
  const tokenPath = join(stateDirectory, "e2e-token");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, "utf8").trim();
      if (/^[a-f0-9]{64}$/.test(token) && token !== previous) return token;
    }
    await sleep(100);
  }
  throw new Error("desktop app did not write a fresh 0600 E2E capability");
}

async function waitForHealth(app) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`desktop app exited before health: ${app.exitCode ?? app.signalCode}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/api/desktop-health`);
      if (response.ok && (await response.json()).app === "balance") return;
    } catch {
      // The native sidecar is still booting.
    }
    await sleep(100);
  }
  throw new Error("desktop sidecar health timed out");
}

function launchApp(stateDirectory, logDescriptor) {
  return spawn(APP_EXECUTABLE, [], {
    cwd: join(APP_BUNDLE, "Contents/MacOS"),
    env: { ...process.env, BALANCE_E2E_STATE_DIR: stateDirectory },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
}

async function waitForAppExit(app, timeoutMs = 30_000) {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const exited = once(app, "exit").then(() => true);
  if (await Promise.race([exited, sleep(timeoutMs).then(() => false)])) return;
  throw new Error(`desktop app ${app.pid} did not exit within ${timeoutMs}ms`);
}

async function newBrowserContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  await context.addInitScript(() => {
    localStorage.setItem(
      "balance-quota-v8",
      JSON.stringify({
        version: 2,
        state: {
          onboardingComplete: true,
          demoMode: true,
          minimalMode: true,
          agentAvailability: { claude: true, codex: true, grok: true },
          captureEnabled: { claude: true, codex: true, grok: true },
        },
      }),
    );
  });
  return context;
}

async function openDashboard(context, token) {
  const page = await context.newPage();
  const browserLog = [];
  page.on("console", (message) => browserLog.push(`[console:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => browserLog.push(`[pageerror] ${error.stack ?? error.message}`));
  page.setDefaultTimeout(30_000);
  await page.goto(`${ORIGIN}/#balance-token=${token}`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByRole("button", { name: "调度", exact: true }).waitFor();
  } catch (error) {
    await page.screenshot({
      path: join(evidenceRoot, "00-dashboard-load-failure.png"),
      fullPage: true,
    });
    writeFileSync(
      join(evidenceRoot, "00-dashboard-load-failure.txt"),
      `${browserLog.join("\n")}\n\nURL: ${page.url()}\nTITLE: ${await page.title()}\nBODY:\n${await page.locator("body").innerText()}\n`,
      { mode: 0o600 },
    );
    throw error;
  }
  return page;
}

async function openView(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}

async function configureFakeAgents(page, fakeAgentPath) {
  await openView(page, "设置");
  await page.getByTestId("native-agent-settings").waitFor();
  for (const label of ["Claude Code", "Codex CLI", "Grok CLI"]) {
    const input = page.getByRole("textbox", { name: `${label} 可执行文件路径` });
    await input.fill(fakeAgentPath);
    const unknown = page.getByRole("switch", { name: `${label} 额度未知时允许分配` });
    if ((await unknown.getAttribute("data-state")) !== "checked") await unknown.click();
  }
  await page.getByRole("button", { name: "保存并检测", exact: true }).click();
  await page.getByRole("button", { name: "保存并检测", exact: true }).waitFor({ state: "visible" });
  await page.getByText("balance-fake-agent 1.0.0", { exact: false }).first().waitFor();
  await page.waitForFunction(() => window.location.hash === "");
}

async function preparePlan(page, repository, coordinator, prompt) {
  await openView(page, "调度");
  await page.getByTestId("orchestrator-repository-input").fill(repository.path);
  await page.getByTestId("orchestrator-validate").click();
  await page.getByText(repository.path, { exact: true }).waitFor();
  await page.getByText("干净，可分析", { exact: true }).waitFor();
  await page.getByTestId("orchestrator-prompt").fill(prompt);
  await page.getByTestId("orchestrator-coordinator").selectOption(coordinator);
  await page.getByTestId("orchestrator-analyze").click();
  await page.getByTestId("orchestrator-plan").waitFor({ timeout: 60_000 });
}

async function startPreparedPlan(page) {
  const start = page.getByTestId("orchestrator-start");
  assert.equal(await start.isDisabled(), true);
  await page.getByTestId("orchestrator-trust").check();
  assert.equal(await start.isEnabled(), true);
  await start.click();
}

async function waitForUiStatus(page, status, timeoutMs = 120_000) {
  await page
    .getByText(`运行状态 · ${STATUS_LABELS[status]}`, { exact: true })
    .waitFor({ timeout: timeoutMs });
}

async function startHangingRun(page, stateDirectory, repository, coordinator) {
  await preparePlan(page, repository, coordinator, "Start the deterministic hanging tasks.");
  await startPreparedPlan(page);
  const persisted = await waitForRun(
    stateDirectory,
    (run) => run.repositoryPath === repository.path && run.status === "running",
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const events = readEvents(stateDirectory, persisted.value.id);
    if (eventPids(events).length >= 4) return { run: persisted.value, events };
    await sleep(100);
  }
  throw new Error("hanging desktop run did not expose leaders and descendants");
}

function closeNativeMainWindow(appPid) {
  run("/usr/bin/osascript", [
    "-e",
    [
      'tell application "System Events"',
      `set targetProcess to first application process whose unix id is ${appPid}`,
      "set frontmost of targetProcess to true",
      "delay 0.5",
      'keystroke "w" using command down',
      "end tell",
    ].join("\n"),
  ]);
}

function reopenNativeApp() {
  run("/usr/bin/open", [APP_BUNDLE]);
}

function quitNativeApp() {
  run("/usr/bin/osascript", ["-e", 'tell application id "com.balance.desktop" to quit']);
}

function processSnapshot(pids) {
  const output = run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,etime=,command="]);
  const wanted = new Set(pids);
  return output
    .split(/\r?\n/)
    .filter((line) => wanted.has(Number(/^\s*(\d+)/.exec(line)?.[1])))
    .join("\n");
}

if (!existsSync(APP_EXECUTABLE)) {
  throw new Error(`missing ${APP_EXECUTABLE}; run npm run desktop:build:debug first`);
}

const evidenceRoot = realpathSync(mkdtempSync(join(tmpdir(), "balance-desktop-e2e-")));
const stateDirectory = join(evidenceRoot, "state");
mkdirSync(stateDirectory, { mode: 0o700 });
const nativeLog = join(evidenceRoot, "native.log");
const logDescriptor = openSync(nativeLog, "a", 0o600);
const fakeAgentPath = createFakeAgentExecutable(evidenceRoot);
const successRepository = createRepository(evidenceRoot, "success-repository");
const cancelRepository = createRepository(evidenceRoot, "cancel-repository", "hang");
const interruptedRepository = createRepository(evidenceRoot, "interrupted-repository", "hang");

let app;
let browser;
let context;
let succeeded = false;

try {
  app = launchApp(stateDirectory, logDescriptor);
  const firstToken = await waitForToken(stateDirectory);
  await waitForHealth(app);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  context = await newBrowserContext(browser);
  let page = await openDashboard(context, firstToken);
  await configureFakeAgents(page, fakeAgentPath);

  await preparePlan(
    page,
    successRepository,
    "auto",
    "Create the two deterministic Balance desktop E2E fixture files.",
  );
  await startPreparedPlan(page);
  await waitForUiStatus(page, "completed");
  const completed = await waitForRun(
    stateDirectory,
    (run) => run.repositoryPath === successRepository.path && run.status === "completed",
  );
  assert.equal(
    runGit(successRepository.path, ["branch", "--show-current"]),
    successRepository.branch,
  );
  assert.equal(runGit(successRepository.path, ["rev-parse", "HEAD"]), successRepository.head);
  assert.equal(
    runGit(successRepository.path, [
      "rev-list",
      "--count",
      `${successRepository.head}..${completed.value.resultBranch}`,
    ]),
    "2",
  );
  await page.screenshot({
    path: join(evidenceRoot, "01-completed-result-branch.png"),
    fullPage: true,
  });

  const closeRun = await startHangingRun(page, stateDirectory, cancelRepository, "codex");
  const closePids = eventPids(closeRun.events);
  writeFileSync(
    join(evidenceRoot, "02-close-process-tree.txt"),
    `${processSnapshot([app.pid, ...closePids])}\n`,
    { mode: 0o600 },
  );
  closeNativeMainWindow(app.pid);
  await sleep(2_000);
  assert.equal(app.exitCode, null, "CloseRequested must keep the native app alive");
  assert.equal(latestRun(stateDirectory)?.value.status ?? null, "running");
  assert.equal(closePids.every(pidAlive), true, "CloseRequested must keep Agent processes alive");
  reopenNativeApp();
  await page.getByTestId("orchestrator-cancel").click();
  await waitForUiStatus(page, "cancelled");
  await waitForRun(
    stateDirectory,
    (run) => run.id === closeRun.run.id && run.status === "cancelled",
  );
  await waitForPidsGone(eventPids(readEvents(stateDirectory, closeRun.run.id)));
  await page.screenshot({
    path: join(evidenceRoot, "03-reopened-and-cancelled.png"),
    fullPage: true,
  });

  const interruptedRun = await startHangingRun(page, stateDirectory, interruptedRepository, "grok");
  const interruptedPids = eventPids(interruptedRun.events);
  const processStartsBefore = interruptedRun.events.filter(
    (record) => record.event.type === "process_started",
  ).length;
  quitNativeApp();
  await waitForAppExit(app);
  const interrupted = await waitForRun(
    stateDirectory,
    (run) => run.id === interruptedRun.run.id && run.status === "interrupted",
  );
  await waitForPidsGone([
    ...interruptedPids,
    ...eventPids(readEvents(stateDirectory, interrupted.value.id)),
  ]);
  await context.close();

  app = launchApp(stateDirectory, logDescriptor);
  const secondToken = await waitForToken(stateDirectory, firstToken);
  await waitForHealth(app);
  context = await newBrowserContext(browser);
  page = await openDashboard(context, secondToken);
  await openView(page, "调度");
  await page.getByText(interrupted.value.id, { exact: true }).first().waitFor();
  await waitForUiStatus(page, "interrupted");
  await page.getByText("仅可查看，不能自动续跑", { exact: false }).waitFor();
  await sleep(10_000);
  const processStartsAfter = readEvents(stateDirectory, interrupted.value.id).filter(
    (record) => record.event.type === "process_started",
  ).length;
  assert.equal(processStartsAfter, processStartsBefore, "restart must not auto-resume Agent work");
  await page.screenshot({
    path: join(evidenceRoot, "04-restarted-interrupted-readonly.png"),
    fullPage: true,
  });

  writeFileSync(
    join(evidenceRoot, "evidence.json"),
    `${JSON.stringify(
      {
        app: APP_EXECUTABLE,
        appPidAfterRestart: app.pid,
        completedRun: completed.value.id,
        completedResultBranch: completed.value.resultBranch,
        closeRequestedRun: closeRun.run.id,
        cancelledPids: closePids,
        interruptedRun: interrupted.value.id,
        interruptedPids,
        processStartsBefore,
        processStartsAfter,
        stateDirectory,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      desktopApp: APP_EXECUTABLE,
      completedRun: completed.value.id,
      cancelledRun: closeRun.run.id,
      interruptedRun: interrupted.value.id,
      evidenceRoot,
    }),
  );
  succeeded = true;
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (app && app.exitCode === null && app.signalCode === null) {
    try {
      quitNativeApp();
      await waitForAppExit(app);
    } catch {
      app.kill("SIGKILL");
    }
  }
  closeSync(logDescriptor);
  if (!succeeded) console.error(`desktop E2E evidence retained at ${evidenceRoot}`);
}
