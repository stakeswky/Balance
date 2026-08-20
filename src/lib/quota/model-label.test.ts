import assert from "node:assert/strict";
import { test } from "node:test";
import { modelDisplayLabel } from "./model-label.ts";

test("claude opus 4.6 is not shown as Opus 5", () => {
  assert.equal(modelDisplayLabel("claude-opus-4-6", "opus"), "Opus 4.6");
  assert.equal(modelDisplayLabel("claude-opus-4-6-20251001", "opus"), "Opus 4.6");
});

test("claude opus 5 stays Opus 5", () => {
  assert.equal(modelDisplayLabel("claude-opus-5", "opus"), "Opus 5");
  assert.equal(modelDisplayLabel("claude-opus-5-20260724", "opus"), "Opus 5");
});

test("other claude families keep their version from raw", () => {
  assert.equal(modelDisplayLabel("claude-sonnet-4-6", "sonnet"), "Sonnet 4.6");
  assert.equal(modelDisplayLabel("claude-sonnet-5", "sonnet"), "Sonnet 5");
  assert.equal(modelDisplayLabel("claude-haiku-4-5", "haiku"), "Haiku 4.5");
  assert.equal(modelDisplayLabel("claude-fable-5", "fable"), "Fable 5");
});

test("family-only fallback still uses MODEL_META", () => {
  assert.equal(modelDisplayLabel(undefined, "opus"), "Opus 5");
  assert.equal(modelDisplayLabel("opus", "opus"), "Opus 5");
});

test("grok and codex raw ids keep their public names", () => {
  assert.equal(modelDisplayLabel("grok-4.6-build", "grok-4.6"), "Grok 4.6");
  assert.equal(modelDisplayLabel("gpt-5.6-sol", "gpt-5.6-sol"), "GPT-5.6 Sol");
});
