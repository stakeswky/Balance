#!/usr/bin/env node
import assert from "node:assert/strict";
import { createReadStream, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAntigravityCredential } from "../src/lib/quota/antigravity.server.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactRoots = [
  resolve(root, ".output"),
  resolve(root, ".vercel", "output"),
  resolve(root, "dist"),
  resolve(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", "Balance.app"),
].filter(existsSync).map((path) => {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`artifact root symlink is not allowed: ${relative(root, path)}`);
  }
  return path;
});

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`artifact symlink is not allowed: ${relative(root, path)}`);
    }
    if (stats.isDirectory()) return files(path);
    return stats.isFile() ? [path] : [];
  });
}

async function containsSecret(path, secret) {
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const body = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
    if (body.includes(secret)) return true;
    const overlap = Math.max(0, secret.length - 1);
    tail = overlap > 0 ? body.subarray(Math.max(0, body.length - overlap)) : Buffer.alloc(0);
  }
  return false;
}

assert.ok(artifactRoots.length > 0, "no build artifact found");
const credential = await readAntigravityCredential();
assert.ok(credential, "Antigravity credential unavailable");
const secret = Buffer.from(credential.accessToken, "utf8");
const violations = [];
let scannedFiles = 0;
for (const directory of artifactRoots) {
  for (const path of files(directory)) {
    scannedFiles += 1;
    if (await containsSecret(path, secret)) {
      violations.push(relative(root, path));
    }
  }
}
assert.deepEqual(violations, []);
process.stdout.write(`${JSON.stringify({ scannedFiles, violations: 0 })}\n`);
