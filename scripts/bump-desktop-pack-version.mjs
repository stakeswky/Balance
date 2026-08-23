import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseSemver(version) {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

export function bumpPatch(version) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`invalid packVersion: ${version}`);
  return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`;
}

export function nextPackVersion(localVersion, remoteVersion) {
  if (remoteVersion == null || remoteVersion === "") return bumpPatch(localVersion);
  const cmp = compareSemver(remoteVersion, localVersion);
  if (Number.isNaN(cmp)) throw new Error(`invalid packVersion: ${remoteVersion}`);
  return bumpPatch(cmp > 0 ? remoteVersion : localVersion);
}

export function writeBumpedPack({
  packPath = join(DEFAULT_ROOT, "desktop-pack.json"),
  remotePackVersion = process.env.BALANCE_REMOTE_PACK_VERSION,
} = {}) {
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  if (pack.schemaVersion !== 1 || pack.app !== "balance") {
    throw new Error("desktop-pack.json is not a Balance pack");
  }
  const previous = pack.packVersion;
  const next = nextPackVersion(previous, remotePackVersion);
  const updated = { ...pack, packVersion: next };
  writeFileSync(packPath, `${JSON.stringify(updated, null, 2)}\n`);
  return { previous, next };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = writeBumpedPack();
  process.stdout.write(`${result.previous} -> ${result.next}\n`);
}
