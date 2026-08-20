import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectAgentAvailability } from "./agent-availability.server.ts";

test("detectAgentAvailability returns false when no monitorable home exists", (t) => {
  const home = mkdtempSync(join(tmpdir(), "synq-presence-empty-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(
    detectAgentAvailability({
      home,
      grokHome: join(home, "missing-grok"),
      codexHome: join(home, "missing-codex"),
    }),
    { claude: false, grok: false, codex: false },
  );
});

test("detectAgentAvailability recognizes Claude primary and config homes", (t) => {
  const primary = mkdtempSync(join(tmpdir(), "synq-presence-claude-primary-"));
  const config = mkdtempSync(join(tmpdir(), "synq-presence-claude-config-"));
  t.after(() => rmSync(primary, { recursive: true, force: true }));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  mkdirSync(join(primary, ".claude"));
  mkdirSync(join(config, ".config", "claude"), { recursive: true });
  assert.equal(detectAgentAvailability({ home: primary }).claude, true);
  assert.equal(detectAgentAvailability({ home: config }).claude, true);
});

test("GROK_HOME and CODEX_HOME overrides are authoritative", (t) => {
  const home = mkdtempSync(join(tmpdir(), "synq-presence-overrides-"));
  const grokHome = join(home, "grok-data");
  const codexHome = join(home, "codex-data");
  mkdirSync(grokHome);
  mkdirSync(codexHome);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const found = detectAgentAvailability({ home, grokHome, codexHome });
  assert.deepEqual(found, { claude: false, grok: true, codex: true });
  const missing = detectAgentAvailability({
    home,
    grokHome: join(home, "missing-grok"),
    codexHome: join(home, "missing-codex"),
  });
  assert.deepEqual(missing, { claude: false, grok: false, codex: false });
});

test("a symlink to a directory counts as an available Agent home", (t) => {
  const home = mkdtempSync(join(tmpdir(), "synq-presence-symlink-"));
  const target = join(home, "codex-target");
  const link = join(home, "codex-link");
  mkdirSync(target);
  symlinkSync(target, link, "dir");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(detectAgentAvailability({ home, codexHome: link }).codex, true);
});
