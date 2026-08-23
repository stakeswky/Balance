import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

function requiredHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  if (!home || !isAbsolute(home)) throw new Error("HOME must be an absolute path");
  return home;
}

export function orchestratorStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.BALANCE_STATE_DIR?.trim();
  if (override) {
    if (override.includes("\0") || !isAbsolute(override)) {
      throw new Error("BALANCE_STATE_DIR must be an absolute path without NUL");
    }
    return resolve(override);
  }
  if (platform === "darwin") {
    return join(requiredHome(env), "Library", "Application Support", "Balance", "orchestrator");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData || !isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA must be an absolute path on Windows");
    }
    return join(localAppData, "Balance", "orchestrator");
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  const dataRoot = xdgDataHome && isAbsolute(xdgDataHome)
    ? xdgDataHome
    : join(requiredHome(env), ".local", "share");
  return join(dataRoot, "Balance", "orchestrator");
}

function pathPrefixes(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length);
  const prefixes: string[] = [];
  let current = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = join(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}

async function rejectSymlinkComponents(path: string, allowMissing: boolean): Promise<void> {
  for (const prefix of pathPrefixes(path)) {
    try {
      const metadata = await lstat(prefix);
      const trustedDarwinAlias =
        process.platform === "darwin" &&
        ["/etc", "/tmp", "/var"].includes(prefix) &&
        metadata.uid === 0 &&
        (await realpath(prefix)) === `/private${prefix}`;
      if (metadata.isSymbolicLink() && !trustedDarwinAlias) {
        throw new Error(`state path contains a symbolic link: ${prefix}`);
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("private directory path must be absolute and contain no NUL");
  }
  await rejectSymlinkComponents(path, true);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(path, false);
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) throw new Error(`private path is not a directory: ${path}`);
  const effectiveUid = process.geteuid?.();
  if (effectiveUid !== undefined && metadata.uid !== effectiveUid) {
    throw new Error(`private directory is not owned by the current user: ${path}`);
  }
  await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}
