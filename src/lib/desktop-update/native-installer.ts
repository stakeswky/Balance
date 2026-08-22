import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface NativeInstallProgress {
  downloaded: number;
  total?: number;
  percent?: number;
}

interface NativeUpdateHandle {
  version: string;
  downloadAndInstall(
    onEvent?: (event: DownloadEvent) => void,
    options?: { timeout?: number },
  ): Promise<void>;
}

export type CheckNativeUpdate = () => Promise<NativeUpdateHandle | null>;

async function checkWithTauri(): Promise<NativeUpdateHandle | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 30_000 });
}

export async function installNativeUpdate(
  options: {
    checkImpl?: CheckNativeUpdate;
    onProgress?: (progress: NativeInstallProgress) => void;
  } = {},
): Promise<{ version: string }> {
  const update = await (options.checkImpl ?? checkWithTauri)();
  if (!update) {
    throw new Error("native update is not available");
  }

  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall(
    (event) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
        downloaded = 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      }

      const percent =
        total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;
      options.onProgress?.({ downloaded, total, percent });
    },
    { timeout: 120_000 },
  );

  return { version: update.version };
}
