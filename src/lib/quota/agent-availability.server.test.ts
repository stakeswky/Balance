import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectAgentAvailability as detectAgentAvailabilityImpl } from "./agent-availability.server.ts";

const detectAgentAvailability: typeof detectAgentAvailabilityImpl = (options = {}) =>
  detectAgentAvailabilityImpl({
    ...options,
    platform: options.platform ?? "linux",
    env: options.env ?? { ...process.env, AGY_BIN: undefined, PATH: "" },
  });

test("detectAgentAvailability returns false when no monitorable home exists", (t) => {
  const home = mkdtempSync(join(tmpdir(), "balance-presence-empty-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(
    detectAgentAvailability({
      home,
      grokHome: join(home, "missing-grok"),
      codexHome: join(home, "missing-codex"),
    }),
    { claude: false, grok: false, codex: false, antigravity: false },
  );
});

test("detectAgentAvailability recognizes Claude primary and config homes", (t) => {
  const primary = mkdtempSync(join(tmpdir(), "balance-presence-claude-primary-"));
  const config = mkdtempSync(join(tmpdir(), "balance-presence-claude-config-"));
  t.after(() => rmSync(primary, { recursive: true, force: true }));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  mkdirSync(join(primary, ".claude"));
  mkdirSync(join(config, ".config", "claude"), { recursive: true });
  assert.equal(detectAgentAvailability({ home: primary }).claude, true);
  assert.equal(detectAgentAvailability({ home: config }).claude, true);
});

test("GROK_HOME and CODEX_HOME overrides are authoritative", (t) => {
  const home = mkdtempSync(join(tmpdir(), "balance-presence-overrides-"));
  const grokHome = join(home, "grok-data");
  const codexHome = join(home, "codex-data");
  mkdirSync(grokHome);
  mkdirSync(codexHome);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const found = detectAgentAvailability({ home, grokHome, codexHome });
  assert.deepEqual(found, { claude: false, grok: true, codex: true, antigravity: false });
  const missing = detectAgentAvailability({
    home,
    grokHome: join(home, "missing-grok"),
    codexHome: join(home, "missing-codex"),
  });
  assert.deepEqual(missing, { claude: false, grok: false, codex: false, antigravity: false });
});

test("a symlink to a directory counts as an available Agent home", (t) => {
  const home = mkdtempSync(join(tmpdir(), "balance-presence-symlink-"));
  const target = join(home, "codex-target");
  const link = join(home, "codex-link");
  mkdirSync(target);
  symlinkSync(target, link, "dir");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(detectAgentAvailability({ home, codexHome: link }).codex, true);
});

function isolatedHome(t: { after: (fn: () => void) => void }, prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    grokHome: join(home, "missing-grok"),
    codexHome: join(home, "missing-codex"),
  };
}

test("detectAgentAvailability reports Claude-only when Grok and Codex homes are missing", (t) => {
  const { home, grokHome, codexHome } = isolatedHome(t, "balance-presence-only-claude-");
  mkdirSync(join(home, ".claude"));
  assert.deepEqual(detectAgentAvailability({ home, grokHome, codexHome }), {
    claude: true,
    grok: false,
    codex: false,
    antigravity: false,
  });
});

test("detectAgentAvailability reports Grok-only when Claude and Codex homes are missing", (t) => {
  const { home, grokHome, codexHome } = isolatedHome(t, "balance-presence-only-grok-");
  const grok = join(home, "only-grok");
  mkdirSync(grok);
  assert.deepEqual(
    detectAgentAvailability({ home, grokHome: grok, codexHome }),
    { claude: false, grok: true, codex: false, antigravity: false },
  );
  assert.deepEqual(detectAgentAvailability({ home, grokHome, codexHome }), {
    claude: false,
    grok: false,
    codex: false,
    antigravity: false,
  });
});

test("detectAgentAvailability reports Codex-only when Claude and Grok homes are missing", (t) => {
  const { home, grokHome, codexHome } = isolatedHome(t, "balance-presence-only-codex-");
  const codex = join(home, "only-codex");
  mkdirSync(codex);
  assert.deepEqual(
    detectAgentAvailability({ home, grokHome, codexHome: codex }),
    { claude: false, grok: false, codex: true, antigravity: false },
  );
});

test("detectAgentAvailability reports each two-agent pair", (t) => {
  const { home, grokHome, codexHome } = isolatedHome(t, "balance-presence-pairs-");
  mkdirSync(join(home, ".claude"));
  const grok = join(home, "pair-grok");
  const codex = join(home, "pair-codex");
  mkdirSync(grok);
  mkdirSync(codex);
  assert.deepEqual(detectAgentAvailability({ home, grokHome, codexHome: codex }), {
    claude: true,
    grok: false,
    codex: true,
    antigravity: false,
  });
  assert.deepEqual(detectAgentAvailability({ home, grokHome: grok, codexHome }), {
    claude: true,
    grok: true,
    codex: false,
    antigravity: false,
  });
  rmSync(join(home, ".claude"), { recursive: true, force: true });
  assert.deepEqual(
    detectAgentAvailability({ home, grokHome: grok, codexHome: codex }),
    { claude: false, grok: true, codex: true, antigravity: false },
  );
});

test("detectAgentAvailability reports all three agents when every home exists", (t) => {
  const { home } = isolatedHome(t, "balance-presence-all-");
  mkdirSync(join(home, ".claude"));
  const grokHome = join(home, "all-grok");
  const codexHome = join(home, "all-codex");
  mkdirSync(grokHome);
  mkdirSync(codexHome);
  assert.deepEqual(detectAgentAvailability({ home, grokHome, codexHome }), {
    claude: true,
    grok: true,
    codex: true,
    antigravity: false,
  });
});

test("GROK_HOME env overrides the default ~/.grok directory", (t) => {
  const { home, codexHome } = isolatedHome(t, "balance-presence-grok-env-");
  mkdirSync(join(home, ".grok"));
  const custom = join(home, "env-grok");
  mkdirSync(custom);
  const previous = process.env.GROK_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  });

  process.env.GROK_HOME = custom;
  assert.equal(detectAgentAvailability({ home, codexHome }).grok, true);

  process.env.GROK_HOME = join(home, "missing-env-grok");
  assert.equal(detectAgentAvailability({ home, codexHome }).grok, false);
});

test("CODEX_HOME env overrides the default ~/.codex directory", (t) => {
  const { home, grokHome } = isolatedHome(t, "balance-presence-codex-env-");
  mkdirSync(join(home, ".codex"));
  const custom = join(home, "env-codex");
  mkdirSync(custom);
  const previous = process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });

  process.env.CODEX_HOME = custom;
  assert.equal(detectAgentAvailability({ home, grokHome }).codex, true);

  process.env.CODEX_HOME = join(home, "missing-env-codex");
  assert.equal(detectAgentAvailability({ home, grokHome }).codex, false);
});

test("detectAgentAvailability finds Antigravity only from a real agy executable", (t) => {
  const { home, grokHome, codexHome } = isolatedHome(t, "balance-presence-antigravity-");
  const agy = join(home, "bin", "agy");
  mkdirSync(join(home, "bin"));
  writeFileSync(agy, "#!/bin/sh\nexit 0\n");
  chmodSync(agy, 0o755);

  assert.equal(detectAgentAvailability({
    home,
    grokHome,
    codexHome,
    platform: "linux",
    env: { AGY_BIN: agy, PATH: "" },
  }).antigravity, true);

  chmodSync(agy, 0o644);
  assert.equal(detectAgentAvailability({
    home,
    grokHome,
    codexHome,
    platform: "linux",
    env: { AGY_BIN: agy, PATH: "" },
  }).antigravity, false);
});

test("Antigravity config without an agy executable is unavailable", (t) => {
  const { home, grokHome, codexHome } = isolatedHome(t, "balance-presence-antigravity-config-");
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini", "jetski-standalone-oauth-token"), "fixture");
  assert.equal(detectAgentAvailability({
    home,
    grokHome,
    codexHome,
    platform: "linux",
    env: { PATH: "" },
  }).antigravity, false);
});
