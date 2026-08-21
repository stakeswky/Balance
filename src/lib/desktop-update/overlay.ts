import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareSemver, parseSemver } from "./version.ts";

export interface PackManifest {
  schemaVersion: 1;
  app: "balance";
  packVersion: string;
  minNativeVersion: string;
  nativeVersion?: string;
  gitSha?: string;
}

export function hotUpdateRoot(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "darwin") {
    throw new Error("desktop hot update is macOS-only");
  }
  return join(home, "Library", "Application Support", "Balance", "hot-update");
}

export function overlayCurrentDir(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(hotUpdateRoot(home, platform), "current");
}

export function overlayStagingDir(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(hotUpdateRoot(home, platform), "staging");
}

export function readPackManifest(dir: string): PackManifest | null {
  const path = join(dir, "pack.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PackManifest;
    if (value.schemaVersion !== 1 || value.app !== "balance") return null;
    if (!parseSemver(value.packVersion) || !parseSemver(value.minNativeVersion)) return null;
    return value;
  } catch {
    return null;
  }
}

export function isPackCompatible(pack: PackManifest | null, nativeVersion: string): boolean {
  if (!pack) return false;
  return compareSemver(nativeVersion, pack.minNativeVersion) >= 0;
}

export function writePackJson(dir: string, pack: PackManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
}

export function overlayLooksBootable(dir: string, nativeVersion: string): boolean {
  return (
    existsSync(join(dir, "server", "index.mjs")) &&
    existsSync(join(dir, "public")) &&
    isPackCompatible(readPackManifest(dir), nativeVersion)
  );
}
