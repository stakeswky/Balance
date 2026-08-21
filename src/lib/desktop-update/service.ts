import { homedir } from "node:os";
import { isDesktopRuntime } from "../runtime-mode.ts";
import { applyHotUpdatePack, type DownloadFn, type ExtractFn } from "./apply.ts";
import { DEFAULT_MANIFEST_URL, parseUpdateManifest } from "./manifest.ts";
import { overlayCurrentDir, overlayLooksBootable, readPackManifest } from "./overlay.ts";
import { decideUpdate, type LocalVersion, type UpdateDecision } from "./version.ts";

export const CHECK_USER_AGENT = "Balance-desktop-update";

function resolveNativeVersion(nativeVersion?: string): string {
  return nativeVersion ?? process.env.BALANCE_NATIVE_VERSION ?? "0.0.0";
}

export async function readLocalVersion(opts: {
  home: string;
  bundledRoot: string;
  nativeVersion: string;
}): Promise<LocalVersion & { source: "overlay" | "bundled" }> {
  const current = overlayCurrentDir(opts.home);
  if (overlayLooksBootable(current, opts.nativeVersion)) {
    const pack = readPackManifest(current);
    return {
      packVersion: pack?.packVersion ?? "0.0.0",
      nativeVersion: opts.nativeVersion,
      source: "overlay",
    };
  }
  const bundled = readPackManifest(opts.bundledRoot);
  return {
    packVersion: bundled?.packVersion ?? "0.0.0",
    nativeVersion: opts.nativeVersion,
    source: "bundled",
  };
}

export async function checkForUpdate(opts: {
  home?: string;
  bundledRoot?: string;
  nativeVersion?: string;
  isDesktop?: boolean;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
} = {}): Promise<{ local: LocalVersion; decision: UpdateDecision }> {
  const home = opts.home ?? homedir();
  const bundledRoot = opts.bundledRoot ?? process.cwd();
  const nativeVersion = resolveNativeVersion(opts.nativeVersion);
  const isDesktop = opts.isDesktop ?? isDesktopRuntime();
  const local = await readLocalVersion({ home, bundledRoot, nativeVersion });

  if (!isDesktop) {
    return { local, decision: { kind: "unavailable", reason: "not-desktop" } };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const manifestUrl = opts.manifestUrl ?? DEFAULT_MANIFEST_URL;

  let response: Response;
  try {
    response = await fetchImpl(manifestUrl, {
      method: "GET",
      headers: { "User-Agent": CHECK_USER_AGENT },
    });
  } catch {
    return { local, decision: { kind: "unavailable", reason: "network" } };
  }

  if (!response.ok) {
    return { local, decision: { kind: "unavailable", reason: "network" } };
  }

  try {
    const parsed = parseUpdateManifest(await response.text());
    return { local, decision: decideUpdate(local, parsed) };
  } catch {
    return { local, decision: { kind: "unavailable", reason: "invalid-manifest" } };
  }
}

export async function applyCheckedUpdate(opts: {
  home?: string;
  bundledRoot?: string;
  nativeVersion?: string;
  isDesktop?: boolean;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
  download?: DownloadFn;
  extract?: ExtractFn;
} = {}): Promise<
  | { kind: "ready-restart"; packVersion: string }
  | { kind: "installer"; url: string; packVersion: string }
  | { kind: "current" }
  | { kind: "unavailable"; reason: string }
> {
  const { decision } = await checkForUpdate(opts);
  if (decision.kind === "hot") {
    const home = opts.home ?? homedir();
    const nativeVersion = resolveNativeVersion(opts.nativeVersion);
    const applied = await applyHotUpdatePack({
      home,
      nativeVersion,
      asset: decision.remote.hot,
      download: opts.download,
      extract: opts.extract,
    });
    return { kind: "ready-restart", packVersion: applied.packVersion };
  }
  if (decision.kind === "installer") {
    return {
      kind: "installer",
      url: decision.remote.installer.url,
      packVersion: decision.remote.packVersion,
    };
  }
  if (decision.kind === "current") {
    return { kind: "current" };
  }
  return { kind: "unavailable", reason: decision.reason };
}
