import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ANTIGRAVITY_SUMMARY_FIXTURE } from "./antigravity.test-fixture.ts";
import {
  CLAUDE_USAGE_STALE_MS,
  CLAUDE_USAGE_URL,
  claudeDesktopManagedPids,
  claudeOauthAuthFromCredentials,
  claudeOauthAuthFromProcessEnvironment,
  claudeRetryAfterMs,
  claudeSnapshotPath,
  claudeStatuslineSnapshotPath,
  clearOfficialCache,
  CODEX_USAGE_URL,
  GROK_BILLING_URL,
  legacyClaudeSnapshotPath,
  officialFilesMtime,
  readClaudeOauthAuth,
  readClaudeStatuslineSnapshot,
  readOfficialQuota as readOfficialQuotaImpl,
  resolveClaudeSnapshotPath,
} from "./official.server.ts";
import { parseAntigravityQuotaSummary } from "./official.ts";

const readOfficialQuota: typeof readOfficialQuotaImpl = (options) => readOfficialQuotaImpl({
  ...options,
  readAntigravityIdentity: options?.readAntigravityIdentity ?? (async () => null),
  readAntigravity: options?.readAntigravity ?? (async () => null),
});

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "balance-official-"));
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

test("readOfficialQuota reads the official Fable percent from Claude OAuth usage", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer claude-token");
      assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 34, resets_at: "2026-08-20T15:00:00Z" },
          seven_day: { utilization: 27, resets_at: "2026-08-25T20:59:00Z" },
          limits: [
            {
              kind: "weekly_scoped",
              scope: { model: { display_name: "Fable" } },
              percent: 24,
              resets_at: "2026-08-25T20:59:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const q = await readOfficialQuota({
    home,
    grokHome,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  assert.equal(q.claude?.windowPct, 34);
  assert.equal(q.claude?.weekPct, 27);
  assert.equal(q.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(q.claude?.source, "oauth-usage");
});

test("readOfficialQuota keeps desktop 5h and 7d without inventing Fable after a 429", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const q = await readOfficialQuota({
    home,
    grokHome,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  assert.equal(q.claude?.windowPct, 7);
  assert.equal(q.claude?.weekPct, 19);
  assert.equal(q.claude?.modelWeekLimits?.fable, undefined);
  assert.equal(q.claude?.source, "plan-usage-history");
});

test("Claude usage cache keeps a successful Fable snapshot for at most 60 minutes", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      if (claudeCalls > 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({
          seven_day: { utilization: 27, resets_at: "2026-08-25T20:59:00Z" },
          limits: [
            {
              kind: "weekly_scoped",
              scope: { model: { display_name: "Fable" } },
              percent: 24,
              resets_at: "2026-08-25T20:59:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) =>
    readOfficialQuota({
      home,
      grokHome,
      fetchImpl,
      cacheMs: 30_000,
      readClaudeAuth: async () => ({ accessToken: "claude-token" }),
      now: at,
    });

  const first = await readAt(now);
  const fresh = await readAt(now + 5_000);
  const stale = await readAt(now + 30_001);
  const expired = await readAt(now + CLAUDE_USAGE_STALE_MS + 30_002);

  assert.equal(first.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(fresh.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(stale.claude?.modelWeekLimits?.fable?.usedPct, 24);
  assert.equal(expired.claude?.modelWeekLimits?.fable, undefined);
  assert.equal(claudeCalls, 3);
});

test("Claude 429 Retry-After suppresses repeated OAuth requests even with skipCache", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      if (claudeCalls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      }
      return new Response(JSON.stringify({ five_hour: 24, seven_day: 34 }), { status: 200 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  await readAt(now);
  await readAt(now + 30_000);
  assert.equal(claudeCalls, 1);
  const recovered = await readAt(now + 120_001);
  assert.equal(claudeCalls, 2);
  assert.equal(recovered.claude?.windowPct, 24);
  assert.equal(recovered.claude?.weekPct, 34);
});

test("Claude failures back off exponentially and success resets the sequence", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) !== CLAUDE_USAGE_URL) {
      return new Response(JSON.stringify(LIVE), { status: 200 });
    }
    claudeCalls += 1;
    if (claudeCalls === 1 || claudeCalls === 2 || claudeCalls === 4) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({ five_hour: 24, seven_day: 34 }), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  await readAt(now);
  await readAt(now + 29_999);
  assert.equal(claudeCalls, 1);
  await readAt(now + 30_000);
  await readAt(now + 89_999);
  assert.equal(claudeCalls, 2);
  await readAt(now + 90_000);
  assert.equal(claudeCalls, 3);
  await readAt(now + 90_001);
  await readAt(now + 120_000);
  assert.equal(claudeCalls, 4);
  await readAt(now + 120_001);
  assert.equal(claudeCalls, 5);
});

test("Claude Retry-After parses dates, rejects invalid values, and clamps long delays", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  assert.equal(claudeRetryAfterMs("Thu, 20 Aug 2026 12:02:00 GMT", now), 120_000);
  assert.equal(claudeRetryAfterMs("3", now), 3_000);
  assert.equal(claudeRetryAfterMs("0", now), null);
  assert.equal(claudeRetryAfterMs("-3", now), null);
  assert.equal(claudeRetryAfterMs("invalid", now), null);
  assert.equal(claudeRetryAfterMs("7200", now), 60 * 60 * 1000);
});

test("Claude network failures use the same guarded backoff", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      throw new Error("offline");
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  await readAt(now);
  await readAt(now + 29_999);
  assert.equal(claudeCalls, 1);
  await readAt(now + 30_000);
  assert.equal(claudeCalls, 2);
});

test("Claude last-success snapshot survives cache reset without persisting auth", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const snapshotPath = join(home, "state", "official-quota.json");
  const now = Date.parse("2026-08-20T12:00:00Z");
  writeFileSync(
    join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"),
    JSON.stringify({ version: 2, samples: [{ t: now, u: { fh: 24, sd: 34 } }] }),
  );
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      if (claudeCalls === 1) {
        return new Response(JSON.stringify({
          five_hour: 24,
          seven_day: 34,
          limits: [{
            kind: "weekly_scoped",
            scope: { model: { display_name: "Fable" } },
            percent: 26,
          }],
        }), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    snapshotPath,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "never-write-this-token" }),
  });

  await readAt(now);
  clearOfficialCache();
  const restored = await readAt(now + 30_001);

  assert.equal(restored.claude?.windowPct, 24);
  assert.equal(restored.claude?.weekPct, 34);
  assert.equal(restored.claude?.modelWeekLimits?.fable?.usedPct, 26);
  assert.equal(restored.claude?.source, "plan-usage-history");
  assert.equal(restored.claude?.windowStale, undefined);
  assert.equal(restored.claude?.weekStale, undefined);
  assert.equal(restored.claude?.modelWeekLimitsStale, true);
  const serialized = JSON.stringify(JSON.parse(readFileSync(snapshotPath, "utf8")));
  assert.doesNotMatch(serialized, /never-write-this-token|authorization|access.?token|bearer|headers/i);
  assert.equal(statSync(join(home, "state")).mode & 0o777, 0o700);
  assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(join(home, "state")).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
    [],
  );
});

test("Claude snapshot shares Retry-After across cache resets", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const snapshotPath = join(home, "state", "official-quota.json");
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "120" },
      });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    snapshotPath,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  await readAt(now);
  clearOfficialCache();
  await readAt(now + 30_000);
  assert.equal(claudeCalls, 1);
});

test("Claude snapshot lock coalesces concurrent OAuth refreshes", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const snapshotPath = join(home, "state", "official-quota.json");
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({ five_hour: 24, seven_day: 34 }), { status: 200 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const read = () => readOfficialQuota({
    home,
    grokHome,
    snapshotPath,
    now,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(claudeCalls, 1);
  assert.equal(first.claude?.windowPct, 24);
  assert.equal(second.claude?.windowPct, 24);
});

test("Claude ignores malformed snapshot data", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const stateDir = join(home, "state");
  const snapshotPath = join(stateDir, "official-quota.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({ version: 1, claude: { loadedAt: "yesterday" } }));
  let claudeCalls = 0;
  const q = await readOfficialQuota({
    home,
    grokHome,
    snapshotPath,
    fetchImpl: async (input) => {
      if (String(input) === CLAUDE_USAGE_URL) {
        claudeCalls += 1;
        return new Response(JSON.stringify({ five_hour: 24, seven_day: 34 }), { status: 200 });
      }
      return new Response(JSON.stringify(LIVE), { status: 200 });
    },
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  assert.equal(claudeCalls, 1);
  assert.equal(q.claude?.windowPct, 24);
  assert.equal(q.claude?.weekPct, 34);
});

test("Claude does not reuse a persisted success after the one-hour stale window", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const snapshotPath = join(home, "state", "official-quota.json");
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    snapshotPath,
    now: at,
    fetchImpl: async (input) => {
      if (String(input) === CLAUDE_USAGE_URL) {
        claudeCalls += 1;
        if (claudeCalls === 1) {
          return new Response(JSON.stringify({
            five_hour: 24,
            seven_day: 34,
            limits: [{
              kind: "weekly_scoped",
              scope: { model: { display_name: "Fable" } },
              percent: 26,
            }],
          }), { status: 200 });
        }
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify(LIVE), { status: 200 });
    },
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  await readAt(now);
  clearOfficialCache();
  const expired = await readAt(now + CLAUDE_USAGE_STALE_MS + 1);

  assert.equal(claudeCalls, 2);
  assert.equal(expired.claude?.windowPct, 7);
  assert.equal(expired.claude?.weekPct, 19);
  assert.equal(expired.claude?.modelWeekLimits?.fable, undefined);
  assert.equal(expired.claude?.source, "plan-usage-history");
});

test("Claude OAuth auth parser rejects expired and empty credentials", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  assert.equal(
    claudeOauthAuthFromCredentials({ claudeAiOauth: { accessToken: "", expiresAt: now + 60_000 } }, now),
    null,
  );
  assert.equal(
    claudeOauthAuthFromCredentials(
      { claudeAiOauth: { accessToken: "expired", expiresAt: now - 60_000 } },
      now,
    ),
    null,
  );
  assert.deepEqual(
    claudeOauthAuthFromCredentials(
      { claudeAiOauth: { accessToken: "valid", expiresAt: now + 60_000 } },
      now,
    ),
    { accessToken: "valid" },
  );
});

test("Claude Desktop process discovery excludes wrappers and unrelated commands", () => {
  const home = "/Users/example";
  const executable =
    `${home}/Library/Application Support/Claude/claude-code/2.1.234/claude.app/Contents/MacOS/claude`;
  const processList = [
    `100 /Applications/Claude.app/Contents/Helpers/disclaimer ${executable} --model claude-fable-5`,
    `101 ${executable} --model claude-fable-5`,
    `102 ${executable}.old --model claude-fable-5`,
    "103 /usr/local/bin/claude --model claude-fable-5",
  ].join("\n");

  assert.deepEqual(claudeDesktopManagedPids(processList, home), [101]);
});

test("Claude process environment parser returns only the exact OAuth variable", () => {
  assert.deepEqual(
    claudeOauthAuthFromProcessEnvironment(
      "101 managed OTHER_CLAUDE_CODE_OAUTH_TOKEN=wrong CLAUDE_CODE_OAUTH_TOKEN=managed-token MODE=max",
    ),
    { accessToken: "managed-token" },
  );
  assert.equal(
    claudeOauthAuthFromProcessEnvironment(
      "101 managed OTHER_CLAUDE_CODE_OAUTH_TOKEN=wrong MODE=max",
    ),
    null,
  );
});

test("Claude auth discovery prefers the active Desktop-managed child", async () => {
  const { home } = fixtureHome();
  const executable =
    `${home}/Library/Application Support/Claude/claude-code/2.1.234/claude.app/Contents/MacOS/claude`;
  const calls: string[] = [];
  const auth = await readClaudeOauthAuth(home, Date.parse("2026-08-20T12:00:00Z"), {
    platform: "darwin",
    currentHome: home,
    env: {},
    execFileImpl: async (file, args) => {
      calls.push([file, args.join(" ")].join(" "));
      if (file === "/bin/ps" && args.join(" ") === "-ww -axo pid=,command=") {
        return {
          stdout: [
            `200 /Applications/Claude.app/Contents/Helpers/disclaimer ${executable}`,
            `201 ${executable} --model claude-fable-5`,
          ].join("\n"),
        };
      }
      if (file === "/bin/ps" && args.join(" ") === "eww -p 201") {
        return {
          stdout:
            "201 managed CLAUDE_CODE_OAUTH_TOKEN=desktop-token CLAUDE_CODE_SUBSCRIPTION_TYPE=max",
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(auth, { accessToken: "desktop-token" });
  assert.deepEqual(calls, [
    "/bin/ps -ww -axo pid=,command=",
    "/bin/ps eww -p 201",
  ]);
});

test("Claude auth discovery prefers its own injected environment token", async () => {
  let calls = 0;
  const auth = await readClaudeOauthAuth(
    "/Users/example",
    Date.parse("2026-08-20T12:00:00Z"),
    {
      platform: "darwin",
      currentHome: "/Users/example",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "direct-token" },
      execFileImpl: async () => {
        calls += 1;
        throw new Error("process discovery must not run");
      },
    },
  );

  assert.deepEqual(auth, { accessToken: "direct-token" });
  assert.equal(calls, 0);
});

test("Claude auth discovery keeps the credentials file fallback off macOS", async () => {
  const { home } = fixtureHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-token",
        expiresAt: Date.parse("2026-08-20T13:00:00Z"),
      },
    }),
  );
  let calls = 0;
  const auth = await readClaudeOauthAuth(home, Date.parse("2026-08-20T12:00:00Z"), {
    platform: "linux",
    currentHome: home,
    env: {},
    execFileImpl: async () => {
      calls += 1;
      throw new Error("macOS process discovery must not run");
    },
  });

  assert.deepEqual(auth, { accessToken: "file-token" });
  assert.equal(calls, 0);
});

test("Claude auth discovery falls through when a managed child has no token", async () => {
  const { home } = fixtureHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-token",
        expiresAt: Date.parse("2026-08-20T13:00:00Z"),
      },
    }),
  );
  const executable =
    `${home}/Library/Application Support/Claude/claude-code/2.1.234/claude.app/Contents/MacOS/claude`;
  const auth = await readClaudeOauthAuth(home, Date.parse("2026-08-20T12:00:00Z"), {
    platform: "darwin",
    currentHome: home,
    env: {},
    execFileImpl: async (file, args) => {
      if (file === "/bin/ps" && args.join(" ") === "-ww -axo pid=,command=") {
        return { stdout: `301 ${executable} --model claude-fable-5` };
      }
      if (file === "/bin/ps" && args.join(" ") === "eww -p 301") {
        return { stdout: "301 managed CLAUDE_CODE_SUBSCRIPTION_TYPE=max" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(auth, { accessToken: "file-token" });
});

test("claude snapshot path uses Balance and copies a legacy Synq file once", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-snapshot-mig-"));
  const current = claudeSnapshotPath(home, "darwin", {});
  const legacy = legacyClaudeSnapshotPath(home, "darwin", {});
  assert.match(current, /Application Support\/Balance\/official-quota\.json$/);
  assert.match(legacy, /Application Support\/Synq\/official-quota\.json$/);

  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, '{"version":1,"claude":null}');
  const resolved = resolveClaudeSnapshotPath(home, "darwin", {});
  assert.equal(resolved, current);
  assert.equal(readFileSync(current, "utf8"), '{"version":1,"claude":null}');
  assert.equal(readFileSync(legacy, "utf8"), '{"version":1,"claude":null}');
});

test("linux snapshot path prefers XDG Balance over the legacy synq directory", () => {
  const home = mkdtempSync(join(tmpdir(), "balance-snapshot-linux-"));
  const env = { XDG_STATE_HOME: join(home, "xdg") };
  const current = claudeSnapshotPath(home, "linux", env);
  const legacy = legacyClaudeSnapshotPath(home, "linux", env);
  assert.equal(current, join(home, "xdg", "balance", "official-quota.json"));
  assert.equal(legacy, join(home, "xdg", "synq", "official-quota.json"));
});

test("Claude 429 backoff quota pools go stale in the cached slice", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const snapshotPath = join(home, "state", "official-quota.json");
  const now = Date.parse("2026-08-20T12:00:00Z");
  let claudeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      claudeCalls += 1;
      if (claudeCalls === 1) {
        return new Response(JSON.stringify({
          five_hour: { utilization: 24, resets_at: "2026-08-20T15:00:00Z" },
          seven_day: { utilization: 34.25, resets_at: "2026-08-25T00:00:00Z" },
          seven_day_sonnet: { utilization: 75.5, resets_at: "2026-08-25T00:00:00Z" },
          extra_usage: { is_enabled: true, used_credits: 42.5, monthly_limit: 100 },
        }), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome,
    snapshotPath,
    now: at,
    fetchImpl,
    skipCache: true,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });

  const fresh = await readAt(now);
  assert.equal(fresh.claude?.quotaPools?.length, 2);
  assert.ok(fresh.claude?.quotaPools?.every((pool) => pool.stale === false));

  const backedOff = await readAt(now + 30_001);
  assert.equal(claudeCalls, 2);
  assert.equal(backedOff.claude?.quotaPools?.length, 2);
  assert.ok(backedOff.claude?.quotaPools?.every((pool) => pool.stale === true));
});

test("statusline snapshot merges fresh decimal windows without OAuth", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-21T12:00:00Z");
  const statuslineSnapshotPath = join(home, "state", "claude-statusline.json");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(statuslineSnapshotPath, `${JSON.stringify({
    fetchedAt: now - 60_000,
    rate_limits: {
      five_hour: { used_percentage: 12.5, resets_at: now + 3_600_000 },
      seven_day: { used_percentage: 34.25, resets_at: now + 4 * 24 * 3_600_000 },
    },
  })}\n`);
  const q = await readOfficialQuota({
    home,
    grokHome,
    now,
    skipCache: true,
    statuslineSnapshotPath,
    fetchImpl: async () => new Response("{}", { status: 500 }),
    readClaudeAuth: async () => null,
  });
  assert.equal(q.claude?.windowPct, 12.5);
  assert.equal(q.claude?.windowResetsAt, now + 3_600_000);
  assert.equal(q.claude?.weekPct, 34.25);
  assert.equal(q.claude?.windowStale, false);
  assert.equal(q.claude?.weekStale, false);
  assert.equal(q.claude?.windowFetchedAt, now - 60_000);
  assert.equal(q.claude?.weekFetchedAt, now - 60_000);
  assert.equal(q.claude?.source, "claude-statusline");
});

test("newer OAuth windows replace an older statusline snapshot after quota refresh", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-21T12:00:00Z");
  const statuslineSnapshotPath = join(home, "state", "claude-statusline.json");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(statuslineSnapshotPath, `${JSON.stringify({
    fetchedAt: now - 30_000,
    rate_limits: {
      five_hour: { used_percentage: 100, resets_at: now + 3_600_000 },
      seven_day: { used_percentage: 100, resets_at: now + 4 * 24 * 3_600_000 },
    },
  })}\n`);
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      return new Response(JSON.stringify({
        five_hour: { utilization: 0, resets_at: "2026-08-21T13:30:00Z" },
        seven_day: { utilization: 0, resets_at: "2026-08-25T00:00:00Z" },
        seven_day_sonnet: { utilization: 0, resets_at: "2026-08-25T00:00:00Z" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const q = await readOfficialQuota({
    home,
    grokHome,
    now,
    fetchImpl,
    skipCache: true,
    statuslineSnapshotPath,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });
  assert.equal(q.claude?.windowPct, 0);
  assert.equal(q.claude?.weekPct, 0);
  assert.equal(q.claude?.windowFetchedAt, now);
  assert.equal(q.claude?.weekFetchedAt, now);
  assert.equal(q.claude?.source, "oauth-usage");
  assert.equal(q.claude?.modelWeekLimits?.sonnet?.usedPct, 0);
});

test("statusline precedence rejects a percent-only window and survives the cache fast path", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-21T12:00:00Z");
  const statuslineSnapshotPath = join(home, "state", "claude-statusline.json");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(statuslineSnapshotPath, `${JSON.stringify({
    fetchedAt: now - 30_000,
    rate_limits: {
      five_hour: { used_percentage: 12.5 },
      seven_day: { used_percentage: 34.25, resets_at: now + 4 * 24 * 3_600_000 },
    },
  })}\n`);
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === CLAUDE_USAGE_URL) {
      return new Response(JSON.stringify({
        five_hour: { utilization: 24, resets_at: "2026-08-21T13:30:00Z" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify(LIVE), { status: 200 });
  };
  const readAt = () => readOfficialQuota({
    home,
    grokHome,
    now,
    fetchImpl,
    statuslineSnapshotPath,
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
  });
  const first = await readAt();
  assert.equal(first.claude?.windowPct, 24);
  assert.equal(first.claude?.windowResetsAt, Date.parse("2026-08-21T13:30:00Z"));
  assert.equal(first.claude?.windowFetchedAt, now);
  assert.equal(first.claude?.windowStale ?? false, false);
  assert.equal(first.claude?.weekPct, 34.25);
  assert.equal(first.claude?.weekFetchedAt, now - 30_000);
  const cached = await readAt();
  assert.equal(cached.claude?.windowPct, 24);
  assert.equal(cached.claude?.weekPct, 34.25);
  assert.equal(cached.claude?.weekFetchedAt, now - 30_000);
});

test("statusline snapshot resolver and freshness gates reject bad captures", () => {
  assert.equal(
    claudeStatuslineSnapshotPath("/Users/u", "darwin", {} as NodeJS.ProcessEnv),
    join("/Users/u", "Library", "Application Support", "Balance", "claude-statusline.json"),
  );
  assert.equal(
    claudeStatuslineSnapshotPath(
      "/Users/u",
      "win32",
      { LOCALAPPDATA: "/tmp/local-app-data" } as NodeJS.ProcessEnv,
    ),
    join("/tmp/local-app-data", "Balance", "claude-statusline.json"),
  );
  assert.equal(
    claudeStatuslineSnapshotPath("/Users/u", "win32", { LOCALAPPDATA: "" } as NodeJS.ProcessEnv),
    join("/Users/u", "AppData", "Local", "Balance", "claude-statusline.json"),
  );
  assert.equal(
    claudeStatuslineSnapshotPath(
      "/home/u",
      "linux",
      { XDG_STATE_HOME: "/tmp/xdg-state" } as NodeJS.ProcessEnv,
    ),
    join("/tmp/xdg-state", "balance", "claude-statusline.json"),
  );
  assert.equal(
    claudeStatuslineSnapshotPath("/home/u", "linux", { XDG_STATE_HOME: " " } as NodeJS.ProcessEnv),
    join("/home/u", ".local", "state", "balance", "claude-statusline.json"),
  );
  const home = mkdtempSync(join(tmpdir(), "balance-statusline-read-"));
  const path = join(home, "claude-statusline.json");
  const now = Date.parse("2026-08-21T12:00:00Z");
  const write = (fetchedAt: number) => writeFileSync(path, `${JSON.stringify({
    fetchedAt,
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: now + 3_600_000 } },
  })}\n`);
  write(now - 60_000);
  assert.equal(readClaudeStatuslineSnapshot(path, now)?.windowPct, 12.5);
  write(now + 6_000);
  assert.equal(readClaudeStatuslineSnapshot(path, now), null);
  write(now - 16 * 60_000);
  assert.equal(readClaudeStatuslineSnapshot(path, now), null);
  writeFileSync(path, "not json\n");
  assert.equal(readClaudeStatuslineSnapshot(path, now), null);
});

test("readOfficialQuota returns Antigravity without blocking existing providers", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const now = Date.parse("2026-08-25T10:00:00Z");
  const antigravity = parseAntigravityQuotaSummary(ANTIGRAVITY_SUMMARY_FIXTURE, { fetchedAt: now });
  assert.ok(antigravity);

  const quota = await readOfficialQuota({
    home,
    grokHome,
    now,
    skipCache: true,
    fetchImpl: async () => new Response("nope", { status: 401 }),
    readClaudeAuth: async () => null,
    readAntigravityIdentity: async () => "agy-session-a",
    readAntigravity: async () => antigravity,
  });

  assert.deepEqual(quota.antigravity, antigravity);
  assert.equal(quota.grok?.source, "unified-billing-log");
});

test("readOfficialQuota reuses the fresh Antigravity cache", async () => {
  clearOfficialCache();
  const home = mkdtempSync(join(tmpdir(), "balance-antigravity-cache-"));
  const now = Date.parse("2026-08-25T10:00:00Z");
  const antigravity = parseAntigravityQuotaSummary(ANTIGRAVITY_SUMMARY_FIXTURE, { fetchedAt: now });
  assert.ok(antigravity);
  let reads = 0;
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome: join(home, ".grok-missing"),
    codexHome: join(home, ".codex-missing"),
    now: at,
    cacheMs: 30_000,
    readClaudeAuth: async () => null,
    readAntigravityIdentity: async () => "agy-session-a",
    readAntigravity: async () => {
      reads += 1;
      return antigravity;
    },
  });

  assert.deepEqual((await readAt(now)).antigravity, antigravity);
  assert.deepEqual((await readAt(now + 5_000)).antigravity, antigravity);
  assert.equal(reads, 1);
});

test("readOfficialQuota marks same-session Antigravity fallback stale", async () => {
  clearOfficialCache();
  const home = mkdtempSync(join(tmpdir(), "balance-antigravity-stale-"));
  const now = Date.parse("2026-08-25T10:00:00Z");
  const antigravity = parseAntigravityQuotaSummary(ANTIGRAVITY_SUMMARY_FIXTURE, { fetchedAt: now });
  assert.ok(antigravity);
  let reads = 0;
  const readAt = (at: number, skipCache: boolean) => readOfficialQuota({
    home,
    grokHome: join(home, ".grok-missing"),
    codexHome: join(home, ".codex-missing"),
    now: at,
    skipCache,
    readClaudeAuth: async () => null,
    readAntigravityIdentity: async () => "agy-session-a",
    readAntigravity: async () => {
      reads += 1;
      return reads === 1 ? antigravity : null;
    },
  });

  assert.ok((await readAt(now, true)).antigravity?.quotaPools?.every((pool) => pool.stale === false));
  assert.ok((await readAt(now + 31_000, true)).antigravity?.quotaPools?.every((pool) => pool.stale === true));
  assert.ok((await readAt(now + 31_001, false)).antigravity?.quotaPools?.every((pool) => pool.stale === true));
  assert.equal(reads, 2);
});

test("readOfficialQuota discards Antigravity data when identity changes during refresh", async () => {
  clearOfficialCache();
  const home = mkdtempSync(join(tmpdir(), "balance-antigravity-switch-"));
  const now = Date.parse("2026-08-25T10:00:00Z");
  const antigravity = parseAntigravityQuotaSummary(ANTIGRAVITY_SUMMARY_FIXTURE, { fetchedAt: now });
  assert.ok(antigravity);
  const identities = ["agy-session-a", "agy-session-a", "agy-session-a", "agy-session-b", "agy-session-b", "agy-session-b"];
  let reads = 0;
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome: join(home, ".grok-missing"),
    codexHome: join(home, ".codex-missing"),
    now: at,
    skipCache: true,
    readClaudeAuth: async () => null,
    readAntigravityIdentity: async () => identities.shift() ?? null,
    readAntigravity: async () => {
      reads += 1;
      return antigravity;
    },
  });

  assert.deepEqual((await readAt(now)).antigravity, antigravity);
  assert.equal((await readAt(now + 31_000)).antigravity, null);
  assert.deepEqual((await readAt(now + 62_000)).antigravity, antigravity);
  assert.equal(reads, 3);
});

test("readOfficialQuota does not let Antigravity discovery failures break other providers", async () => {
  clearOfficialCache();
  const { home, grokHome } = fixtureHome();
  const quota = await readOfficialQuota({
    home,
    grokHome,
    skipCache: true,
    fetchImpl: async () => new Response("nope", { status: 401 }),
    readClaudeAuth: async () => null,
    readAntigravityIdentity: async () => {
      throw new Error("credential discovery failed");
    },
    readAntigravity: async () => {
      throw new Error("quota fetch failed");
    },
  });

  assert.equal(quota.antigravity, null);
  assert.equal(quota.grok?.source, "unified-billing-log");
});

test("readOfficialQuota refreshes Antigravity when only its cache is missing", async () => {
  clearOfficialCache();
  const home = mkdtempSync(join(tmpdir(), "balance-antigravity-fast-path-"));
  const now = Date.parse("2026-08-25T10:00:00Z");
  const antigravity = parseAntigravityQuotaSummary(ANTIGRAVITY_SUMMARY_FIXTURE, { fetchedAt: now });
  assert.ok(antigravity);
  let identity: string | null = null;
  let reads = 0;
  const readAt = (at: number) => readOfficialQuota({
    home,
    grokHome: join(home, ".grok-missing"),
    codexHome: join(home, ".codex-missing"),
    now: at,
    cacheMs: 30_000,
    fetchImpl: async (input) => String(input) === CLAUDE_USAGE_URL
      ? Response.json({
        five_hour: { utilization: 10, resets_at: "2026-08-25T15:00:00Z" },
        seven_day: { utilization: 20, resets_at: "2026-09-01T10:00:00Z" },
      })
      : new Response("nope", { status: 401 }),
    readClaudeAuth: async () => ({ accessToken: "claude-token" }),
    readAntigravityIdentity: async () => identity,
    readAntigravity: async () => {
      reads += 1;
      return antigravity;
    },
  });

  assert.equal((await readAt(now)).antigravity, null);
  identity = "agy-session-a";
  assert.deepEqual((await readAt(now + 5_000)).antigravity, antigravity);
  assert.equal(reads, 2);
});

test("officialFilesMtime watches every Antigravity credential fallback", () => {
  const credentialPaths = [
    [".gemini", "jetski-standalone-oauth-token"],
    [".gemini", "antigravity-cli", "antigravity-oauth-token"],
    [".gemini", "oauth_creds.json"],
  ];
  for (const parts of credentialPaths) {
    const home = mkdtempSync(join(tmpdir(), "balance-antigravity-mtime-"));
    const path = join(home, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
    assert.equal(officialFilesMtime(home), statSync(path).mtimeMs);
  }
});
