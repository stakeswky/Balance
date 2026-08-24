import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { parseAntigravityQuotaSummary, type OfficialSlice } from "./official.ts";

export const ANTIGRAVITY_QUOTA_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 64 * 1024;
const MAX_QUOTA_RESPONSE_BYTES = 1024 * 1024;

export interface AntigravityCredential {
  accessToken: string;
  expiresAt: number | null;
}

export type ExecFileText = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ReadCredential = () => Promise<AntigravityCredential | null>;

const execFileAsync = promisify(execFile);
const defaultExecFile: ExecFileText = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: String(result.stdout) };
};

function credentialFromUnknown(raw: unknown): AntigravityCredential | null {
  if (!raw || typeof raw !== "object") return null;
  const token = (raw as { token?: unknown }).token;
  if (!token || typeof token !== "object") return null;
  const accessToken = (token as { access_token?: unknown }).access_token;
  if (
    typeof accessToken !== "string"
    || !accessToken.trim()
    || Buffer.byteLength(accessToken, "utf8") > MAX_ACCESS_TOKEN_BYTES
  ) return null;
  const expiry = (token as { expiry?: unknown }).expiry;
  const parsed = typeof expiry === "string" ? Date.parse(expiry) : Number.NaN;
  return {
    accessToken: accessToken.trim(),
    expiresAt: Number.isFinite(parsed) ? parsed : null,
  };
}

function credentialFromText(text: string): AntigravityCredential | null {
  try {
    const trimmed = text.trim();
    if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_CREDENTIAL_BYTES) return null;
    let json = trimmed;
    if (trimmed.startsWith("go-keyring-base64:")) {
      const encoded = trimmed.slice("go-keyring-base64:".length);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return null;
      }
      json = Buffer.from(encoded, "base64").toString("utf8");
    }
    return credentialFromUnknown(JSON.parse(json));
  } catch {
    return null;
  }
}

export async function readAntigravityCredential(options: {
  home?: string;
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileText;
} = {}): Promise<AntigravityCredential | null> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  if (platform === "darwin") {
    try {
      const result = await execFileImpl(
        "security",
        ["find-generic-password", "-a", "antigravity", "-s", "gemini", "-w"],
        { encoding: "utf8", timeout: 3000, maxBuffer: MAX_CREDENTIAL_BYTES },
      );
      const credential = credentialFromText(result.stdout);
      if (credential) return credential;
    } catch {
      // Compatible file fallbacks remain available when Keychain is locked.
    }
  }
  const candidates = [
    join(home, ".gemini", "jetski-standalone-oauth-token"),
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "oauth_creds.json"),
  ];
  for (const path of candidates) {
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_CREDENTIAL_BYTES) continue;
      const credential = credentialFromText(readFileSync(path, "utf8"));
      if (credential) return credential;
    } catch {
      // Continue to the next explicit credential path.
    }
  }
  return null;
}

function executable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(path)) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findAgyExecutable(options: {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): string | null {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const name = platform === "win32" ? "agy.exe" : "agy";
  const pathCandidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, name));
  const defaults = platform === "win32"
    ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "agy", "bin", name)]
    : [join(home, ".local", "bin", name), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"];
  const candidates = [env.AGY_BIN, ...pathCandidates, ...defaults]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.find((candidate) => executable(candidate, platform)) ?? null;
}

export async function antigravitySessionIdentity(options: {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileText;
  readCredential?: ReadCredential;
} = {}): Promise<string | null> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  const agyPath = findAgyExecutable({ home, platform, env: options.env });
  if (!agyPath) return null;
  let credential: AntigravityCredential | null;
  try {
    credential = await (options.readCredential ?? (() =>
      readAntigravityCredential({ home, platform, execFileImpl })))();
  } catch {
    return null;
  }
  if (!credential) return null;
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(agyPath);
  } catch {
    return null;
  }
  return createHash("sha256")
    .update(canonicalPath)
    .update("\0")
    .update(credential.accessToken)
    .digest("hex");
}

export function antigravityUserAgent(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const clean = version.match(/\d+\.\d+\.\d+/)?.[0];
  if (!clean) return null;
  return `antigravity/${clean} ${platform}/${arch}`;
}

async function boundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_QUOTA_RESPONSE_BYTES) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_QUOTA_RESPONSE_BYTES) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function fetchAntigravityQuota(
  credential: AntigravityCredential,
  options: {
    fetchImpl?: FetchLike;
    now?: number;
    userAgent: string;
    timeoutMs?: number;
  },
): Promise<{ slice: OfficialSlice | null; status: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const response = await fetchImpl(ANTIGRAVITY_QUOTA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": options.userAgent,
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) return { slice: null, status: response.status };
    const body = await boundedJson(response);
    if (controller.signal.aborted) return { slice: null, status: null };
    return {
      slice: parseAntigravityQuotaSummary(body, {
        fetchedAt: options.now ?? Date.now(),
        source: "antigravity-quota-summary",
      }),
      status: response.status,
    };
  } catch {
    return { slice: null, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function safelyReadCredential(readCredential: ReadCredential): Promise<AntigravityCredential | null> {
  try {
    return await readCredential();
  } catch {
    return null;
  }
}

export async function readAntigravityQuota(options: {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  agyPath?: string;
  fetchImpl?: FetchLike;
  execFileImpl?: ExecFileText;
  readCredential?: ReadCredential;
  now?: number;
} = {}): Promise<OfficialSlice | null> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  const agyPath = options.agyPath ?? findAgyExecutable({ home, platform, env: options.env });
  if (!agyPath) return null;
  const readCredential = options.readCredential ?? (() =>
    readAntigravityCredential({ home, platform, execFileImpl }));
  let version: string;
  try {
    version = (await execFileImpl(agyPath, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: MAX_CREDENTIAL_BYTES,
    })).stdout;
  } catch {
    return null;
  }
  const userAgent = antigravityUserAgent(version, platform, options.arch ?? process.arch);
  if (!userAgent) return null;
  const now = options.now ?? Date.now();
  let cliRefreshCount = 0;
  const refreshByCli = async (): Promise<boolean> => {
    if (cliRefreshCount >= 1) return false;
    cliRefreshCount += 1;
    try {
      await execFileImpl(agyPath, ["models"], {
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  };
  let credential = await safelyReadCredential(readCredential);
  if (!credential) return null;
  if (credential.expiresAt != null && credential.expiresAt <= now + 30_000) {
    if (!await refreshByCli()) return null;
    credential = await safelyReadCredential(readCredential);
    if (!credential) return null;
  }
  const first = await fetchAntigravityQuota(credential, {
    fetchImpl: options.fetchImpl,
    now,
    userAgent,
  });
  if (first.slice || first.status !== 401) return first.slice;
  if (cliRefreshCount === 0 && !await refreshByCli()) return null;
  const refreshed = await safelyReadCredential(readCredential);
  if (!refreshed) return null;
  return (await fetchAntigravityQuota(refreshed, {
    fetchImpl: options.fetchImpl,
    now,
    userAgent,
  })).slice;
}
