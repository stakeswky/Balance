import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANTIGRAVITY_SUMMARY_FIXTURE } from "./antigravity.test-fixture.ts";
import {
  ANTIGRAVITY_QUOTA_URL,
  antigravitySessionIdentity,
  antigravityUserAgent,
  fetchAntigravityQuota,
  findAgyExecutable,
  readAntigravityCredential,
  readAntigravityQuota,
  type ExecFileText,
} from "./antigravity.server.ts";

function tempHome(t: { after: (fn: () => void) => void }, prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

function credentialJson(accessToken: string, expiry = "2026-08-25T12:00:00Z"): string {
  return JSON.stringify({ token: { access_token: accessToken, expiry } });
}

test("macOS Keychain credential accepts the go-keyring base64 wrapper", async () => {
  const raw = credentialJson("keychain-unit-token");
  const wrapped = `go-keyring-base64:${Buffer.from(raw).toString("base64")}`;
  const execFileImpl: ExecFileText = async (file, args, options) => {
    assert.equal(file, "security");
    assert.deepEqual(args, ["find-generic-password", "-a", "antigravity", "-s", "gemini", "-w"]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
    return { stdout: wrapped };
  };
  assert.deepEqual(await readAntigravityCredential({ platform: "darwin", execFileImpl }), {
    accessToken: "keychain-unit-token",
    expiresAt: Date.parse("2026-08-25T12:00:00Z"),
  });
});

test("credential reader falls back through the three bounded files", async (t) => {
  const home = tempHome(t, "balance-antigravity-credential-");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const failingKeychain: ExecFileText = async () => {
    throw new Error("locked");
  };
  const paths = [
    join(home, ".gemini", "jetski-standalone-oauth-token"),
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "oauth_creds.json"),
  ];
  for (let index = 0; index < paths.length; index += 1) {
    for (const path of paths) rmSync(path, { force: true });
    writeFileSync(paths[index]!, credentialJson(`file-token-${index}`));
    const parsed = await readAntigravityCredential({
      home,
      platform: "darwin",
      execFileImpl: failingKeychain,
    });
    assert.equal(parsed?.accessToken, `file-token-${index}`);
  }
});

test("credential reader rejects malformed, oversized, and overlong secrets", async (t) => {
  const home = tempHome(t, "balance-antigravity-invalid-credential-");
  mkdirSync(join(home, ".gemini"), { recursive: true });
  const path = join(home, ".gemini", "jetski-standalone-oauth-token");
  writeFileSync(path, "x".repeat(1024 * 1024 + 1));
  assert.equal(await readAntigravityCredential({ home, platform: "linux" }), null);
  writeFileSync(path, credentialJson("x".repeat(64 * 1024 + 1)));
  assert.equal(await readAntigravityCredential({ home, platform: "linux" }), null);
  writeFileSync(path, "go-keyring-base64:not!base64");
  assert.equal(await readAntigravityCredential({ home, platform: "linux" }), null);
});

test("findAgyExecutable follows override, PATH, default, and executable checks", (t) => {
  const home = tempHome(t, "balance-antigravity-executable-");
  const bin = join(home, "bin");
  const defaultBin = join(home, ".local", "bin");
  mkdirSync(bin);
  mkdirSync(defaultBin, { recursive: true });
  const override = join(home, "agy-override");
  const pathAgy = join(bin, "agy");
  const defaultAgy = join(defaultBin, "agy");
  executable(override);
  executable(pathAgy);
  executable(defaultAgy);
  assert.equal(findAgyExecutable({ home, platform: "linux", env: { AGY_BIN: override, PATH: bin } }), override);
  assert.equal(findAgyExecutable({ home, platform: "linux", env: { PATH: bin } }), pathAgy);
  assert.equal(findAgyExecutable({ home, platform: "linux", env: { PATH: "" } }), defaultAgy);
  chmodSync(defaultAgy, 0o644);
  assert.equal(findAgyExecutable({ home, platform: "linux", env: { PATH: "" } }), null);
});

test("findAgyExecutable supports the Windows LOCALAPPDATA default", (t) => {
  const home = tempHome(t, "balance-antigravity-windows-executable-");
  const localAppData = join(home, "LocalAppData");
  const agy = join(localAppData, "agy", "bin", "agy.exe");
  mkdirSync(join(localAppData, "agy", "bin"), { recursive: true });
  writeFileSync(agy, "windows-placeholder");
  assert.equal(findAgyExecutable({
    home,
    platform: "win32",
    env: { PATH: "", LOCALAPPDATA: localAppData },
  }), agy);
});

test("Antigravity user agent requires a semantic version", () => {
  assert.equal(antigravityUserAgent("Antigravity 1.1.19", "darwin", "arm64"), "antigravity/1.1.19 darwin/arm64");
  assert.equal(antigravityUserAgent("development", "darwin", "arm64"), null);
});

test("quota fetch uses the exact endpoint, headers, body, and parser", async () => {
  const slice = await fetchAntigravityQuota(
    { accessToken: "fetch-unit-token", expiresAt: null },
    {
      now: 1234,
      userAgent: "antigravity/1.1.19 darwin/arm64",
      fetchImpl: async (input, init) => {
        assert.equal(input, ANTIGRAVITY_QUOTA_URL);
        assert.equal(init?.method, "POST");
        assert.equal(init?.body, "{}");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer fetch-unit-token");
        assert.equal(headers.get("user-agent"), "antigravity/1.1.19 darwin/arm64");
        assert.equal(headers.get("content-type"), "application/json");
        return Response.json(ANTIGRAVITY_SUMMARY_FIXTURE);
      },
    },
  );
  assert.equal(slice.status, 200);
  assert.equal(slice.slice?.agent, "antigravity");
  assert.equal(slice.slice?.fetchedAt, 1234);
});

test("quota fetch rejects oversized and changed response schemas", async () => {
  const credential = { accessToken: "response-unit-token", expiresAt: null };
  const oversized = await fetchAntigravityQuota(credential, {
    userAgent: "antigravity/1.1.19 darwin/arm64",
    fetchImpl: async () => new Response(`{"padding":"${"x".repeat(1024 * 1024)}"}`),
  });
  assert.deepEqual(oversized, { slice: null, status: 200 });
  const changed = await fetchAntigravityQuota(credential, {
    userAgent: "antigravity/1.1.19 darwin/arm64",
    fetchImpl: async () => Response.json({ buckets: [] }),
  });
  assert.deepEqual(changed, { slice: null, status: 200 });
});

test("quota timeout covers both request headers and response body", async () => {
  const credential = { accessToken: "timeout-unit-token", expiresAt: null };
  const started = Date.now();
  const waitingFetch = await fetchAntigravityQuota(credential, {
    userAgent: "antigravity/1.1.19 darwin/arm64",
    timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.deepEqual(waitingFetch, { slice: null, status: null });
  let bodySignal: AbortSignal | null = null;
  const waitingBody = await fetchAntigravityQuota(credential, {
    userAgent: "antigravity/1.1.19 darwin/arm64",
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      bodySignal = init?.signal ?? null;
      return {
        ok: true,
        status: 200,
        json: async () => new Promise((_resolve, reject) => {
          bodySignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      } as Response;
    },
  });
  assert.deepEqual(waitingBody, { slice: null, status: null });
  assert.ok(Date.now() - started < 250);
});

test("401 invokes agy models once, rereads credentials, and retries once", async () => {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  const execFileImpl: ExecFileText = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === "--version") return { stdout: "agy 1.1.19" };
    if (args[0] === "models") return { stdout: "" };
    throw new Error("unexpected command");
  };
  const credentials = [
    { accessToken: "old-unit-token", expiresAt: null },
    { accessToken: "new-unit-token", expiresAt: null },
  ];
  let fetchCount = 0;
  const slice = await readAntigravityQuota({
    agyPath: "/tmp/agy",
    platform: "darwin",
    arch: "arm64",
    execFileImpl,
    readCredential: async () => credentials.shift() ?? null,
    fetchImpl: async (_input, init) => {
      fetchCount += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      assert.equal(authorization, fetchCount === 1 ? "Bearer old-unit-token" : "Bearer new-unit-token");
      return fetchCount === 1
        ? Response.json({ error: { code: 401 } }, { status: 401 })
        : Response.json(ANTIGRAVITY_SUMMARY_FIXTURE);
    },
  });
  assert.equal(slice?.agent, "antigravity");
  assert.equal(fetchCount, 2);
  assert.deepEqual(calls.filter((call) => call.args[0] === "models"), [{
    file: "/tmp/agy",
    args: ["models"],
    options: { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  }]);
});

test("expired pre-refresh plus a 401 still executes models only once", async () => {
  let modelCalls = 0;
  let reads = 0;
  let fetches = 0;
  const execFileImpl: ExecFileText = async (_file, args) => {
    if (args[0] === "--version") return { stdout: "agy 1.1.19" };
    if (args[0] === "models") {
      modelCalls += 1;
      return { stdout: "" };
    }
    throw new Error("unexpected command");
  };
  const slice = await readAntigravityQuota({
    agyPath: "/tmp/agy",
    now: 10_000,
    execFileImpl,
    readCredential: async () => {
      reads += 1;
      return { accessToken: `refresh-unit-token-${reads}`, expiresAt: reads === 1 ? 9_000 : null };
    },
    fetchImpl: async () => {
      fetches += 1;
      return fetches === 1
        ? new Response("", { status: 401 })
        : Response.json(ANTIGRAVITY_SUMMARY_FIXTURE);
    },
  });
  assert.equal(slice?.agent, "antigravity");
  assert.equal(modelCalls, 1);
  assert.equal(reads, 3);
  assert.equal(fetches, 2);
});

test("403 and invalid versions fail closed without refreshing or leaking tokens", async () => {
  let modelCalls = 0;
  let fetchCalls = 0;
  const execFileImpl: ExecFileText = async (_file, args) => {
    if (args[0] === "--version") return { stdout: "agy 1.1.19" };
    if (args[0] === "models") modelCalls += 1;
    return { stdout: "" };
  };
  const marker = "forbidden-unit-token";
  const result = await readAntigravityQuota({
    agyPath: "/tmp/agy",
    execFileImpl,
    readCredential: async () => ({ accessToken: marker, expiresAt: null }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("", { status: 403 });
    },
  });
  assert.equal(result, null);
  assert.equal(modelCalls, 0);
  assert.equal(fetchCalls, 1);
  const invalid = await readAntigravityQuota({
    agyPath: "/tmp/agy",
    execFileImpl: async () => ({ stdout: "development" }),
    readCredential: async () => ({ accessToken: marker, expiresAt: null }),
    fetchImpl: async () => {
      throw new Error(marker);
    },
  });
  assert.equal(invalid, null);
  assert.equal(JSON.stringify({ result, invalid }).includes(marker), false);
});

test("429 and 5xx never invoke the CLI refresh path", async () => {
  for (const status of [429, 500, 503]) {
    let modelCalls = 0;
    const result = await readAntigravityQuota({
      agyPath: "/tmp/agy",
      execFileImpl: async (_file, args) => {
        if (args[0] === "--version") return { stdout: "agy 1.1.19" };
        modelCalls += 1;
        return { stdout: "" };
      },
      readCredential: async () => ({ accessToken: `status-unit-token-${status}`, expiresAt: null }),
      fetchImpl: async () => new Response("", { status }),
    });
    assert.equal(result, null);
    assert.equal(modelCalls, 0);
  }
});

test("a failed agy models refresh stops without a second request", async () => {
  let fetchCalls = 0;
  let models = 0;
  const result = await readAntigravityQuota({
    agyPath: "/tmp/agy",
    execFileImpl: async (_file, args) => {
      if (args[0] === "--version") return { stdout: "agy 1.1.19" };
      models += 1;
      throw new Error("refresh failed");
    },
    readCredential: async () => ({ accessToken: "refresh-failure-unit-token", expiresAt: null }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("", { status: 401 });
    },
  });
  assert.equal(result, null);
  assert.equal(models, 1);
  assert.equal(fetchCalls, 1);
});

test("session identity changes with the canonical executable or credential", async (t) => {
  const home = tempHome(t, "balance-antigravity-identity-");
  const bin = join(home, "bin");
  mkdirSync(bin);
  const first = join(bin, "agy-first");
  const second = join(bin, "agy-second");
  executable(first);
  executable(second);
  const identity = (agyPath: string, accessToken: string) => antigravitySessionIdentity({
    home,
    platform: "linux",
    env: { AGY_BIN: agyPath, PATH: "" },
    readCredential: async () => ({ accessToken, expiresAt: null }),
  });
  const a = await identity(first, "identity-unit-token-a");
  assert.equal(a?.length, 64);
  assert.equal(await identity(first, "identity-unit-token-a"), a);
  assert.notEqual(await identity(first, "identity-unit-token-b"), a);
  assert.notEqual(await identity(second, "identity-unit-token-a"), a);
});
