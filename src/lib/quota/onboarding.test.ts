import assert from "node:assert/strict";
import { test } from "node:test";
import { onboardingState } from "./onboarding.ts";

test("onboarding reports checking before detection finishes", () => {
  assert.equal(
    onboardingState({ claude: false, grok: false, codex: false }, true, null),
    "checking",
  );
});

test("onboarding distinguishes ready, empty, and error states", () => {
  assert.equal(onboardingState({ claude: true, grok: false, codex: false }, false, null), "ready");
  assert.equal(onboardingState({ claude: false, grok: false, codex: false }, false, null), "empty");
  assert.equal(
    onboardingState({ claude: false, grok: false, codex: false }, false, "检测失败"),
    "error",
  );
});
