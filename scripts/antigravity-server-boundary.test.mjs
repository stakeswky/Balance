import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [path];
  });
}

test("Antigravity credentials remain behind server-only modules", () => {
  const violations = sourceFiles(join(root, "src"))
    .filter((path) => [".ts", ".tsx"].includes(extname(path)))
    .filter((path) => !path.endsWith(".server.ts") && !path.endsWith(".server.test.ts"))
    .filter((path) => readFileSync(path, "utf8").includes("antigravity.server"))
    .map((path) => relative(root, path));
  assert.deepEqual(violations, []);
});
