import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("macOS lifecycle verification covers crash cleanup and startup failure", async () => {
  const crash = await readFile(
    new URL("./verify-macos-crash-cleanup.sh", import.meta.url),
    "utf8",
  );
  const startupError = await readFile(
    new URL("./verify-macos-startup-error.sh", import.meta.url),
    "utf8",
  );

  assert.match(crash, /kill -9/);
  assert.match(crash, /exact sidecar pid/i);
  assert.match(crash, /TCP 4780/);
  assert.match(startupError, /127\.0\.0\.1.*4780/);
  assert.match(startupError, /--startup-error/);
  assert.match(startupError, /no sidecar/i);
});
