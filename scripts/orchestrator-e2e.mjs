#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const ORIGIN = "http://127.0.0.1:4780";
const FIXTURE = resolve(ROOT, "scripts/fixtures/fake-agent-cli.mjs");
const WATCHDOG = resolve(ROOT, "src-tauri/resources/sidecar-watchdog.cjs");
const SERVER_ENTRY = resolve(ROOT, ".output/server/index.mjs");
const ALL_AGENTS = { claude: true, codex: true, grok: true };
const AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex CLI",
  grok: "Grok CLI",
};
const TERMINAL_LABELS = {
  completed: "已完成",
  failed: "失败",
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

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for file ${path}`);
}

function randomToken() {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function runGit(cwd, args, accepted = [0]) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
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
  if (!accepted.includes(result.status ?? -1)) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status ?? result.signal}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
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
    "user.name=Balance E2E",
    "-c",
    "user.email=balance-e2e@localhost",
    "commit",
    "-m",
    "test: initialize orchestration fixture",
  ]);
  return {
    path: repository,
    branch: runGit(repository, ["branch", "--show-current"]),
    head: runGit(repository, ["rev-parse", "HEAD"]),
  };
}

function createFakeAgentExecutable(root) {
  const executable = join(root, "balance-fake-agent.mjs");
  const source = readFileSync(FIXTURE, "utf8").replace(/^#![^\n]*\n/, `#!${process.execPath}\n`);
  writeFileSync(executable, source, { mode: 0o700 });
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

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

async function waitForPidsGone(pids, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidAlive(pid))) return;
    await sleep(100);
  }
  throw new Error(`native Agent processes are still alive: ${pids.filter(pidAlive).join(", ")}`);
}

async function waitForHealth(server) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `orchestrator server exited before health: ${server.exitCode ?? server.signalCode}`,
      );
    }
    try {
      const response = await fetch(`${ORIGIN}/api/desktop-health`);
      if (response.ok) return;
    } catch {
      // Continue until the loopback server is ready.
    }
    await sleep(100);
  }
  throw new Error("orchestrator E2E server did not become healthy");
}

async function startServer(stateDirectory, token, logs) {
  const environment = {
    ...process.env,
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: "4780",
    NITRO_PORT: "4780",
    BALANCE_DESKTOP: "1",
    BALANCE_STATE_DIR: stateDirectory,
    BALANCE_ORCHESTRATOR_TOKEN: token,
    BALANCE_PARENT_PID: String(process.pid),
    VITE_AUTH_ENABLED: "false",
    NODE_ENV: "production",
  };
  const server = spawn(process.execPath, ["--require", WATCHDOG, SERVER_ENTRY], {
    cwd: ROOT,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => logs.push(`[stdout] ${chunk}`));
  server.stderr.on("data", (chunk) => logs.push(`[stderr] ${chunk}`));
  await waitForHealth(server);
  return server;
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const closed = once(server, "close");
  server.stdin.write("BALANCE_SHUTDOWN\n");
  const graceful = await Promise.race([closed.then(() => true), sleep(20_000).then(() => false)]);
  if (graceful) return;
  server.kill("SIGKILL");
  await once(server, "close");
}

async function newBrowserContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  await context.addInitScript(
    ({ availability }) => {
      localStorage.setItem(
        "balance-quota-v8",
        JSON.stringify({
          version: 2,
          state: {
            onboardingComplete: true,
            demoMode: true,
            minimalMode: true,
            agentAvailability: availability,
            captureEnabled: availability,
          },
        }),
      );
    },
    { availability: ALL_AGENTS },
  );
  return context;
}

async function openDashboard(context, token) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${ORIGIN}/#balance-token=${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "");
  await page.getByRole("button", { name: "调度", exact: true }).waitFor();
  return page;
}

async function openView(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}

async function configureAgentPaths(page, paths) {
  await openView(page, "设置");
  await page.getByTestId("native-agent-settings").waitFor();
  for (const agent of ["claude", "codex", "grok"]) {
    const label = AGENT_LABELS[agent];
    const input = page.getByRole("textbox", { name: `${label} 可执行文件路径` });
    await input.waitFor({ state: "visible" });
    await input.fill(paths[agent]);
    const unknown = page.getByRole("switch", { name: `${label} 额度未知时允许分配` });
    if ((await unknown.getAttribute("data-state")) !== "checked") await unknown.click();
  }
  const save = page.getByRole("button", { name: "保存并检测", exact: true });
  await save.click();
  await page
    .getByRole("button", { name: "保存并检测", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  const detected = page.getByText("balance-fake-agent 1.0.0", { exact: false }).first();
  if (!(await detected.isVisible())) {
    const diagnostics = await page.getByTestId("native-agent-settings").innerText();
    throw new Error(`native Agent settings were not detected:\n${diagnostics}`);
  }
}

async function verifyNavigationPreservesAnalysis(page, repository) {
  const prompt = "Keep this slow analysis alive while navigating.";
  await openView(page, "调度");
  await page.getByTestId("orchestrator-repository-input").fill(repository.path);
  await page.getByTestId("orchestrator-validate").click();
  await page.getByText("干净，可分析", { exact: true }).waitFor();
  await page.getByTestId("orchestrator-prompt").fill(prompt);
  await page.getByTestId("orchestrator-coordinator").selectOption("auto");
  await page.getByTestId("orchestrator-analyze").click();
  await page
    .getByRole("button", { name: "正在拆解计划", exact: true })
    .waitFor({ state: "visible" });
  const planStartedPath = join(repository.path, ".balance-plan-started");
  const planReleasePath = join(repository.path, ".balance-plan-release");
  await waitForFile(planStartedPath);

  await openView(page, "设置");
  await page.getByTestId("native-agent-settings").waitFor({ state: "visible" });
  await openView(page, "调度");

  await page
    .getByRole("button", { name: "正在拆解计划", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.getByTestId("orchestrator-repository-input").inputValue(),
    repository.path,
  );
  assert.equal(await page.getByTestId("orchestrator-prompt").inputValue(), prompt);
  writeFileSync(planReleasePath, "release\n", { mode: 0o600 });
  await page.getByTestId("orchestrator-plan").waitFor({ state: "visible", timeout: 60_000 });
  await page.getByText("Fake CLI E2E", { exact: true }).waitFor({ state: "visible" });
  rmSync(planReleasePath, { force: true });
  rmSync(planStartedPath, { force: true });
}

async function verifyFastAnalysisHasVisibleFeedback(context, page, repository, token) {
  await page.setViewportSize({ width: 900, height: 600 });
  try {
    await openView(page, "调度");
    await page.getByTestId("orchestrator-repository-input").fill(repository.path);
    await page.getByTestId("orchestrator-validate").click();
    await page.getByText("干净，可分析", { exact: true }).waitFor();
    await page
      .getByTestId("orchestrator-prompt")
      .fill("Return a fast plan and make the completed result visible.");
    await page.getByTestId("orchestrator-coordinator").selectOption("auto");
    await page.getByTestId("orchestrator-analyze").click();

    const status = page.getByTestId("orchestrator-analysis-status");
    await status.getByText("计划已生成，共 2 项任务", { exact: true }).waitFor();
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "计划已生成，共 2 项任务" })
      .first()
      .waitFor({ state: "visible" });
    await page.getByTestId("orchestrator-plan").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const plan = document.querySelector('[data-testid="orchestrator-plan"]');
      if (!(plan instanceof HTMLElement)) return false;
      const bounds = plan.getBoundingClientRect();
      return bounds.top < window.innerHeight && bounds.bottom > 0;
    });
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
  }

  const restoredPage = await openDashboard(context, token);
  try {
    await openView(restoredPage, "调度");
    await restoredPage.getByTestId("orchestrator-plan").waitFor({ state: "visible" });
    await restoredPage.waitForTimeout(500);
    assert.equal(
      await restoredPage.locator("[data-sonner-toast]:visible").count(),
      0,
      "restoring a historical draft must not announce a new analysis",
    );
    assert.deepEqual(
      await restoredPage.evaluate(() => ({
        windowY: window.scrollY,
        mainY: document.querySelector("main")?.scrollTop ?? -1,
      })),
      { windowY: 0, mainY: 0 },
      "restoring a historical draft must not scroll as if analysis just completed",
    );
  } finally {
    await restoredPage.close();
  }
}

async function preparePlan(
  page,
  repository,
  coordinator,
  prompt,
  expectPlan = true,
  analysisTimeout = 60_000,
) {
  await openView(page, "调度");
  const repositoryInput = page.getByTestId("orchestrator-repository-input");
  await repositoryInput.fill(repository.path);
  await page.getByTestId("orchestrator-validate").click();
  await page
    .getByRole("button", { name: "校验仓库", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  const canonicalPath = page.getByText(repository.path, { exact: true });
  if (!(await canonicalPath.isVisible())) {
    const diagnostics = await page.getByTestId("orchestrator-panel").innerText();
    throw new Error(`repository validation did not succeed:\n${diagnostics}`);
  }
  await page.getByText("干净，可分析", { exact: true }).waitFor();
  await page.getByTestId("orchestrator-prompt").fill(prompt);
  await page.getByTestId("orchestrator-coordinator").selectOption(coordinator);
  await page.getByTestId("orchestrator-analyze").click();
  await page
    .getByRole("button", { name: "分析并自动分配", exact: true })
    .waitFor({ state: "visible", timeout: analysisTimeout });
  if (expectPlan && !(await page.getByTestId("orchestrator-plan").isVisible())) {
    const diagnostics = await page.getByTestId("orchestrator-panel").innerText();
    throw new Error(`plan analysis did not succeed:\n${diagnostics}`);
  }
}

async function startPreparedPlan(page) {
  const start = page.getByTestId("orchestrator-start");
  assert.equal(
    await start.isDisabled(),
    true,
    "start must remain disabled before trust confirmation",
  );
  await page.getByTestId("orchestrator-trust").check();
  assert.equal(await start.isEnabled(), true, "trust confirmation must enable start");
  await start.click();
}

async function waitForUiStatus(page, status, timeout = 120_000) {
  await page
    .getByText(`运行状态 · ${TERMINAL_LABELS[status]}`, { exact: true })
    .waitFor({ timeout });
}

async function runSuccessfulFakeWorkflow(page, stateDirectory, repository) {
  await preparePlan(
    page,
    repository,
    "claude",
    "Create the two deterministic Balance E2E fixture files with the supplied safe checks.",
  );
  const plan = page.getByTestId("orchestrator-plan");
  await plan.waitFor();
  for (const copy of [
    "Fake CLI E2E",
    "Create the alpha fixture file with deterministic content.",
    "balance-alpha.txt exists with the expected content",
    '["test","-f","balance-alpha.txt"]',
    "Create the beta fixture file with deterministic content.",
    "工作目录：独立任务 worktree",
    "最小环境：隔离 HOME/TMP",
  ]) {
    await plan.getByText(copy, { exact: false }).first().waitFor();
  }
  await startPreparedPlan(page);
  await waitForUiStatus(page, "completed");
  const persisted = await waitForRun(
    stateDirectory,
    (run) => run.repositoryPath === repository.path && run.status === "completed",
  );
  const run = persisted.value;
  assert.match(run.resultBranch, /^balance\/run-[a-f0-9]{12}-result$/);
  assert.equal(runGit(repository.path, ["branch", "--show-current"]), repository.branch);
  assert.equal(runGit(repository.path, ["rev-parse", "HEAD"]), repository.head);
  assert.equal(
    runGit(repository.path, ["rev-list", "--count", `${repository.head}..${run.resultBranch}`]),
    "2",
  );
  assert.equal(
    runGit(repository.path, ["show", `${run.resultBranch}:balance-alpha.txt`]),
    "Balance fake task alpha",
  );
  assert.equal(
    runGit(repository.path, ["show", `${run.resultBranch}:balance-beta.txt`]),
    "Balance fake task beta",
  );
  assert.equal(
    run.tasks.every((task) => task.status === "completed" && task.commitSha),
    true,
  );

  const events = readEvents(stateDirectory, run.id);
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  for (const type of [
    "process_started",
    "session_started",
    "message",
    "usage",
    "process_completed",
  ]) {
    assert.equal(
      events.some((record) => record.event.type === type),
      true,
      `missing ${type} event`,
    );
  }
  const worktrees = events
    .filter((record) => record.event.type === "message")
    .map((record) => /worktree (\S+)$/.exec(record.event.text)?.[1])
    .filter(Boolean);
  assert.equal(new Set(worktrees).size >= 2, true, "tasks must report different worktree paths");
  await waitForPidsGone(eventPids(events));
  return run;
}

async function runNonzeroWorkflow(page, stateDirectory, repository) {
  await preparePlan(
    page,
    repository,
    "codex",
    "Exercise the deterministic nonzero native Agent path.",
  );
  await page.getByTestId("orchestrator-plan").waitFor();
  await startPreparedPlan(page);
  await waitForUiStatus(page, "failed");
  const persisted = await waitForRun(
    stateDirectory,
    (run) => run.repositoryPath === repository.path && run.status === "failed",
  );
  assert.match(persisted.value.error, /code 23/);
  const events = readEvents(stateDirectory, persisted.value.id);
  assert.equal(
    events.some((record) => record.event.type === "process_failed"),
    true,
  );
  await waitForPidsGone(eventPids(events));
}

async function runBrokenPlanWorkflow(page, stateDirectory, repository) {
  const before = readRuns(stateDirectory).length;
  await preparePlan(
    page,
    repository,
    "grok",
    "Exercise the invalid structured planning output path.",
    false,
  );
  await page
    .getByRole("alert")
    .filter({ hasText: /invalid twice/i })
    .waitFor({ timeout: 60_000 });
  assert.equal(
    readRuns(stateDirectory).length,
    before,
    "invalid plans must not create a persisted run",
  );
}

async function startHangingWorkflow(page, stateDirectory, repository, coordinator) {
  await preparePlan(
    page,
    repository,
    coordinator,
    "Start deterministic hanging native Agent processes.",
  );
  await page.getByTestId("orchestrator-plan").waitFor();
  await startPreparedPlan(page);
  const persisted = await waitForRun(
    stateDirectory,
    (run) => run.repositoryPath === repository.path && run.status === "running",
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const events = readEvents(stateDirectory, persisted.value.id);
    if (eventPids(events).length >= 4) return { runId: persisted.value.id, events };
    await sleep(100);
  }
  throw new Error("hanging fixture did not report leaders and descendants");
}

async function runCloseAndCancelWorkflow(context, page, stateDirectory, token, repository) {
  const hanging = await startHangingWorkflow(page, stateDirectory, repository, "codex");
  const pids = eventPids(hanging.events);
  await page.close();
  await sleep(1_000);
  assert.equal(latestRun(stateDirectory)?.value.status ?? null, "running");
  assert.equal(pids.every(pidAlive), true, "closing the page must not stop native Agent processes");

  const restored = await openDashboard(context, token);
  await openView(restored, "调度");
  await restored.getByText(hanging.runId, { exact: true }).first().waitFor();
  await restored.getByTestId("orchestrator-cancel").click();
  await waitForUiStatus(restored, "cancelled");
  const cancelled = await waitForRun(
    stateDirectory,
    (run) => run.id === hanging.runId && run.status === "cancelled",
  );
  await waitForPidsGone(eventPids(readEvents(stateDirectory, cancelled.value.id)));
  return restored;
}

async function verifyInterruptedRestart({
  browser,
  context,
  page,
  server,
  logs,
  stateDirectory,
  repository,
}) {
  const hanging = await startHangingWorkflow(page, stateDirectory, repository, "grok");
  const pids = eventPids(hanging.events);
  await page.close();
  await stopServer(server);
  const interrupted = await waitForRun(
    stateDirectory,
    (run) => run.id === hanging.runId && run.status === "interrupted",
  );
  const beforeEvents = readEvents(stateDirectory, interrupted.value.id);
  await waitForPidsGone([...new Set([...pids, ...eventPids(beforeEvents)])]);

  const restartToken = randomToken();
  const restartedServer = await startServer(stateDirectory, restartToken, logs);
  const restartedContext = await newBrowserContext(browser);
  const restartedPage = await openDashboard(restartedContext, restartToken);
  await openView(restartedPage, "调度");
  await restartedPage.getByText(hanging.runId, { exact: true }).first().waitFor();
  await waitForUiStatus(restartedPage, "interrupted");
  await restartedPage.getByText("仅可查看，不能自动续跑", { exact: false }).waitFor();
  await sleep(10_000);
  const afterEvents = readEvents(stateDirectory, interrupted.value.id);
  assert.equal(
    afterEvents.filter((record) => record.event.type === "process_started").length,
    beforeEvents.filter((record) => record.event.type === "process_started").length,
    "restart must not automatically start another native Agent process",
  );
  await restartedContext.close();
  await context.close();
  return restartedServer;
}

function realCodexPath() {
  const configured = process.env.BALANCE_REAL_CLI_PATH;
  if (configured) return resolve(configured);
  const candidate = "/opt/homebrew/bin/codex";
  return existsSync(candidate) ? candidate : null;
}

async function runRealCliWorkflow(page, stateDirectory, repository, fakeAgentPath) {
  const codexPath = realCodexPath();
  if (!codexPath) throw new Error("BALANCE_REAL_CLI_E2E=1 but no Codex CLI was found");
  await configureAgentPaths(page, {
    claude: fakeAgentPath,
    codex: codexPath,
    grok: fakeAgentPath,
  });
  await preparePlan(
    page,
    repository,
    "codex",
    [
      "Create exactly one small task assigned to codex.",
      "That task must create only balance-e2e.txt containing a short nonsensitive success message.",
      'Its expectedFiles must be ["balance-e2e.txt"].',
      'Its only verification command must be {"executable":"test","args":["-f","balance-e2e.txt"]}.',
      "Do not request, read, or print credentials or tokens.",
    ].join(" "),
    true,
    5 * 60_000,
  );
  await page
    .getByTestId("orchestrator-plan")
    .getByText("balance-e2e.txt", { exact: false })
    .first()
    .waitFor({ timeout: 180_000 });
  await startPreparedPlan(page);
  await waitForUiStatus(page, "completed", 15 * 60_000);
  const persisted = await waitForRun(
    stateDirectory,
    (run) => run.repositoryPath === repository.path && run.status === "completed",
    15 * 60_000,
  );
  assert.equal(
    runGit(repository.path, ["cat-file", "-e", `${persisted.value.resultBranch}:balance-e2e.txt`]),
    "",
  );
  return { cli: codexPath, runId: persisted.value.id, resultBranch: persisted.value.resultBranch };
}

if (!existsSync(SERVER_ENTRY)) {
  throw new Error(`missing ${SERVER_ENTRY}; run npm run build:desktop:web first`);
}
chmodSync(FIXTURE, 0o755);

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "balance-orchestrator-e2e-")));
const stateDirectory = join(temporaryRoot, "state");
mkdirSync(stateDirectory, { mode: 0o700 });
const fakeAgentPath = createFakeAgentExecutable(temporaryRoot);
const logs = [];
let server;
let browser;
let context;
let succeeded = false;

try {
  const navigationRepository = createRepository(
    temporaryRoot,
    "navigation-repository",
    "slow-plan",
  );
  const feedbackRepository = createRepository(temporaryRoot, "feedback-repository");
  const successRepository = createRepository(temporaryRoot, "success-repository");
  const nonzeroRepository = createRepository(temporaryRoot, "nonzero-repository", "nonzero");
  const brokenRepository = createRepository(temporaryRoot, "broken-repository", "broken-plan");
  const cancelRepository = createRepository(temporaryRoot, "cancel-repository", "hang");
  const interruptedRepository = createRepository(temporaryRoot, "interrupted-repository", "hang");
  const realRepository = createRepository(temporaryRoot, "real-cli-repository");
  const token = randomToken();
  server = await startServer(stateDirectory, token, logs);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  context = await newBrowserContext(browser);
  let page = await openDashboard(context, token);
  let fake = { skipped: true, reason: "BALANCE_E2E_REAL_ONLY is 1" };
  if (process.env.BALANCE_E2E_REAL_ONLY !== "1") {
    await configureAgentPaths(page, {
      claude: fakeAgentPath,
      codex: fakeAgentPath,
      grok: fakeAgentPath,
    });
    await verifyFastAnalysisHasVisibleFeedback(context, page, feedbackRepository, token);
    await verifyNavigationPreservesAnalysis(page, navigationRepository);
    const completed = await runSuccessfulFakeWorkflow(page, stateDirectory, successRepository);
    await runNonzeroWorkflow(page, stateDirectory, nonzeroRepository);
    await runBrokenPlanWorkflow(page, stateDirectory, brokenRepository);
    page = await runCloseAndCancelWorkflow(context, page, stateDirectory, token, cancelRepository);
    server = await verifyInterruptedRestart({
      browser,
      context,
      page,
      server,
      logs,
      stateDirectory,
      repository: interruptedRepository,
    });
    fake = {
      skipped: false,
      completedRunId: completed.id,
      resultBranch: completed.resultBranch,
      scenarios: [
        "fast-analysis-visible-feedback",
        "navigation-state-preserved",
        "success",
        "nonzero",
        "broken-plan",
        "hang-cancel",
        "interrupted-restart",
      ],
    };
  }

  let realCli = { skipped: true, reason: "BALANCE_REAL_CLI_E2E is not 1" };
  if (process.env.BALANCE_REAL_CLI_E2E === "1") {
    const restartToken = randomToken();
    await context.close();
    await stopServer(server);
    server = await startServer(stateDirectory, restartToken, logs);
    context = await newBrowserContext(browser);
    page = await openDashboard(context, restartToken);
    realCli = {
      skipped: false,
      ...(await runRealCliWorkflow(page, stateDirectory, realRepository, fakeAgentPath)),
    };
  }

  console.log(
    JSON.stringify({
      fake,
      realCli,
      stateDirectory,
    }),
  );
  succeeded = true;
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopServer(server).catch(() => undefined);
  if (!succeeded) {
    writeFileSync(join(temporaryRoot, "server.log"), logs.join(""), { mode: 0o600 });
    console.error(`orchestrator E2E evidence retained at ${temporaryRoot}`);
  } else if (process.env.BALANCE_E2E_KEEP !== "1") {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
