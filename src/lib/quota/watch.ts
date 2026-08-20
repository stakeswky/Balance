import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { detectAgentAvailability } from "./agent-availability.server";
import { scanClaudeUsage } from "./claude-log.server";
import { scanCodexUsage } from "./codex-log.server";
import { scanGrokUsage } from "./grok-log.server";
import { assertQuotaRequestAllowed } from "./local-request.server.ts";
import { readOfficialHistory, readOfficialQuota } from "./official.server";

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
