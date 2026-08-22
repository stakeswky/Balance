import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { detectAgentAvailability } from "./agent-availability.server";
import { scanClaudeUsage } from "./claude-log.server";
import { scanCodexUsage } from "./codex-log.server";
import { scanGrokUsage } from "./grok-log.server";
import { assertQuotaRequestAllowed } from "./local-request.server.ts";
import { readOfficialHistory, readOfficialQuota } from "./official.server";
import { claudeStatuslineSetup, type ClaudeStatuslineSetup } from "./onboarding.ts";

const inputSchema = z.object({
  since: z.number().nonnegative(),
});

export const pullAgentAvailability = createServerFn({ method: "GET" }).handler(() => {
  assertQuotaRequestAllowed();
  return detectAgentAvailability();
});

export const pullClaudeUsage = createServerFn({ method: "POST" })
  .validator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    assertQuotaRequestAllowed();
    return scanClaudeUsage(data.since);
  });

export const pullGrokUsage = createServerFn({ method: "POST" })
  .validator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    assertQuotaRequestAllowed();
    return scanGrokUsage(data.since);
  });

export const pullCodexUsage = createServerFn({ method: "POST" })
  .validator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    assertQuotaRequestAllowed();
    return scanCodexUsage(data.since);
  });

export const pullOfficialQuota = createServerFn({ method: "GET" }).handler(async () => {
  assertQuotaRequestAllowed();
  return readOfficialQuota();
});

export const pullOfficialHistory = createServerFn({ method: "GET" }).handler(async () => {
  assertQuotaRequestAllowed();
  return readOfficialHistory();
});

// 与 collector/official.server 的 envPath 逐字同语义：空串/纯空白环境变量视为未设置。
function envPath(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

type ClaudeStatuslineSetupResponse =
  | { available: false }
  | ({ available: true } & ClaudeStatuslineSetup);

export const pullClaudeStatuslineSetup = createServerFn({ method: "GET" }).handler(
  (): ClaudeStatuslineSetupResponse => {
    assertQuotaRequestAllowed();
    const installed = envPath(process.env.BALANCE_CLAUDE_STATUSLINE_COLLECTOR);
    if (!installed || !existsSync(installed)) return { available: false };
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settings: unknown = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
    return { available: true, ...claudeStatuslineSetup(settings) };
  },
);
