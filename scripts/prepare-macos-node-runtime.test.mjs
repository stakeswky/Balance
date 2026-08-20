import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NODE_BASE_URL,
  NODE_VERSION,
  prepareRuntime,
  runtimeSpec,
  sha256File,
} from "./prepare-macos-node-runtime.mjs";

test("arm64 runtime metadata is immutable", () => {
  const spec = runtimeSpec("aarch64-apple-darwin");
  assert.equal(NODE_VERSION, "v22.23.2");
  assert.equal(NODE_BASE_URL, "https://nodejs.org/dist/v22.23.2");
  assert.equal(spec.archive, "node-v22.23.2-darwin-arm64.tar.gz");
  assert.equal(
    spec.sha256,
    "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  );
  assert.equal(spec.output, "synq-node-aarch64-apple-darwin");
  assert.equal(
    spec.url,
    "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz",
  );
});

test("unsupported targets fail closed", () => {
  assert.throws(
    () => runtimeSpec("x86_64-apple-darwin"),
    /Unsupported desktop target/,
  );
});

test("sha256File returns the digest used before extraction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synq-runtime-test-"));
  const file = join(dir, "payload");
  await writeFile(file, "synq");
  assert.equal(
    await sha256File(file),
    "174a0e7303fa76871b0600446cc53b7ab9cd612d1b074ceb90ae9831120e20fd",
  );
});

test("prepareRuntime re-downloads a bad cached archive and refreshes outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "synq-runtime-root-"));
  const archiveDir = join(root, ".cache", "synq-desktop");
  const binariesDir = join(root, "src-tauri", "binaries");
  const resourcesDir = join(root, "src-tauri", "resources", "node");
  const spec = runtimeSpec("aarch64-apple-darwin");
  const archivePath = join(archiveDir, spec.archive);
  const outputPath = join(binariesDir, spec.output);
  const licensePath = join(resourcesDir, "LICENSE");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });
  writeFileSync(archivePath, "stale archive");
  writeFileSync(outputPath, "old binary");
  chmodSync(outputPath, 0o644);

  let downloads = 0;
  let extracts = 0;
  const result = await prepareRuntime({
    root,
    download: async (url, destination) => {
      downloads += 1;
      assert.equal(url, spec.url);
      assert.equal(destination, archivePath);
      writeFileSync(destination, "fresh archive");
    },
    extract: ({ archivePath: sourceArchivePath, outputPath, licensePath }) => {
      extracts += 1;
      assert.equal(sourceArchivePath, archivePath);
      writeFileSync(outputPath, "new binary");
      chmodSync(outputPath, 0o755);
      writeFileSync(licensePath, "Node license\n      \thttps://example.test/license\n");
    },
    sha256: async (path) => {
      if (path === archivePath) {
        return downloads === 0 ? "bad-cache-digest" : spec.sha256;
      }
      throw new Error(`Unexpected hash request for ${path}`);
    },
  });

  assert.equal(downloads, 1);
  assert.equal(extracts, 1);
  assert.deepEqual(result, { archivePath, licensePath, outputPath });
  assert.equal(readFileSync(archivePath, "utf8"), "fresh archive");
  assert.equal(readFileSync(outputPath, "utf8"), "new binary");
  assert.equal(
    readFileSync(licensePath, "utf8"),
    "Node license\n\thttps://example.test/license\n",
  );
});

test("prepareRuntime fails closed when the downloaded archive checksum mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "synq-runtime-root-"));
  const spec = runtimeSpec("aarch64-apple-darwin");
  const archivePath = join(root, ".cache", "synq-desktop", spec.archive);
  let downloads = 0;
  let extracts = 0;

  await assert.rejects(
    () =>
      prepareRuntime({
        root,
        download: async (_url, destination) => {
          downloads += 1;
          writeFileSync(destination, "bad archive");
        },
        extract: () => {
          extracts += 1;
        },
        sha256: async (path) => {
          if (path === archivePath) return "still-bad";
          throw new Error(`Unexpected hash request for ${path}`);
        },
      }),
    /Node runtime checksum mismatch: still-bad/,
  );

  assert.equal(downloads, 1);
  assert.equal(extracts, 0);
  assert.equal(existsSync(archivePath), false);
});
