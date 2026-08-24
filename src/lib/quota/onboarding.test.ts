import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_STATUSLINE_COMMAND,
  claudeStatuslineSetup,
  onboardingState,
} from "./onboarding.ts";

test("onboarding reports checking before detection finishes", () => {
  assert.equal(
    onboardingState({ claude: false, grok: false, codex: false, antigravity: false }, true, null),
    "checking",
  );
});

test("onboarding distinguishes ready, empty, and error states", () => {
  assert.equal(onboardingState({ claude: true, grok: false, codex: false, antigravity: false }, false, null), "ready");
  assert.equal(onboardingState({ claude: false, grok: false, codex: false, antigravity: false }, false, null), "empty");
  assert.equal(
    onboardingState({ claude: false, grok: false, codex: false, antigravity: false }, false, "检测失败"),
    "error",
  );
});

test("statusline opt in instructions classify configured and conflicting settings", () => {
  const empty = claudeStatuslineSetup({});
  assert.equal(empty.configured, false);
  assert.equal(empty.conflict, false);
  assert.deepEqual(empty.fragment, {
    statusLine: { type: "command", command: CLAUDE_STATUSLINE_COMMAND },
  });
  const configured = claudeStatuslineSetup({
    statusLine: { type: "command", command: CLAUDE_STATUSLINE_COMMAND },
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.conflict, false);
  const thirdParty = claudeStatuslineSetup({
    statusLine: { type: "command", command: "/opt/other/statusline.sh" },
  });
  assert.equal(thirdParty.configured, false);
  assert.equal(thirdParty.conflict, true);
  const sameCommandWrongType = claudeStatuslineSetup({
    statusLine: { type: "script", command: CLAUDE_STATUSLINE_COMMAND },
  });
  assert.equal(sameCommandWrongType.configured, false);
  assert.equal(sameCommandWrongType.conflict, true);
});

test("statusline opt in instructions never write settings or leak local paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "balance-onboarding-"));
  const settingsPath = join(dir, "settings.json");
  const original = `${JSON.stringify({
    statusLine: { type: "command", command: "/opt/other/statusline.sh" },
  })}\n`;
  writeFileSync(settingsPath, original);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const response = { available: true, ...claudeStatuslineSetup(settings) };
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /\/Users\/|settingsPath|collectorPath|claude-statusline\.json/);
  assert.equal(serialized.includes(homedir()), false);
  assert.equal(serialized.includes(dir), false);
  assert.ok(serialized.includes("$HOME"));
  assert.equal(readFileSync(settingsPath, "utf8"), original);

  const serverSource = readFileSync(new URL("./watch.ts", import.meta.url), "utf8");
  const handlerStart = serverSource.indexOf("pullClaudeStatuslineSetup");
  assert.notEqual(handlerStart, -1);
  const handlerEnd = serverSource.indexOf("export const", handlerStart + 1);
  const handler = serverSource.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
  const returnStatements = handler.match(/return [^;]*;/g) ?? [];
  assert.deepEqual(returnStatements, [
    "return { available: false };",
    "return { available: true, ...claudeStatuslineSetup(settings) };",
  ]);
});
