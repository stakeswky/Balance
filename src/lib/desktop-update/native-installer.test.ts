import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installNativeUpdate,
  type CheckNativeUpdate,
  type NativeInstallProgress,
} from "./native-installer.ts";

test("fails when the native updater reports no newer application", async () => {
  await assert.rejects(
    () => installNativeUpdate({ checkImpl: async () => null }),
    /native update is not available/,
  );
});

test("downloads, installs, and reports cumulative native update progress", async () => {
  const progress: NativeInstallProgress[] = [];
  let timeout: number | undefined;
  const checkImpl: CheckNativeUpdate = async () => ({
    version: "0.3.1",
    async downloadAndInstall(onEvent, options) {
      timeout = options?.timeout;
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 75 } });
      onEvent?.({ event: "Finished" });
    },
  });

  const result = await installNativeUpdate({
    checkImpl,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(result, { version: "0.3.1" });
  assert.equal(timeout, 120_000);
  assert.deepEqual(progress, [
    { downloaded: 0, total: 100, percent: 0 },
    { downloaded: 25, total: 100, percent: 25 },
    { downloaded: 100, total: 100, percent: 100 },
    { downloaded: 100, total: 100, percent: 100 },
  ]);
});

test("propagates native check and install failures", async () => {
  await assert.rejects(
    () =>
      installNativeUpdate({
        checkImpl: async () => {
          throw new Error("check failed");
        },
      }),
    /check failed/,
  );

  await assert.rejects(
    () =>
      installNativeUpdate({
        checkImpl: async () => ({
          version: "0.3.1",
          async downloadAndInstall() {
            throw new Error("signature failed");
          },
        }),
      }),
    /signature failed/,
  );
});
