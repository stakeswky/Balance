import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { isAllowedUpdateUrl } from "./manifest.ts";
import {
  hotUpdateRoot,
  overlayCurrentDir,
  overlayLooksBootable,
  overlayStagingDir,
  readPackManifest,
} from "./overlay.ts";
import type { HotAsset } from "./version.ts";

export const MAX_PACK_BYTES = 80 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export type DownloadFn = (url: string, dest: string) => Promise<void>;
export type ExtractFn = (zipPath: string, destDir: string) => Promise<void>;

export interface ApplyHotUpdatePackOptions {
  home: string;
  nativeVersion: string;
  asset: HotAsset;
  download?: DownloadFn;
  extract?: ExtractFn;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256Matches(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== 32 || expected.length !== 32) return false;
  return timingSafeEqual(actual, expected);
}

export async function defaultDownload(url: string, dest: string): Promise<void> {
  const partial = `${dest}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(url, {
    headers: { "User-Agent": "Balance-desktop-update" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`hot-update download failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PACK_BYTES) {
    throw new Error("pack exceeds MAX_PACK_BYTES");
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(partial),
  );
  const downloaded = await stat(partial);
  if (downloaded.size > MAX_PACK_BYTES) {
    await rm(partial, { force: true });
    throw new Error("pack exceeds MAX_PACK_BYTES");
  }
  await rename(partial, dest);
}

export async function dittoExtract(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, destDir], { timeout: 60_000 });
}

function isOutsideRoot(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function assertEntryInsideRoot(root: string, entry: string): Promise<void> {
  let resolved: string;
  try {
    resolved = await realpath(entry);
  } catch {
    throw new Error("extracted path escapes overlay");
  }
  if (isOutsideRoot(root, resolved)) {
    throw new Error("extracted path escapes overlay");
  }
}

export async function assertExtractedTreeSafe(dest: string): Promise<void> {
  const root = await realpath(dest);
  await walkExtractedTree(root, root);
}

async function walkExtractedTree(root: string, dir: string): Promise<void> {
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const st = await lstat(full);
    if (st.isSymbolicLink() || st.isFile()) {
      await assertEntryInsideRoot(root, full);
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      await walkExtractedTree(root, full);
    }
  }
}

export async function applyHotUpdatePack(
  opts: ApplyHotUpdatePackOptions,
): Promise<{ packVersion: string }> {
  if (!isAllowedUpdateUrl(opts.asset.url)) {
    throw new Error("hot url is not allowlisted");
  }
  if (opts.asset.size > MAX_PACK_BYTES) {
    throw new Error("pack exceeds MAX_PACK_BYTES");
  }

  const download = opts.download ?? defaultDownload;
  const extract = opts.extract ?? dittoExtract;
  const staging = overlayStagingDir(opts.home);
  const current = overlayCurrentDir(opts.home);
  const previous = join(hotUpdateRoot(opts.home), "previous");
  const zipPath = join(staging, "pack.zip");
  const extractDir = join(staging, "extract");

  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await download(opts.asset.url, zipPath);

    const downloaded = await stat(zipPath);
    if (downloaded.size > MAX_PACK_BYTES) {
      throw new Error("pack exceeds MAX_PACK_BYTES");
    }
    if (opts.asset.size > 0 && downloaded.size !== opts.asset.size) {
      throw new Error("pack size mismatch");
    }

    const digest = await sha256File(zipPath);
    if (!sha256Matches(digest, opts.asset.sha256)) {
      throw new Error("sha256 mismatch");
    }

    await mkdir(extractDir, { recursive: true });
    await extract(zipPath, extractDir);
    await assertExtractedTreeSafe(extractDir);
    if (!overlayLooksBootable(extractDir, opts.nativeVersion)) {
      throw new Error("extracted pack is not bootable");
    }
    const pack = readPackManifest(extractDir);
    if (!pack) {
      throw new Error("extracted pack is not bootable");
    }

    await rm(previous, { recursive: true, force: true });
    try {
      if (existsSync(current)) {
        await rename(current, previous);
      }
      await rename(extractDir, current);
    } catch (error) {
      if (!existsSync(current) && existsSync(previous)) {
        try {
          await rename(previous, current);
        } catch {
          // keep original error
        }
      }
      throw error;
    }

    await rm(previous, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    return { packVersion: pack.packVersion };
  } catch (error) {
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      // keep original error
    }
    throw error;
  }
}
