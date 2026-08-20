# Claude Desktop managed OAuth fallback plan

## Goal

When Claude Desktop is actively running its bundled Claude Code and the managed
OAuth token successfully reads `/api/oauth/usage`, Synq must show the same
official Fable weekly percentage. Synq must not estimate Fable usage and must
not print, persist, refresh, or mutate the OAuth token. If the live endpoint is
unavailable before Synq has a successful cached snapshot, Synq keeps the
existing 5h/7d fallback and hides Fable rather than inventing a value.

## Verified API and runtime facts

- Claude Desktop version `1.32885.1` is running bundled Claude Code `2.1.234`.
- This patch deliberately matches the verified native managed executable layout
  under a single Claude Code version directory followed by
  `claude.app/Contents/MacOS/claude`. It does not match the separate
  `claude-code-vm` runtime because that process family was not observed carrying
  the host OAuth environment used by the Usage API.
- The real request is `GET https://api.anthropic.com/api/oauth/usage` with
  `anthropic-beta: oauth-2025-04-20` and a bearer OAuth token.
- Claude Desktop injects the active token into the exact managed Claude Code
  child process as `CLAUDE_CODE_OAUTH_TOKEN`.
- A sanitized live request returned `five_hour=40`, `seven_day=27`, and a
  `weekly_scoped` Fable limit of `25`.
- `parseClaudeUsagePayload()` and the dashboard already consume this response
  correctly. Credential discovery is the only missing link.
- Claude Desktop's organization Usage endpoint caches the same
  `limits[].weekly_scoped.scope.model.display_name="Fable"` structure, but the
  disk cache is not selected because it can be stale and its Chromium storage
  format is not a stable application API.

## Step 1: discover the active Claude Desktop-managed OAuth token

### RED

Extend `src/lib/quota/official.server.test.ts` with deterministic tests for the
managed process parser and auth discovery. Add these imports:

```ts
import {
  CLAUDE_USAGE_STALE_MS,
  CLAUDE_USAGE_URL,
  claudeDesktopManagedPids,
  claudeOauthAuthFromCredentials,
  claudeOauthAuthFromProcessEnvironment,
  clearOfficialCache,
  CODEX_USAGE_URL,
  GROK_BILLING_URL,
  readClaudeOauthAuth,
  readOfficialQuota,
} from "./official.server.ts";
```

Append these complete tests:

```ts
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
```

Run:

```bash
node --test --experimental-strip-types src/lib/quota/official.server.test.ts
```

Expected RED: imports fail because the three new exports do not exist.

### GREEN

In `src/lib/quota/official.server.ts`, add these types immediately after
`ReadClaudeAuth`:

```ts
type ExecFileText = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface ClaudeAuthDiscoveryOptions {
  platform?: NodeJS.Platform;
  currentHome?: string;
  env?: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileText;
}
```

Add this adapter immediately after `execFileAsync`:

```ts
const execFileText: ExecFileText = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: String(result.stdout) };
};
```

Add these complete functions immediately before
`claudeOauthAuthFromCredentials()`:

```ts
export function claudeDesktopManagedPids(raw: string, home: string): number[] {
  const root = join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );
  const pids: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    const command = parsed[2];
    if (!Number.isSafeInteger(pid) || pid <= 0 || !command.startsWith(`${root}/`)) continue;
    const afterRoot = command.slice(root.length + 1);
    const versionEnd = afterRoot.indexOf("/");
    if (versionEnd <= 0) continue;
    const version = afterRoot.slice(0, versionEnd);
    const executable = join(root, version, "claude.app", "Contents", "MacOS", "claude");
    if (command === executable || command.startsWith(`${executable} `)) pids.push(pid);
  }
  return pids.sort((a, b) => b - a).slice(0, 8);
}

export function claudeOauthAuthFromProcessEnvironment(
  raw: string,
): ClaudeOauthAuth | null {
  const accessToken = raw.match(
    /(?:^|\s)CLAUDE_CODE_OAUTH_TOKEN=([^\s]+)/,
  )?.[1];
  return accessToken ? { accessToken } : null;
}

async function readClaudeDesktopManagedAuth(
  home: string,
  execFileImpl: ExecFileText,
): Promise<ClaudeOauthAuth | null> {
  try {
    const processes = await execFileImpl(
      "/bin/ps",
      ["-ww", "-axo", "pid=,command="],
      { encoding: "utf8", timeout: 1500, maxBuffer: 8 * 1024 * 1024 },
    );
    for (const pid of claudeDesktopManagedPids(processes.stdout, home)) {
      try {
        const processEnvironment = await execFileImpl(
          "/bin/ps",
          ["eww", "-p", String(pid)],
          { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024 * 1024 },
        );
        const auth = claudeOauthAuthFromProcessEnvironment(processEnvironment.stdout);
        if (auth) return auth;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}
```

Replace `readClaudeOauthAuth()` with this complete implementation:

```ts
export async function readClaudeOauthAuth(
  home: string,
  now: number,
  opts?: ClaudeAuthDiscoveryOptions,
): Promise<ClaudeOauthAuth | null> {
  const env = opts?.env ?? process.env;
  const directToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (directToken) return { accessToken: directToken };

  const platform = opts?.platform ?? process.platform;
  const currentHome = opts?.currentHome ?? homedir();
  const execFileImpl = opts?.execFileImpl ?? execFileText;
  if (platform === "darwin" && home === currentHome) {
    const managed = await readClaudeDesktopManagedAuth(home, execFileImpl);
    if (managed) return managed;
  }

  const fileRaw = readText(join(home, ".claude", ".credentials.json"));
  if (fileRaw) {
    try {
      const fromFile = claudeOauthAuthFromCredentials(JSON.parse(fileRaw), now);
      if (fromFile) return fromFile;
    } catch {
      // Malformed local credentials fall through to the read-only Keychain lookup.
    }
  }
  if (platform !== "darwin" || home !== currentHome) return null;
  try {
    const result = await execFileImpl(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
      { encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024 },
    );
    return claudeOauthAuthFromCredentials(JSON.parse(result.stdout), now);
  } catch {
    return null;
  }
}
```

Run the focused test again. Expected GREEN: all tests pass and no token value
appears in test output.

### Regression and runtime verification

Run every command separately, drain its log, write its exit status to `/tmp`,
print a sentinel, and stop immediately if it failed:

```bash
node --test --experimental-strip-types src/lib/quota/official.server.test.ts > /tmp/synq-managed-oauth-server-test.log 2>&1
synq_server_test_rc=$?
cat /tmp/synq-managed-oauth-server-test.log
echo "EXIT:$synq_server_test_rc" | tee /tmp/synq-managed-oauth-server-test-exit
echo "DRAIN-SENTINEL:official-server-test"
test "$synq_server_test_rc" -eq 0

node --test --experimental-strip-types src/lib/quota/official.test.ts > /tmp/synq-managed-oauth-parser-test.log 2>&1
synq_parser_test_rc=$?
cat /tmp/synq-managed-oauth-parser-test.log
echo "EXIT:$synq_parser_test_rc" | tee /tmp/synq-managed-oauth-parser-test-exit
echo "DRAIN-SENTINEL:official-parser-test"
test "$synq_parser_test_rc" -eq 0

node --test --experimental-strip-types src/lib/quota/model-week-limit.test.ts > /tmp/synq-managed-oauth-model-test.log 2>&1
synq_model_test_rc=$?
cat /tmp/synq-managed-oauth-model-test.log
echo "EXIT:$synq_model_test_rc" | tee /tmp/synq-managed-oauth-model-test-exit
echo "DRAIN-SENTINEL:model-week-limit-test"
test "$synq_model_test_rc" -eq 0

npm test > /tmp/synq-managed-oauth-all-test.log 2>&1
synq_all_test_rc=$?
cat /tmp/synq-managed-oauth-all-test.log
echo "EXIT:$synq_all_test_rc" | tee /tmp/synq-managed-oauth-all-test-exit
echo "DRAIN-SENTINEL:all-test"
test "$synq_all_test_rc" -eq 0

npm run typecheck > /tmp/synq-managed-oauth-typecheck.log 2>&1
synq_typecheck_rc=$?
cat /tmp/synq-managed-oauth-typecheck.log
echo "EXIT:$synq_typecheck_rc" | tee /tmp/synq-managed-oauth-typecheck-exit
echo "DRAIN-SENTINEL:typecheck"
test "$synq_typecheck_rc" -eq 0

npm run build > /tmp/synq-managed-oauth-build.log 2>&1
synq_build_rc=$?
cat /tmp/synq-managed-oauth-build.log
echo "EXIT:$synq_build_rc" | tee /tmp/synq-managed-oauth-build-exit
echo "DRAIN-SENTINEL:build"
test "$synq_build_rc" -eq 0
```

Start the real app through `startup.sh`. Call `readOfficialQuota({ skipCache:
true })` without injecting credentials and print only `source`, `windowPct`,
`weekPct`, and `modelWeekLimits.fable`. The expected source is `oauth-usage`
and the Fable percentage must match the live official response.

Open `http://127.0.0.1:8080/` in the in-app Browser. Wait for the official
poll, then verify all of the following visible text/state:

- `Fable 5 周额度（官方）` is present.
- The visible percent equals the sanitized live OAuth response captured in the
  same verification run.
- No `140%` Fable value is present.
- Browser console has no new errors caused by this change.

If the in-app Browser cannot connect, record that as a verification blocker and
do not substitute unit tests or HTTP-only checks for the required UI evidence.

### Commit

Commit only these files:

- `docs/research/2026-08-20-claude-desktop-fable-interface.md`
- `docs/plans/2026-08-20-claude-desktop-managed-oauth.md`
- `src/lib/quota/official.server.ts`
- `src/lib/quota/official.server.test.ts`

Commit message:

```text
fix(quota): read Claude Desktop managed OAuth

Verified-by: node --test --experimental-strip-types src/lib/quota/official.server.test.ts
Verified-by: npm test
Verified-by: npm run typecheck
Verified-by: npm run build
```

## Plan self-check

- Spec coverage: covers active Desktop credential discovery, official API
  reuse, live UI visibility, failure fallback, and secret non-persistence.
- Placeholder scan: every added function and test is complete; there are no
  unfinished code markers.
- Type consistency: signatures match the existing `ClaudeOauthAuth`,
  `readOfficialQuota`, Node `execFile`, and test imports inspected in the repo.
- Step size: one independent TDD unit, one production file, one test file, and
  one commit.
