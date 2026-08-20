import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_USAGE_STALE_MS,
  CLAUDE_USAGE_URL,
  claudeDesktopManagedPids,
  claudeOauthAuthFromCredentials,
  claudeOauthAuthFromProcessEnvironment,
  claudeRetryAfterMs,
  clearOfficialCache,
  CODEX_USAGE_URL,
  GROK_BILLING_URL,
  readClaudeOauthAuth,
  readOfficialQuota,
} from "./official.server.ts";

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
