import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearOfficialCache, CODEX_USAGE_URL, GROK_BILLING_URL, readOfficialQuota } from "./official.server.ts";

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "synq-official-"));
  const grokHome = join(home, ".grok");
  mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  mkdirSync(join(grokHome, "logs"), { recursive: true });
  writeFileSync(
    join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"),
    JSON.stringify({
      version: 2,
      samples: [{ t: Date.parse("2026-08-19T17:07:00Z"), org: "x", u: { fh: 7, sd: 19 } }],
    }),
  );
  writeFileSync(
    join(grokHome, "auth.json"),
    JSON.stringify({ "https://auth.x.ai::acct": { key: "test-token", auth_mode: "oidc" } }),
  );
  writeFileSync(
    join(grokHome, "logs", "unified.jsonl"),
    `${JSON.stringify({
      ts: "2026-08-19T16:48:52.988Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 8,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-18T13:28:17Z",
            end: "2026-08-25T13:28:17Z",
          },
        },
        subscriptionTier: "X Premium+",
      },
    })}\n`,
  );
  return { home, grokHome };
}

const LIVE = {
  config: {
    creditUsagePercent: 15,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-18T13:28:17.911572+00:00",
      end: "2026-08-25T13:28:17.911572+00:00",
    },
    productUsage: [
      { product: "GrokBuild", usagePercent: 13 },
      { product: "GrokAppBuilder", usagePercent: 2 },
    ],
    prepaidBalance: { val: 0 },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
  },
};

test("readOfficialQuota prefers live Grok billing over the log", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), GROK_BILLING_URL);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-token");
    assert.equal(headers.get("x-grok-client-mode"), "cli");
    return new Response(JSON.stringify(LIVE), { status: 200, headers: { "content-type": "application/json" } });
  };
  const q = await readOfficialQuota({
    home,
    grokHome,
    now: Date.parse("2026-08-19T17:20:00Z"),
    fetchImpl,
    skipCache: true,
  });
  assert.equal(q.claude?.windowPct, 7);
  assert.equal(q.claude?.weekPct, 19);
  assert.equal(q.grok?.weekPct, 15);
  assert.equal(q.grok?.source, "billing-api");
  assert.equal(q.grok?.planLabel, "X Premium+");
  assert.equal(q.grok?.products[0]?.product, "GrokBuild");
  assert.equal(q.grok?.products[0]?.usagePercent, 13);
  assert.equal(q.grok?.products[1]?.usagePercent, 2);
  assert.equal(calls, 1);
});

test("readOfficialQuota falls back to the billing log when the API fails", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const fetchImpl: typeof fetch = async () => new Response("nope", { status: 401 });
  const q = await readOfficialQuota({ home, grokHome, fetchImpl, skipCache: true });
  assert.equal(q.grok?.weekPct, 8);
  assert.equal(q.grok?.source, "unified-billing-log");
  assert.equal(q.grok?.planLabel, "X Premium+");
});

test("readOfficialQuota caches the live billing response", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const now = Date.parse("2026-08-19T17:20:00Z");
  const a = await readOfficialQuota({ home, grokHome, now, fetchImpl, cacheMs: 30_000 });
  const b = await readOfficialQuota({ home, grokHome, now: now + 5_000, fetchImpl, cacheMs: 30_000 });
  assert.equal(a.grok?.weekPct, 15);
  assert.equal(b.grok?.weekPct, 15);
  assert.equal(calls, 1);
});

test("readOfficialQuota prefers live Codex usage over session jsonl", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const codexHome = join(home, ".codex");
  mkdirSync(join(codexHome, "sessions", "2026", "08", "20"), { recursive: true });
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "codex-token", account_id: "acct-1" } }),
  );
  writeFileSync(
    join(codexHome, "sessions", "2026", "08", "20", "rollout-2026-08-20T09-00-26-aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeee1.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-08-20T01:00:46.299Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 40, window_minutes: 10080, resets_at: 1787209839 },
          plan_type: "pro",
        },
      },
    })}\n`,
  );
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === CODEX_USAGE_URL) {
      return new Response(
        JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 1787209839 },
            secondary_window: null,
          },
          additional_rate_limits: [
            { limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 0 } } },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 401 });
  };
  const q = await readOfficialQuota({ home, grokHome, codexHome, fetchImpl, skipCache: true });
  assert.equal(q.codex?.weekPct, 57);
  assert.equal(q.codex?.source, "wham-usage");
  assert.equal(q.codex?.planLabel, "ChatGPT Pro");
  assert.equal(q.codex?.products[0]?.product, "GPT-5.3-Codex-Spark");
});

test("readOfficialQuota falls back to Codex session rate_limits when the API fails", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const codexHome = join(home, ".codex");
  mkdirSync(join(codexHome, "sessions", "2026", "08", "20"), { recursive: true });
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "codex-token", account_id: "acct-1" } }),
  );
  writeFileSync(
    join(codexHome, "sessions", "2026", "08", "20", "rollout-2026-08-20T09-00-26-aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeee1.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-08-20T01:00:46.299Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 57, window_minutes: 10080, resets_at: 1787209839 },
          plan_type: "pro",
        },
      },
    })}\n`,
  );
  const fetchImpl: typeof fetch = async () => new Response("nope", { status: 401 });
  const q = await readOfficialQuota({ home, grokHome, codexHome, fetchImpl, skipCache: true });
  assert.equal(q.codex?.weekPct, 57);
  assert.equal(q.codex?.source, "session-rate-limits");
});
