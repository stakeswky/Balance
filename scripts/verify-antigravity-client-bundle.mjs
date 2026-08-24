#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const browserRoots = [
  resolve(root, ".output", "public"),
  resolve(root, "dist"),
  resolve(root, ".vercel", "output", "static"),
].filter(existsSync);
const forbidden = [
  "find-generic-password",
  "jetski-standalone-oauth-token",
  "v1internal:retrieveUserQuotaSummary",
  "Bearer ",
  "access_token",
  "refresh_token",
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return statSync(path).isFile() ? [path] : [];
  });
}

assert.ok(browserRoots.length > 0, "no browser build output found");
const violations = [];
let scannedFiles = 0;
for (const directory of browserRoots) {
  for (const path of files(directory)) {
    scannedFiles += 1;
    const body = readFileSync(path);
    for (const marker of forbidden) {
      if (body.includes(Buffer.from(marker))) {
        violations.push({ file: relative(root, path), marker });
      }
    }
  }
}
assert.deepEqual(violations, []);
process.stdout.write(`${JSON.stringify({ scannedFiles, violations: 0 })}\n`);
