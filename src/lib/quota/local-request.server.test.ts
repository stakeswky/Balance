import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  getResponse,
  requestHandler,
} from "@tanstack/react-start/server";
import { CrossSiteRequestError } from "../auth/isolation.server.ts";
import {
  assertQuotaRequestAllowed,
  isAllowedQuotaHost,
  isLoopbackPeerAddress,
  isAllowedQuotaFetchSite,
} from "./local-request.server.ts";

type GuardResult = {
  error: unknown;
  responseStatus: number;
  responseStatusText: string;
};

async function invokeGuard(opts: {
  desktop: boolean;
  host: string;
  peerAddress?: string;
  xForwardedFor?: string;
  secFetchSite?: string | null;
  secFetchMode?: string;
  secFetchDest?: string;
  method?: string;
}): Promise<GuardResult> {
  let error: unknown = null;
  let responseStatus = 200;
  let responseStatusText = "";

  const handler = requestHandler(() => {
    try {
      assertQuotaRequestAllowed({ peerAddress: () => opts.peerAddress });
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

  const port = opts.desktop ? 4780 : 8080;
  const headers: Record<string, string> = {
    host: opts.host,
  };
  if (opts.secFetchSite !== null && opts.secFetchSite !== undefined) {
    headers["sec-fetch-site"] = opts.secFetchSite;
  }
  if (opts.secFetchMode) {
    headers["sec-fetch-mode"] = opts.secFetchMode;
  }
  if (opts.secFetchDest) {
    headers["sec-fetch-dest"] = opts.secFetchDest;
  }
  if (opts.xForwardedFor) {
    headers["x-forwarded-for"] = opts.xForwardedFor;
  }

  await handler(
    new Request(`http://127.0.0.1:${port}/_serverFn/pullAgentAvailability`, {
      method: opts.method ?? "POST",
      headers,
    }),
    {},
  );

  return { error, responseStatus, responseStatusText };
}

// --- unit tests for pure helpers ---

test("allowed quota hosts include desktop 4780 and web 8080 loopback variants", () => {
  assert.equal(isAllowedQuotaHost("127.0.0.1:4780"), true);
  assert.equal(isAllowedQuotaHost("localhost:4780"), true);
  assert.equal(isAllowedQuotaHost("[::1]:4780"), true);
  assert.equal(isAllowedQuotaHost("127.0.0.1:8080"), true);
  assert.equal(isAllowedQuotaHost("localhost:8080"), true);
  assert.equal(isAllowedQuotaHost("[::1]:8080"), true);
  assert.equal(isAllowedQuotaHost("192.168.1.20:4780"), false);
  assert.equal(isAllowedQuotaHost("evil.example"), false);
  assert.equal(isAllowedQuotaHost(null), false);
});

test("loopback peer address covers IPv4, IPv6 and mapped forms", () => {
  assert.equal(isLoopbackPeerAddress("127.0.0.1"), true);
  assert.equal(isLoopbackPeerAddress("127.0.0.2"), true);
  assert.equal(isLoopbackPeerAddress("::1"), true);
  assert.equal(isLoopbackPeerAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackPeerAddress("192.168.1.20"), false);
  assert.equal(isLoopbackPeerAddress("203.0.113.55"), false);
  assert.equal(isLoopbackPeerAddress(undefined), false);
  assert.equal(isLoopbackPeerAddress(""), false);
});

test("allowed quota fetch site accepts null, same-origin and none only", () => {
  assert.equal(isAllowedQuotaFetchSite(null), true);
  assert.equal(isAllowedQuotaFetchSite("same-origin"), true);
  assert.equal(isAllowedQuotaFetchSite("none"), true);
  assert.equal(isAllowedQuotaFetchSite("cross-site"), false);
  assert.equal(isAllowedQuotaFetchSite("same-site"), false);
});

// --- integration guard tests ---

test("loopback peer with allowed host passes the guard", async () => {
  const result = await invokeGuard({
    desktop: false,
    host: "localhost:8080",
    peerAddress: "127.0.0.1",
    secFetchSite: "same-origin",
  });
  assert.equal(result.error, null);
  assert.equal(result.responseStatus, 200);
});

test("desktop loopback peer with allowed host passes the guard", async () => {
  const result = await invokeGuard({
    desktop: true,
    host: "127.0.0.1:4780",
    peerAddress: "127.0.0.1",
    secFetchSite: "same-origin",
  });
  assert.equal(result.error, null);
  assert.equal(result.responseStatus, 200);
});

test("IPv6 loopback peer with allowed host passes the guard", async () => {
  const result = await invokeGuard({
    desktop: false,
    host: "[::1]:8080",
    peerAddress: "::1",
    secFetchSite: "same-origin",
  });
  assert.equal(result.error, null);
  assert.equal(result.responseStatus, 200);
});

test("cross-site quota requests are marked forbidden", async () => {
  const result = await invokeGuard({
    desktop: true,
    host: "127.0.0.1:4780",
    peerAddress: "127.0.0.1",
    secFetchSite: "cross-site",
  });
  assert.ok(result.error instanceof CrossSiteRequestError);
  assert.equal(result.responseStatus, 403);
});

test("wrong host with loopback peer is rejected", async () => {
  const result = await invokeGuard({
    desktop: false,
    host: "evil.example",
    peerAddress: "127.0.0.1",
    secFetchSite: "same-origin",
  });
  assert.ok(result.error instanceof CrossSiteRequestError);
  assert.equal(result.responseStatus, 403);
});

test("a remote peer cannot forge an allowed loopback host", async () => {
  const direct = await invokeGuard({
    desktop: false,
    host: "localhost:8080",
    peerAddress: "192.168.1.20",
    secFetchSite: null,
  });
  assert.ok(direct.error instanceof CrossSiteRequestError);
  assert.equal(direct.responseStatus, 403);

  const forwarded = await invokeGuard({
    desktop: false,
    host: "localhost:8080",
    peerAddress: "192.168.1.20",
    xForwardedFor: "127.0.0.1",
    secFetchSite: null,
  });
  assert.ok(forwarded.error instanceof CrossSiteRequestError);
  assert.equal(forwarded.responseStatus, 403);
});

test("the quota guard fails closed when peer address is unavailable", async () => {
  const result = await invokeGuard({
    desktop: false,
    host: "localhost:8080",
    peerAddress: undefined,
  });
  assert.ok(result.error instanceof CrossSiteRequestError);
  assert.equal(result.responseStatus, 403);
});

test("cross-site top-level GET navigation has no quota RPC exception", async () => {
  const result = await invokeGuard({
    desktop: false,
    host: "localhost:8080",
    peerAddress: "127.0.0.1",
    secFetchSite: "cross-site",
    secFetchMode: "navigate",
    secFetchDest: "document",
    method: "GET",
  });
  assert.ok(result.error instanceof CrossSiteRequestError);
  assert.equal(result.responseStatus, 403);
});

test("all local quota RPC handlers invoke the zero-arg request guard", async () => {
  const source = await readFile(new URL("./watch.ts", import.meta.url), "utf8");
  const calls = source.match(/assertQuotaRequestAllowed\(\)/g) ?? [];
  assert.equal(calls.length, 8);
});

test("xForwardedFor:true is never used in local-request.server.ts code", async () => {
  const source = await readFile(
    new URL("./local-request.server.ts", import.meta.url),
    "utf8",
  );
  // Strip single-line comments before checking — the comment explaining why we
  // DON'T pass xForwardedFor:true is fine; actual code usage is not.
  const codeOnly = source.replace(/\/\/.*$/gm, "");
  assert.equal(codeOnly.includes("xForwardedFor: true"), false);
  assert.equal(codeOnly.includes("xForwardedFor:true"), false);
});
