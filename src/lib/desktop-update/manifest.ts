import { parseSemver } from "./version.ts";

export const DEFAULT_MANIFEST_URL =
  "https://github.com/stakeswky/Balance/releases/latest/download/update-manifest.json";

const RELEASE_PREFIXES = [
  "/stakeswky/Balance/releases/download/",
  "/stakeswky/Balance/releases/latest/download/",
];

const ALLOWED_INSTALLER_PAGE_URL = "https://github.com/stakeswky/Balance/releases/latest";

export interface ParsedManifest {
  schemaVersion: 1;
  app: "balance";
  packVersion: string;
  minNativeVersion: string;
  nativeVersion: string;
  gitSha: string;
  publishedAt: string;
  hot: { url: string; sha256: string; size: number };
  installer: { url: string };
}

export function isAllowedUpdateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "github.com") return false;
  return RELEASE_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
}

export function isAllowedInstallerUrl(url: string): boolean {
  return isAllowedUpdateUrl(url) || url === ALLOWED_INSTALLER_PAGE_URL;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid manifest field: ${field}`);
  }
  return value;
}

function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid manifest field: ${field}`);
  }
  return value;
}

export function parseUpdateManifest(raw: string): ParsedManifest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error("unsupported manifest schema");
  if (value.app !== "balance") throw new Error("unexpected manifest app");
  const packVersion = asString(value.packVersion, "packVersion");
  const minNativeVersion = asString(value.minNativeVersion, "minNativeVersion");
  const nativeVersion = asString(value.nativeVersion, "nativeVersion");
  if (!parseSemver(packVersion) || !parseSemver(minNativeVersion) || !parseSemver(nativeVersion)) {
    throw new Error("invalid manifest version");
  }
  const hotValue = value.hot as Record<string, unknown> | undefined;
  const installerValue = value.installer as Record<string, unknown> | undefined;
  if (!hotValue || !installerValue) throw new Error("manifest missing assets");
  const hotUrl = asString(hotValue.url, "hot.url");
  const installerUrl = asString(installerValue.url, "installer.url");
  const sha256 = asString(hotValue.sha256, "hot.sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid hot sha256");
  if (!isAllowedUpdateUrl(hotUrl)) throw new Error("hot url is not allowlisted");
  if (!isAllowedInstallerUrl(installerUrl)) throw new Error("installer url is not allowlisted");
  return {
    schemaVersion: 1,
    app: "balance",
    packVersion,
    minNativeVersion,
    nativeVersion,
    gitSha: asString(value.gitSha, "gitSha"),
    publishedAt: asString(value.publishedAt, "publishedAt"),
    hot: { url: hotUrl, sha256, size: asNonNegativeInt(hotValue.size, "hot.size") },
    installer: { url: installerUrl },
  };
}
