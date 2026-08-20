import {
  getRequest,
  setResponseStatus,
} from "@tanstack/react-start/server";
import {
  assertSameSiteRequest,
  CrossSiteRequestError,
} from "../auth/isolation.server.ts";
import { isDesktopRuntime } from "../runtime-mode.ts";

const ALLOWED_DESKTOP_HOSTS = new Set([
  "127.0.0.1:4780",
  "localhost:4780",
]);

export function shouldEnforceDesktopHost(
  env: Readonly<{ SYNQ_DESKTOP?: string }>,
): boolean {
  return isDesktopRuntime(env);
}

export function isAllowedDesktopHost(host: string | null): boolean {
  return host !== null && ALLOWED_DESKTOP_HOSTS.has(host.toLowerCase());
}

function markForbidden(): void {
  setResponseStatus(403, "Forbidden");
}

export function assertQuotaRequestAllowed(): void {
  try {
    assertSameSiteRequest();
  } catch (error) {
    if (error instanceof CrossSiteRequestError) {
      markForbidden();
    }
    throw error;
  }

  if (!shouldEnforceDesktopHost(process.env)) {
    return;
  }

  const host = getRequest().headers.get("host");
  if (!isAllowedDesktopHost(host)) {
    markForbidden();
    throw new CrossSiteRequestError();
  }
}
