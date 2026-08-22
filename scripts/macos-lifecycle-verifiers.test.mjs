import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("macOS lifecycle verification covers crash cleanup and startup failure", async () => {
  const app = await readFile(new URL("./verify-macos-app.sh", import.meta.url), "utf8");
  const crash = await readFile(new URL("./verify-macos-crash-cleanup.sh", import.meta.url), "utf8");
  const startupError = await readFile(
    new URL("./verify-macos-startup-error.sh", import.meta.url),
    "utf8",
  );
  const environment = await readFile(
    new URL("./verify-macos-env-isolation.sh", import.meta.url),
    "utf8",
  );

  assert.match(crash, /kill -9/);
  assert.match(crash, /exact sidecar pid/i);
  assert.match(crash, /TCP 4780/);
  assert.match(startupError, /127\.0\.0\.1.*4780/);
  assert.match(startupError, /--startup-error/);
  assert.match(startupError, /no sidecar/i);
  assert.match(environment, /DATABASE_URL=/);
  assert.match(environment, /NODE_OPTIONS=/);
  assert.match(environment, /api\/auth\/get-session/);
  assert.match(environment, /HTTP 404/);
  assert.match(environment, /sentinel/i);
  assert.match(environment, /TCP 4780/);
  assert.match(app, /"\$APP_BINARY"[^\n]*&/);
  assert.doesNotMatch(app, /open -n "\$APP_PATH"/);
  assert.match(app, /menu bar item \\"Balance\\"/);
  assert.match(app, /menu item \\"退出余量\\"/);
  assert.doesNotMatch(app, /click button 1 of window 1/);
  assert.match(app, /NO_PROXY='\*'/);
  for (const proxy of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    assert.match(app, new RegExp(`${proxy}=''`));
  }
});
