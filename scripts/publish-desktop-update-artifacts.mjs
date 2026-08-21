import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function releaseTag(explicit) {
  if (explicit) return explicit;
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  return "latest";
}

export async function publishDesktopUpdateArtifacts({
  root = DEFAULT_ROOT,
  outputDir = join(root, ".output"),
  artifactsDir = join(root, "artifacts"),
  tag = releaseTag(),
  gitSha = process.env.GITHUB_SHA ?? "unknown",
  publishedAt = new Date().toISOString(),
} = {}) {
  const packPath = join(outputDir, "pack.json");
  const serverEntry = join(outputDir, "server", "index.mjs");
  if (!existsSync(packPath) || !existsSync(serverEntry) || !existsSync(join(outputDir, "public"))) {
    throw new Error("desktop output is missing pack.json, server/index.mjs, or public/");
  }
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  mkdirSync(artifactsDir, { recursive: true });
  const zipPath = join(artifactsDir, "balance-server.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", ".", zipPath], { cwd: outputDir });
  const sha256 = await sha256File(zipPath);
  const size = statSync(zipPath).size;
  const manifest = {
    schemaVersion: 1,
    app: "balance",
    packVersion: pack.packVersion,
    minNativeVersion: pack.minNativeVersion,
    nativeVersion: pack.nativeVersion ?? pack.minNativeVersion,
    gitSha: pack.gitSha ?? gitSha,
    publishedAt,
    hot: {
      url: `https://github.com/stakeswky/Balance/releases/download/${tag}/balance-server.zip`,
      sha256,
      size,
    },
    installer: {
      url: "https://github.com/stakeswky/Balance/releases/latest",
    },
  };
  const manifestPath = join(artifactsDir, "update-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { zipPath, manifestPath, sha256, size, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await publishDesktopUpdateArtifacts();
}
