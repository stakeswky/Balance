export interface LocalVersion {
  packVersion: string;
  nativeVersion: string;
}

export interface HotAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface UpdateManifestLike {
  packVersion: string;
  minNativeVersion: string;
}

export type UpdateDecision =
  | { kind: "current" }
  | { kind: "hot"; remote: UpdateManifestLike & { hot: HotAsset; installer: { url: string } } }
  | { kind: "installer"; remote: UpdateManifestLike & { installer: { url: string } } }
  | { kind: "unavailable"; reason: string };

export function parseSemver(version: string): [number, number, number] | null {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

export function decideUpdate(
  local: LocalVersion,
  remote: UpdateManifestLike & { hot?: HotAsset; installer?: { url: string } },
): UpdateDecision {
  const packCmp = compareSemver(remote.packVersion, local.packVersion);
  if (Number.isNaN(packCmp) || Number.isNaN(compareSemver(local.nativeVersion, remote.minNativeVersion))) {
    return { kind: "unavailable", reason: "invalid-version" };
  }
  if (packCmp <= 0) return { kind: "current" };
  if (compareSemver(local.nativeVersion, remote.minNativeVersion) < 0) {
    return {
      kind: "installer",
      remote: {
        packVersion: remote.packVersion,
        minNativeVersion: remote.minNativeVersion,
        installer: remote.installer ?? { url: "https://github.com/stakeswky/Balance/releases/latest" },
      },
    };
  }
  if (!remote.hot) return { kind: "unavailable", reason: "missing-hot-asset" };
  return {
    kind: "hot",
    remote: {
      packVersion: remote.packVersion,
      minNativeVersion: remote.minNativeVersion,
      hot: remote.hot,
      installer: remote.installer ?? { url: "https://github.com/stakeswky/Balance/releases/latest" },
    },
  };
}
