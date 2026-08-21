import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("desktop update RPCs are GET check and POST apply", async () => {
  const source = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(source, /createServerFn\(\{ method: "GET" \}\)/);
  assert.match(source, /createServerFn\(\{ method: "POST" \}\)/);
  assert.match(source, /checkForUpdate/);
  assert.match(source, /applyCheckedUpdate/);
  assert.match(source, /\.validator\(\(data: unknown\) => data \?\? null\)/);
  const guards = source.match(/assertQuotaRequestAllowed\(\)/g) ?? [];
  assert.equal(guards.length, 2);
});

test("checkDesktopUpdate unwraps decision so UI does not drill into it", async () => {
  const source = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(source, /export const checkDesktopUpdate/);
  assert.match(source, /export const applyDesktopUpdate/);
  assert.match(source, /from "\.\.\/quota\/local-request\.server\.ts"/);
  assert.match(source, /kind: "hot" as const/);
  assert.match(source, /kind: "installer" as const/);
  assert.match(source, /kind: "current" as const/);
  assert.match(source, /kind: "unavailable" as const/);
  assert.doesNotMatch(source, /return checkForUpdate\(\)/);
});
