"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- NODE_OPTIONS --require needs CommonJS. */
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");

const tempDirectory = process.env.TMPDIR;
if (!tempDirectory) {
  throw new Error("NODE_OPTIONS sentinel requires TMPDIR");
}
appendFileSync(join(tempDirectory, "node-options-loaded"), "loaded\n");
