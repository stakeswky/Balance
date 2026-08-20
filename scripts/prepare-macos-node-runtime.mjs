import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "v22.23.2";
export const NODE_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ARM64_SPEC = Object.freeze({
  archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
  directory: `node-${NODE_VERSION}-darwin-arm64`,
  sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  output: "synq-node-aarch64-apple-darwin",
  url: `${NODE_BASE_URL}/node-${NODE_VERSION}-darwin-arm64.tar.gz`,
});

export function runtimeSpec(target) {
  if (target !== "aarch64-apple-darwin") {
    throw new Error(`Unsupported desktop target: ${target}`);
  }
  return ARM64_SPEC;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url, destination) {
  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Node runtime download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, destination);
}

function extractNodeRuntime({ archivePath, licensePath, outputPath, spec }) {
  const extractDir = mkdtempSync(join(tmpdir(), "synq-node-runtime-"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
    const sourceRoot = join(extractDir, spec.directory);
    const sourceNode = join(sourceRoot, "bin", "node");
    const sourceLicense = join(sourceRoot, "LICENSE");
    if (!existsSync(sourceNode) || !existsSync(sourceLicense)) {
      throw new Error("Node runtime archive is missing bin/node or LICENSE");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    mkdirSync(dirname(licensePath), { recursive: true });
    copyFileSync(sourceNode, outputPath);
    chmodSync(outputPath, 0o755);
    copyFileSync(sourceLicense, licensePath);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export async function prepareRuntime({
  root = ROOT,
  target = process.env.TAURI_ENV_TARGET_TRIPLE ?? "aarch64-apple-darwin",
  download: downloadArchive = download,
  extract = extractNodeRuntime,
  sha256 = sha256File,
} = {}) {
  const spec = runtimeSpec(target);
  const cacheDir = join(root, ".cache", "synq-desktop");
  const archivePath = join(cacheDir, spec.archive);
  const outputPath = join(root, "src-tauri", "binaries", spec.output);
  const licensePath = join(root, "src-tauri", "resources", "node", "LICENSE");
  await mkdir(cacheDir, { recursive: true });

  if (existsSync(archivePath) && (await sha256(archivePath)) !== spec.sha256) {
    rmSync(archivePath, { force: true });
  }
  if (!existsSync(archivePath)) {
    await downloadArchive(spec.url, archivePath);
  }
  const digest = await sha256(archivePath);
  if (digest !== spec.sha256) {
    rmSync(archivePath, { force: true });
    throw new Error(`Node runtime checksum mismatch: ${digest}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(licensePath), { recursive: true });
  extract({ archivePath, licensePath, outputPath, spec });

  return { archivePath, licensePath, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareRuntime();
  process.stdout.write(`${result.outputPath}\n`);
}
