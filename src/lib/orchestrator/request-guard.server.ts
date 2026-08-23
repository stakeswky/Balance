import { createHash, timingSafeEqual } from "node:crypto";
import { setResponseStatus } from "@tanstack/react-start/server";
import { CrossSiteRequestError } from "../auth/isolation.server.ts";
import { assertQuotaRequestAllowed } from "../quota/local-request.server.ts";
import { isDesktopRuntime } from "../runtime-mode.ts";

function capabilityDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isOrchestratorCapabilityAllowed(
  authorization: string,
  expected: string | undefined,
): boolean {
  if (!expected || expected.length > 128) return false;
  return timingSafeEqual(capabilityDigest(authorization), capabilityDigest(expected));
}

export function assertOrchestratorRequestAllowed(
  authorization: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertQuotaRequestAllowed();
  if (!isDesktopRuntime(env)) return;
  if (isOrchestratorCapabilityAllowed(authorization, env.BALANCE_ORCHESTRATOR_TOKEN)) return;
  setResponseStatus(403, "Forbidden");
  throw new CrossSiteRequestError();
}
