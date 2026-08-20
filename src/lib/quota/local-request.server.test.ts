import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import {
  getResponse,
  requestHandler,
} from "@tanstack/react-start/server";
import { CrossSiteRequestError } from "../auth/isolation.server.ts";
import {
  assertQuotaRequestAllowed,
  isAllowedDesktopHost,
  shouldEnforceDesktopHost,
} from "./local-request.server.ts";

const originalDesktopFlag = process.env.SYNQ_DESKTOP;

afterEach(() => {
  if (originalDesktopFlag === undefined) {
    delete process.env.SYNQ_DESKTOP;
    return;
  }
  process.env.SYNQ_DESKTOP = originalDesktopFlag;
});

type GuardResult = {
  error: unknown;
  responseStatus: number;
  responseStatusText: string;
};

async function invokeGuard(opts: {
  desktop: boolean;
  host: string;
  secFetchSite?: string;
}): Promise<GuardResult> {
  process.env.SYNQ_DESKTOP = opts.desktop ? "1" : "0";

  let error: unknown = null;
  let responseStatus = 200;
  let responseStatusText = "";

  const handler = requestHandler(() => {
    try {
      assertQuotaRequestAllowed();
      const response = getResponse();
      responseStatus = response.status ?? 200;
      responseStatusText = response.statusText ?? "";
      return new Response("ok");
    } catch (caughtError) {
      const response = getResponse();
      error = caughtError;
      responseStatus = response.status ?? 200;
      responseStatusText = response.statusText ?? "";
      return new Response("blocked", {
        status: responseStatus,
        statusText: responseStatusText || undefined,
      });
    }
  });

  await handler(
    new Request("http://127.0.0.1:4780/_serverFn/pullAgentAvailability", {
      headers: {
        host: opts.host,
        "sec-fetch-site": opts.secFetchSite ?? "same-origin",
      },
    }),
    {},
  );

  return { error, responseStatus, responseStatusText };
}

test("desktop host policy only activates in desktop runtime", () => {
  assert.equal(shouldEnforceDesktopHost({ SYNQ_DESKTOP: "1" }), true);
  assert.equal(shouldEnforceDesktopHost({ SYNQ_DESKTOP: "0" }), false);
  assert.equal(shouldEnforceDesktopHost({}), false);
});

test("desktop host policy accepts only the fixed loopback origin", () => {
  assert.equal(isAllowedDesktopHost("127.0.0.1:4780"), true);
  assert.equal(isAllowedDesktopHost("localhost:4780"), true);
  assert.equal(isAllowedDesktopHost("127.0.0.1:8080"), false);
  assert.equal(isAllowedDesktopHost("192.168.1.20:4780"), false);
  assert.equal(isAllowedDesktopHost("evil.example"), false);
  assert.equal(isAllowedDesktopHost(null), false);
});

test("desktop runtime allows same-origin quota requests on the fixed loopback host", async () => {
  const result = await invokeGuard({
    desktop: true,
    host: "127.0.0.1:4780",
  });

  assert.equal(result.error, null);
  assert.equal(result.responseStatus, 200);
  assert.equal(result.responseStatusText, "");
});

test("cross-site quota requests are marked forbidden and rethrown", async () => {
  const result = await invokeGuard({
    desktop: true,
    host: "127.0.0.1:4780",
    secFetchSite: "cross-site",
  });

  assert.ok(result.error instanceof CrossSiteRequestError);
  assert.equal(result.responseStatus, 403);
  assert.equal(result.responseStatusText, "Forbidden");
});

test("desktop runtime rejects wrong hosts with a forbidden cross-site error", async () => {
  const result = await invokeGuard({
    desktop: true,
    host: "evil.example",
  });

  assert.ok(result.error instanceof CrossSiteRequestError);
  assert.equal(result.responseStatus, 403);
  assert.equal(result.responseStatusText, "Forbidden");
});

test("non-desktop runtime does not enforce the desktop host restriction", async () => {
  const result = await invokeGuard({
    desktop: false,
    host: "evil.example",
  });

  assert.equal(result.error, null);
  assert.equal(result.responseStatus, 200);
  assert.equal(result.responseStatusText, "");
});

test("all six local quota RPC handlers invoke the request guard", async () => {
  const source = await readFile(new URL("./watch.ts", import.meta.url), "utf8");
  const calls = source.match(/assertQuotaRequestAllowed\(\)/g) ?? [];
  assert.equal(calls.length, 6);
});
