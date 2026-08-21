#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

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

const origin = "http://127.0.0.1:4780";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/desktop-health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until the server boots
    }
    await sleep(250);
  }

  throw new Error("desktop server did not become healthy");
}

function replayRequest(url, headers, overrides = {}) {
  const target = new URL(url);
  const baseHeaders = {
    ...headers,
    host: target.host,
  };

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 4780,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          ...baseHeaders,
          ...overrides,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function ensureChromiumInstalled() {
  const executablePath = chromium.executablePath();
  if (existsSync(executablePath)) {
    return executablePath;
  }

  const install = spawnSync("npx", ["playwright", "install", "chromium"], {
    env: process.env,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error(`playwright install chromium failed with exit code ${install.status ?? "null"}`);
  }
  if (!existsSync(executablePath)) {
    throw new Error(`playwright chromium executable is still missing at ${executablePath}`);
  }

  return executablePath;
}

async function shutdownServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    await once(server, "close").catch(() => {});
    return;
  }

  server.kill("SIGTERM");

  const closed = once(server, "close").then(() => true);
  const timedOut = sleep(5_000).then(() => false);
  const graceful = await Promise.race([closed, timedOut]);
  if (graceful) {
    return;
  }

  server.kill("SIGKILL");
  await once(server, "close");
}

const browserExecutablePath = ensureChromiumInstalled();

const server = spawn(process.execPath, [".output/server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: "4780",
    NITRO_PORT: "4780",
    BALANCE_DESKTOP: "1",
    VITE_AUTH_ENABLED: "false",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);

let browser;
try {
  await waitForHealth();

  browser = await chromium.launch({
    executablePath: browserExecutablePath,
    headless: true,
  });
  const context = await browser.newContext({
    baseURL: origin,
  });
  const page = await context.newPage();

  const rpcPromise = page.waitForRequest(
    (request) => request.url().includes("/_serverFn/") && request.method() === "GET",
    { timeout: 15_000 },
  );

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const rpcRequest = await rpcPromise;
  const requestUrl = rpcRequest.url();
  const requestHeaders = await rpcRequest.allHeaders();

  const crossSiteStatus = await replayRequest(requestUrl, requestHeaders, {
    host: "127.0.0.1:4780",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
  });
  assert.equal(crossSiteStatus, 403, "cross-site quota RPC must return HTTP 403");

  const wrongHostStatus = await replayRequest(requestUrl, requestHeaders, {
    host: "evil.example",
    "sec-fetch-site": "same-origin",
  });
  assert.equal(wrongHostStatus, 403, "wrong desktop Host must return HTTP 403");

  console.log(
    JSON.stringify({
      requestUrl,
      crossSiteStatus,
      wrongHostStatus,
    }),
  );
} finally {
  await browser?.close();
  await shutdownServer(server);
}
