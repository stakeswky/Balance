import { createServerFn } from "@tanstack/react-start";
import { assertQuotaRequestAllowed } from "../quota/local-request.server.ts";
import { applyCheckedUpdate, checkForUpdate } from "./service.ts";

export const checkDesktopUpdate = createServerFn({ method: "GET" }).handler(async () => {
  assertQuotaRequestAllowed();
  const { local, decision } = await checkForUpdate();
  if (decision.kind === "hot") {
    return { kind: "hot" as const, local, packVersion: decision.remote.packVersion };
  }
  if (decision.kind === "installer") {
    return {
      kind: "installer" as const,
      local,
      packVersion: decision.remote.packVersion,
      url: decision.remote.installer.url,
    };
  }
  if (decision.kind === "current") {
    return { kind: "current" as const, local };
  }
  return { kind: "unavailable" as const, reason: decision.reason, local };
});

export const applyDesktopUpdate = createServerFn({ method: "POST" })
  .validator((data: unknown) => data ?? null)
  .handler(async () => {
    assertQuotaRequestAllowed();
    return applyCheckedUpdate();
  });
