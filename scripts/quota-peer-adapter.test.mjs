import assert from "node:assert/strict";
import test from "node:test";
import {
  getRequestIP,
  requestHandler,
} from "@tanstack/react-start/server";
import { serve } from "srvx/node";

test("srvx node adapter exposes the TCP peer and ignores forged XFF", async () => {
  const fetchHandler = requestHandler(() => new Response(JSON.stringify({
    peer: getRequestIP(),
  }), { headers: { "content-type": "application/json" } }));
  const server = serve({
    manual: true,
    hostname: "127.0.0.1",
    port: 0,
    trustProxy: false,
    // requestHandler returns (request, requestOpts); srvx only passes one arg, wrap explicitly.
    fetch: (request) => fetchHandler(request, {}),
  });
  await server.serve();
  try {
    assert.ok(server.url);
    const response = await fetch(server.url, {
      headers: { "x-forwarded-for": "203.0.113.55" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { peer: "127.0.0.1" });
  } finally {
    await server.close(true);
  }
});
