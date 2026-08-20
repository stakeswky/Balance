import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { scanClaudeUsage } from "./claude-log.server";
import { scanCodexUsage } from "./codex-log.server";
import { scanGrokUsage } from "./grok-log.server";
import { readOfficialHistory, readOfficialQuota } from "./official.server";

const inputSchema = z.object({
  since: z.number().nonnegative(),
});

export const pullClaudeUsage = createServerFn({ method: "POST" })
  .validator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => scanClaudeUsage(data.since));

export const pullGrokUsage = createServerFn({ method: "POST" })
  .validator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => scanGrokUsage(data.since));

export const pullCodexUsage = createServerFn({ method: "POST" })
  .validator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => scanCodexUsage(data.since));

export const pullOfficialQuota = createServerFn({ method: "GET" }).handler(async () => {
  return await readOfficialQuota();
});

export const pullOfficialHistory = createServerFn({ method: "GET" }).handler(async () => {
  return readOfficialHistory();
});
