import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { resolveNitroPreset } from "./distribution-mode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("web builds keep the Vercel preset", () => {
  assert.equal(resolveNitroPreset({}), "vercel");
});

test("desktop builds select the node-server preset", () => {
  assert.equal(resolveNitroPreset({ BALANCE_DISTRIBUTION: "desktop" }), "node-server");
  assert.equal(resolveNitroPreset({ SYNQ_DISTRIBUTION: "desktop" }), "node-server");
});

test("desktop runtime imports db without booting PGLite", () => {
  const dbUrl = pathToFileURL(resolve(root, "src/lib/db.ts")).href;
  const source = [
    'process.env.BALANCE_DESKTOP = "1";',
    `const db = await import(${JSON.stringify(dbUrl)});`,
    'if (db.dbSource !== "disabled") process.exit(21);',
    "await db.ensureDbReady();",
    "if (globalThis.__pgliteInstance__) process.exit(22);",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("desktop health route has a mode-specific response", async () => {
  const source = await readFile(resolve(root, "src/routes/api/desktop-health.ts"), "utf8");
  assert.match(source, /isDesktopRuntime\(process\.env\)/);
  assert.ok(source.includes('{"app":"balance","mode":"desktop"}'));
});

test("desktop auth route rejects before dynamically importing the auth server", async () => {
  const source = await readFile(resolve(root, "src/routes/api/auth/$.ts"), "utf8");
  assert.doesNotMatch(source, /import\s+\{\s*auth\s*\}\s+from/);
  assert.match(source, /isDesktopRuntime\(process\.env\)/);
  assert.match(source, /return new Response\("Not Found", \{ status: 404 \}\)/);
  const guardIndex = source.indexOf("isDesktopRuntime(process.env)");
  const importIndex = source.indexOf('await import("@/lib/auth/server")');
  assert.ok(guardIndex >= 0 && importIndex > guardIndex);
});

test("the document shell lets Vite own the production stylesheet asset", async () => {
  const source = await readFile(resolve(root, "src/routes/__root.tsx"), "utf8");
  assert.match(source, /import "\.\.\/styles\.css";/);
  assert.doesNotMatch(source, /styles\.css\?url/);
  assert.doesNotMatch(source, /rel: "stylesheet"/);
});

test("vite config full-traces the PGLite production fallback", async () => {
  const viteConfig = await readFile(resolve(root, "vite.config.ts"), "utf8");
  assert.match(viteConfig, /traceDeps:\s*\["@electric-sql\/pglite\*"\]/);
});
