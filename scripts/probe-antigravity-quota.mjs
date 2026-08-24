#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findAgyExecutable,
  readAntigravityQuota,
} from "../src/lib/quota/antigravity.server.ts";

const execFileAsync = promisify(execFile);
const SAFE_POOL_META = new Map([
  ["Gemini Models · 每周", { id: "gemini-weekly", label: "Gemini Models · 每周" }],
  ["Gemini Models · 5 小时", { id: "gemini-five-hour", label: "Gemini Models · 5 小时" }],
  ["Claude and GPT models · 每周", { id: "claude-gpt-weekly", label: "Claude and GPT models · 每周" }],
  ["Claude and GPT models · 5 小时", { id: "claude-gpt-five-hour", label: "Claude and GPT models · 5 小时" }],
]);

function fail(code) {
  process.stdout.write(`${code}\n`);
  process.exitCode = 1;
}

async function main() {
  const agyPath = findAgyExecutable();
  if (!agyPath) {
    fail("AGY_NOT_FOUND");
    return;
  }

  let version;
  try {
    const result = await execFileAsync(agyPath, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    version = String(result.stdout).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
  } catch {
    fail("QUOTA_UNAVAILABLE");
    return;
  }
  if (!version) {
    fail("QUOTA_UNAVAILABLE");
    return;
  }

  const quota = await readAntigravityQuota({ agyPath });
  if (!quota) {
    fail("QUOTA_UNAVAILABLE");
    return;
  }

  process.stdout.write(`${JSON.stringify({
    version,
    source: quota.source,
    fetchedAt: quota.fetchedAt,
    windowPct: quota.windowPct,
    weekPct: quota.weekPct,
    windowResetsAt: quota.windowResetsAt,
    weekResetsAt: quota.weekResetsAt,
    pools: (quota.quotaPools ?? []).map((pool, index) => {
      const meta = SAFE_POOL_META.get(pool.label ?? "") ?? {
        id: `antigravity-pool-${index + 1}`,
        label: `Antigravity quota pool ${index + 1}`,
      };
      return {
        ...meta,
        usagePercent: pool.usagePercent,
        resetsAt: pool.resetsAt,
      };
    }),
  })}\n`);
}

try {
  await main();
} catch {
  fail("QUOTA_UNAVAILABLE");
}
