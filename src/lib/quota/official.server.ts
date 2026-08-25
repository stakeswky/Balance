import { execFile } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  readJsonlTailFile,
  readParsedFile,
  type JsonlTailCache,
  type ParsedFileCache,
} from "./local-file-cache.server.ts";
import {
  antigravitySessionIdentity,
  readAntigravityQuota,
} from "./antigravity.server.ts";
import {
  codexAuthFromFile,
  collapseOfficialPlateaus,
  grokAccessTokenFromAuthFile,
  mergeGrokOfficial,
  parseClaudeHistoryPoints,
  parseClaudePlanHistory,
  parseClaudeStatuslinePayload,
  parseClaudeUsagePayload,
  parseCodexRateLimitLog,
  parseCodexUsagePayload,
  parseGrokBillingLog,
  parseGrokBillingLogAll,
  parseGrokBillingLogLine,
  parseGrokBillingPayload,
  quotaPoolsWithStale,
  slicesFromClaudeHistory,
  type OfficialQuota,
  type OfficialSlice,
} from "./official.ts";

export const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const GROK_BILLING_CACHE_MS = 30_000;
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_STALE_MS = 60 * 60 * 1000;
export const CLAUDE_BACKOFF_BASE_MS = 30_000;
export const CLAUDE_BACKOFF_MAX_MS = 60 * 60 * 1000;

export interface ClaudeOauthAuth {
  accessToken: string;
}

interface ClaudeUsageFetchResult {
  slice: OfficialSlice | null;
  status: number | null;
  retryAfterMs: number | null;
}

interface ClaudeCacheEntry {
  checkedAt: number;
  loadedAt: number;
  slice: OfficialSlice | null;
  failureCount: number;
  nextAllowedAt: number;
  updatedAt: number;
  lastAttemptFailed: boolean;
}

interface AntigravityCacheEntry {
  checkedAt: number;
  loadedAt: number;
  slice: OfficialSlice | null;
  lastAttemptFailed: boolean;
}

interface ClaudeSnapshotFile {
  version: 1;
  claude: ClaudeCacheEntry;
}

type ClaudeLockResult<T> =
  | { state: "acquired"; value: T }
  | { state: "busy" }
  | { state: "unavailable" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ReadClaudeAuth = (home: string, now: number) => Promise<ClaudeOauthAuth | null>;
type ReadAntigravityIdentity = (options: { home?: string }) => Promise<string | null>;
type ReadAntigravity = (options: {
  home?: string;
  fetchImpl?: FetchLike;
  now?: number;
}) => Promise<OfficialSlice | null>;
type ExecFileText = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface ClaudeAuthDiscoveryOptions {
  platform?: NodeJS.Platform;
  currentHome?: string;
  env?: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileText;
}

const execFileAsync = promisify(execFile);
const execFileText: ExecFileText = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: String(result.stdout) };
};
const claudeCache = new Map<string, ClaudeCacheEntry>();
const grokCache = new Map<string, { at: number; slice: OfficialSlice | null }>();
const codexCache = new Map<string, { at: number; slice: OfficialSlice | null }>();
const antigravityCache = new Map<string, AntigravityCacheEntry>();
const antigravityCacheKeyByHome = new Map<string, string>();

// File-level caches for local official data files.
// readClaudeOfficial and readGrokLog/readOfficialHistory use these to skip
// re-parsing unchanged files on disk.
let claudeHistoryFileCache: ParsedFileCache<OfficialSlice | null> | null = null;
let claudeHistorySlicesCache: ParsedFileCache<OfficialSlice[]> | null = null;
let grokLogFileCache: JsonlTailCache<OfficialSlice> | null = null;

function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function grokHomeOf(home: string, override?: string): string {
  return override || process.env.GROK_HOME || join(home, ".grok");
}

function codexHomeOf(home: string, override?: string): string {
  return override || process.env.CODEX_HOME || join(home, ".codex");
}

export function claudeSnapshotPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Balance", "official-quota.json");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Balance", "official-quota.json");
  }
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "balance", "official-quota.json");
}

export function legacyClaudeSnapshotPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Synq", "official-quota.json");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Synq", "official-quota.json");
  }
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "synq", "official-quota.json");
}

export function resolveClaudeSnapshotPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const current = claudeSnapshotPath(home, platform, env);
  const legacy = legacyClaudeSnapshotPath(home, platform, env);
  if (existsSync(current) || !existsSync(legacy)) return current;
  mkdirSync(dirname(current), { recursive: true });
  try {
    copyFileSync(legacy, current);
    return current;
  } catch {
    return legacy;
  }
}

function nullableFiniteNumber(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function officialSliceFromSnapshot(raw: unknown): OfficialSlice | null {
  const slice = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!slice || slice.agent !== "claude") return null;
  if (slice.windowKind !== "five_hour" && slice.windowKind !== "weekly") return null;
  if (typeof slice.source !== "string" || typeof slice.fetchedAt !== "number") return null;
  if (!Number.isFinite(slice.fetchedAt) || !Number.isFinite(slice.burnPctPerHour)) return null;
  if (!Array.isArray(slice.products)) return null;
  for (const key of [
    "windowPct",
    "weekPct",
    "windowResetsAt",
    "weekResetsAt",
    "weekStartedAt",
    "windowDurationMs",
    "weekDurationMs",
    "prepaidBalance",
    "onDemandUsed",
    "onDemandCap",
  ]) {
    if (!nullableFiniteNumber(slice[key])) return null;
  }
  if (slice.planLabel != null && typeof slice.planLabel !== "string") return null;
  return slice as unknown as OfficialSlice;
}

function readClaudeSnapshot(path: string): ClaudeCacheEntry | null {
  const raw = readText(path);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeSnapshotFile>;
    const entry = parsed.version === 1 && parsed.claude && typeof parsed.claude === "object"
      ? parsed.claude as ClaudeCacheEntry
      : null;
    if (!entry) return null;
    for (const value of [
      entry.checkedAt,
      entry.loadedAt,
      entry.nextAllowedAt,
      entry.updatedAt,
    ]) {
      if (!Number.isFinite(value) || value < 0) return null;
    }
    if (!Number.isSafeInteger(entry.failureCount) || entry.failureCount < 0) return null;
    if (typeof entry.lastAttemptFailed !== "boolean") return null;
    const slice = entry.slice == null ? null : officialSliceFromSnapshot(entry.slice);
    if (entry.slice != null && !slice) return null;
    return { ...entry, slice };
  } catch {
    return null;
  }
}

function withoutStaleFlags(slice: OfficialSlice | null): OfficialSlice | null {
  if (!slice) return null;
  const {
    windowStale: _windowStale,
    weekStale: _weekStale,
    modelWeekLimitsStale: _modelWeekLimitsStale,
    ...fresh
  } = slice;
  return fresh;
}

function writeClaudeSnapshot(path: string, entry: ClaudeCacheEntry): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const payload: ClaudeSnapshotFile = {
      version: 1,
      claude: { ...entry, slice: withoutStaleFlags(entry.slice) },
    };
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      return;
    }
  }
}

function newestClaudeEntry(
  memory: ClaudeCacheEntry | undefined,
  persisted: ClaudeCacheEntry | null,
): ClaudeCacheEntry | undefined {
  if (!memory) return persisted ?? undefined;
  if (!persisted) return memory;
  return persisted.updatedAt > memory.updatedAt ? persisted : memory;
}

async function withClaudeSnapshotLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<ClaudeLockResult<T>> {
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return { state: "unavailable" };
  }
  for (let attempt = 0; attempt < 180; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "EEXIST") return { state: "unavailable" };
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch {
        // The owner may have released the lock between stat and unlink.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      return { state: "acquired", value: await action() };
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // A crashed peer may already have cleaned up a stale lock.
      }
    }
  }
  return { state: "busy" };
}

function staleOfficial(slice: OfficialSlice | null): OfficialSlice | null {
  return slice ? {
    ...slice,
    windowStale: slice.windowPct != null,
    weekStale: slice.weekPct != null,
    modelWeekLimitsStale: Boolean(slice.modelWeekLimits),
    quotaPools: quotaPoolsWithStale(slice.quotaPools, true),
  } : null;
}

function readClaudeOfficial(home: string, now: number): OfficialSlice | null {
  const claudePath = join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
  claudeHistoryFileCache = readParsedFile({
    path: claudePath,
    cache: claudeHistoryFileCache,
    parse: (text) => {
      try {
        return parseClaudePlanHistory(JSON.parse(text), now);
      } catch {
        return null;
      }
    },
  });
  return claudeHistoryFileCache?.value ?? null;
}

function readGrokLog(grokHome: string): OfficialSlice | null {
  grokLogFileCache = readJsonlTailFile({
    path: join(grokHome, "logs", "unified.jsonl"),
    cache: grokLogFileCache,
    parseLine: (line) => {
      if (!line.includes("fetched credits config")) return null;
      return parseGrokBillingLogLine(line);
    },
    compact: (values) => collapseOfficialPlateaus(values),
  });
  return grokLogFileCache?.values.at(-1) ?? null;
}

export function readOfficialHistory(opts?: { home?: string; grokHome?: string }): OfficialSlice[] {
  const home = opts?.home ?? homedir();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const out: OfficialSlice[] = [];
  const claudePath = join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
  claudeHistorySlicesCache = readParsedFile({
    path: claudePath,
    cache: claudeHistorySlicesCache,
    parse: (text) => {
      try {
        return slicesFromClaudeHistory(parseClaudeHistoryPoints(JSON.parse(text)));
      } catch {
        return [];
      }
    },
  });
  if (claudeHistorySlicesCache) out.push(...claudeHistorySlicesCache.value);
  grokLogFileCache = readJsonlTailFile({
    path: join(grokHome, "logs", "unified.jsonl"),
    cache: grokLogFileCache,
    parseLine: (line) => {
      if (!line.includes("fetched credits config")) return null;
      return parseGrokBillingLogLine(line);
    },
    compact: (values) => collapseOfficialPlateaus(values),
  });
  if (grokLogFileCache) out.push(...grokLogFileCache.values);
  return out;
}

function readGrokToken(grokHome: string): string | null {
  const raw = readText(join(grokHome, "auth.json"));
  if (!raw) return null;
  try {
    return grokAccessTokenFromAuthFile(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readCodexToken(codexHome: string): { token: string; accountId: string } | null {
  const raw = readText(join(codexHome, "auth.json"));
  if (!raw) return null;
  try {
    return codexAuthFromFile(JSON.parse(raw));
  } catch {
    return null;
  }
}

function mergeClaudeOfficial(
  live: OfficialSlice | null,
  history: OfficialSlice | null,
): OfficialSlice | null {
  if (!live) return history;
  if (!history) return live;
  const useHistoryWindow = Boolean(live.windowStale && history.windowPct != null);
  const useHistoryWeek = Boolean(live.weekStale && history.weekPct != null);
  const useLiveWindow = !useHistoryWindow && live.windowPct != null;
  const useLiveWeek = !useHistoryWeek && live.weekPct != null;
  const liveModelLimits = live.modelWeekLimits != null;
  return {
    agent: history.agent,
    windowPct: useHistoryWindow ? history.windowPct : (live.windowPct ?? history.windowPct),
    weekPct: useHistoryWeek ? history.weekPct : (live.weekPct ?? history.weekPct),
    windowResetsAt: useHistoryWindow
      ? history.windowResetsAt
      : (live.windowResetsAt ?? history.windowResetsAt),
    weekResetsAt: useHistoryWeek
      ? history.weekResetsAt
      : (live.weekResetsAt ?? history.weekResetsAt),
    weekStartedAt: useHistoryWeek
      ? history.weekStartedAt
      : (live.weekStartedAt ?? history.weekStartedAt),
    windowDurationMs: useHistoryWindow
      ? history.windowDurationMs
      : (live.windowDurationMs ?? history.windowDurationMs),
    weekDurationMs: useHistoryWeek
      ? history.weekDurationMs
      : (live.weekDurationMs ?? history.weekDurationMs),
    burnPctPerHour: useHistoryWindow
      ? history.burnPctPerHour
      : (history.burnPctPerHour || live.burnPctPerHour),
    planLabel: live.planLabel ?? history.planLabel,
    products: live.products.length ? live.products : history.products,
    prepaidBalance: live.prepaidBalance ?? history.prepaidBalance,
    onDemandUsed: live.onDemandUsed ?? history.onDemandUsed,
    onDemandCap: live.onDemandCap ?? history.onDemandCap,
    modelWeekLimits: liveModelLimits ? live.modelWeekLimits : history.modelWeekLimits,
    quotaPools: live?.quotaPools
      ? live.quotaPools
      : quotaPoolsWithStale(history?.quotaPools, true),
    windowStale: useHistoryWindow
      ? history.windowStale
      : live.windowPct != null ? live.windowStale : history.windowStale,
    weekStale: useHistoryWeek
      ? history.weekStale
      : live.weekPct != null ? live.weekStale : history.weekStale,
    modelWeekLimitsStale: liveModelLimits
      ? live.modelWeekLimitsStale
      : history.modelWeekLimitsStale,
    source: useHistoryWindow || useHistoryWeek ? history.source : live.source,
    fetchedAt: Math.max(live.fetchedAt, history.fetchedAt),
    windowFetchedAt: useLiveWindow
      ? live.windowFetchedAt ?? live.fetchedAt
      : history.windowFetchedAt ?? history.fetchedAt,
    weekFetchedAt: useLiveWeek
      ? live.weekFetchedAt ?? live.fetchedAt
      : history.weekFetchedAt ?? history.fetchedAt,
    windowKind: live.windowKind,
  };
}

export function claudeOauthAuthFromCredentials(
  raw: unknown,
  now = Date.now(),
): ClaudeOauthAuth | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const nested = root.claudeAiOauth;
  const oauth = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : root;
  const accessToken =
    typeof oauth.accessToken === "string"
      ? oauth.accessToken
      : typeof oauth.access_token === "string"
        ? oauth.access_token
        : "";
  if (!accessToken) return null;
  const expiresCandidate = oauth.expiresAt ?? oauth.expires_at;
  const expiresAt = typeof expiresCandidate === "number" ? expiresCandidate : Number(expiresCandidate);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) return null;
  return { accessToken };
}

export function claudeDesktopManagedPids(raw: string, home: string): number[] {
  const root = join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );
  const pids: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    const command = parsed[2];
    if (!Number.isSafeInteger(pid) || pid <= 0 || !command.startsWith(`${root}/`)) continue;
    const afterRoot = command.slice(root.length + 1);
    const versionEnd = afterRoot.indexOf("/");
    if (versionEnd <= 0) continue;
    const version = afterRoot.slice(0, versionEnd);
    const executable = join(root, version, "claude.app", "Contents", "MacOS", "claude");
    if (command === executable || command.startsWith(`${executable} `)) pids.push(pid);
  }
  return pids.sort((a, b) => b - a).slice(0, 8);
}

export function claudeOauthAuthFromProcessEnvironment(
  raw: string,
): ClaudeOauthAuth | null {
  const accessToken = raw.match(
    /(?:^|\s)CLAUDE_CODE_OAUTH_TOKEN=([^\s]+)/,
  )?.[1];
  return accessToken ? { accessToken } : null;
}

async function readClaudeDesktopManagedAuth(
  home: string,
  execFileImpl: ExecFileText,
): Promise<ClaudeOauthAuth | null> {
  try {
    const processes = await execFileImpl(
      "/bin/ps",
      ["-ww", "-axo", "pid=,command="],
      { encoding: "utf8", timeout: 1500, maxBuffer: 8 * 1024 * 1024 },
    );
    for (const pid of claudeDesktopManagedPids(processes.stdout, home)) {
      try {
        const processEnvironment = await execFileImpl(
          "/bin/ps",
          ["eww", "-p", String(pid)],
          { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024 * 1024 },
        );
        const auth = claudeOauthAuthFromProcessEnvironment(processEnvironment.stdout);
        if (auth) return auth;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function readClaudeOauthAuth(
  home: string,
  now: number,
  opts?: ClaudeAuthDiscoveryOptions,
): Promise<ClaudeOauthAuth | null> {
  const env = opts?.env ?? process.env;
  const directToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (directToken) return { accessToken: directToken };

  const platform = opts?.platform ?? process.platform;
  const currentHome = opts?.currentHome ?? homedir();
  const execFileImpl = opts?.execFileImpl ?? execFileText;
  if (platform === "darwin" && home === currentHome) {
    const managed = await readClaudeDesktopManagedAuth(home, execFileImpl);
    if (managed) return managed;
  }

  const fileRaw = readText(join(home, ".claude", ".credentials.json"));
  if (fileRaw) {
    try {
      const fromFile = claudeOauthAuthFromCredentials(JSON.parse(fileRaw), now);
      if (fromFile) return fromFile;
    } catch {
      // Malformed local credentials fall through to the read-only Keychain lookup.
    }
  }
  if (platform !== "darwin" || home !== currentHome) return null;
  try {
    const result = await execFileImpl(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
      { encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024 },
    );
    return claudeOauthAuthFromCredentials(JSON.parse(result.stdout), now);
  } catch {
    return null;
  }
}

function listRollouts(root: string, out: { path: string; mtimeMs: number }[]): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        out.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  }
}

function readTail(path: string, maxBytes = 80_000): string | null {
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export function readCodexOfficialFromSessions(codexHome: string): OfficialSlice | null {
  const files: { path: string; mtimeMs: number }[] = [];
  listRollouts(join(codexHome, "sessions"), files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(0, 8)) {
    const text = readTail(file.path);
    if (!text) continue;
    const parsed = parseCodexRateLimitLog(text);
    if (parsed) return parsed;
  }
  return null;
}

export async function fetchCodexUsage(
  auth: { token: string; accountId: string },
  opts?: { fetchImpl?: FetchLike; now?: number },
): Promise<OfficialSlice | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(CODEX_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "ChatGPT-Account-Id": auth.accountId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseCodexUsagePayload(body, { fetchedAt: opts?.now ?? Date.now(), source: "wham-usage" });
  } catch {
    return null;
  }
}

export async function fetchGrokBilling(
  token: string,
  opts?: { fetchImpl?: FetchLike; now?: number },
): Promise<OfficialSlice | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(GROK_BILLING_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-grok-client-mode": "cli",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseGrokBillingPayload(body, {
      fetchedAt: opts?.now ?? Date.now(),
      source: "billing-api",
    });
  } catch {
    return null;
  }
}

export function claudeRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const raw = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.max(1000, Math.min(CLAUDE_BACKOFF_MAX_MS, Math.ceil(raw)));
}

function claudeBackoffMs(failureCount: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null) return retryAfterMs;
  const exponent = Math.max(0, Math.min(10, failureCount - 1));
  return Math.min(CLAUDE_BACKOFF_MAX_MS, CLAUDE_BACKOFF_BASE_MS * 2 ** exponent);
}

async function fetchClaudeUsageResult(
  auth: ClaudeOauthAuth,
  opts?: { fetchImpl?: FetchLike; now?: number },
): Promise<ClaudeUsageFetchResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? Date.now();
  try {
    const res = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        slice: null,
        status: res.status,
        retryAfterMs: res.status === 429
          ? claudeRetryAfterMs(res.headers.get("retry-after"), now)
          : null,
      };
    }
    const body: unknown = await res.json();
    return {
      slice: parseClaudeUsagePayload(body, { fetchedAt: now, source: "oauth-usage" }),
      status: res.status,
      retryAfterMs: null,
    };
  } catch {
    return { slice: null, status: null, retryAfterMs: null };
  }
}

export async function fetchClaudeUsage(
  auth: ClaudeOauthAuth,
  opts?: { fetchImpl?: FetchLike; now?: number },
): Promise<OfficialSlice | null> {
  return (await fetchClaudeUsageResult(auth, opts)).slice;
}

function usableClaudeSlice(
  entry: ClaudeCacheEntry | undefined,
  now: number,
): OfficialSlice | null {
  if (!entry?.slice || now - entry.loadedAt > CLAUDE_USAGE_STALE_MS) return null;
  return entry.slice;
}

export async function readOfficialQuota(opts?: {
  home?: string;
  grokHome?: string;
  codexHome?: string;
  now?: number;
  fetchImpl?: FetchLike;
  readClaudeAuth?: ReadClaudeAuth;
  skipCache?: boolean;
  cacheMs?: number;
  snapshotPath?: string;
  statuslineSnapshotPath?: string;
  readAntigravityIdentity?: ReadAntigravityIdentity;
  readAntigravity?: ReadAntigravity;
}): Promise<OfficialQuota> {
  const home = opts?.home ?? homedir();
  const now = opts?.now ?? Date.now();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const codexHome = codexHomeOf(home, opts?.codexHome);
  const claudeHistory = readClaudeOfficial(home, now);
  const log = readGrokLog(grokHome);
  const codexLog = readCodexOfficialFromSessions(codexHome);

  const statuslinePath = opts?.statuslineSnapshotPath
    ?? envPath(process.env.BALANCE_CLAUDE_STATUSLINE_PATH)
    ?? envPath(process.env.SYNQ_CLAUDE_STATUSLINE_PATH)
    ?? claudeStatuslineSnapshotPath(home, process.platform, process.env);
  const statusline = readClaudeStatuslineSnapshot(statuslinePath, now);
  const mergeClaudeSources = (live: OfficialSlice | null): OfficialSlice | null => {
    const liveWithHistory = mergeClaudeOfficial(live, claudeHistory);
    return mergeClaudeStatusline(
      statusline,
      live == null ? null : liveWithHistory,
      live == null ? liveWithHistory : claudeHistory,
    );
  };

  const cacheMs = opts?.cacheMs ?? GROK_BILLING_CACHE_MS;
  const snapshotPath = opts?.snapshotPath ?? resolveClaudeSnapshotPath(home);
  const claudeHit = newestClaudeEntry(
    claudeCache.get(home),
    readClaudeSnapshot(snapshotPath),
  );
  if (claudeHit) claudeCache.set(home, claudeHit);
  const grokHit = !opts?.skipCache ? grokCache.get(grokHome) : undefined;
  const codexHit = !opts?.skipCache ? codexCache.get(codexHome) : undefined;
  const identifyAntigravity = opts?.readAntigravityIdentity ?? antigravitySessionIdentity;
  const readAntigravity = opts?.readAntigravity ?? readAntigravityQuota;
  const currentAntigravityKey = async (): Promise<string | null> => {
    try {
      const identity = await identifyAntigravity({ home });
      return identity ? `${home}\0${identity}` : null;
    } catch {
      return null;
    }
  };
  let antigravityKey = await currentAntigravityKey();
  const previousAntigravityKey = antigravityCacheKeyByHome.get(home);
  if (antigravityKey && previousAntigravityKey && previousAntigravityKey !== antigravityKey) {
    antigravityCache.delete(previousAntigravityKey);
  }
  if (antigravityKey) antigravityCacheKeyByHome.set(home, antigravityKey);
  const antigravityHit = antigravityKey ? antigravityCache.get(antigravityKey) : undefined;
  const claudeFresh = Boolean(
    !opts?.skipCache && claudeHit && now - claudeHit.checkedAt < cacheMs,
  );
  const grokFresh = Boolean(grokHit && now - grokHit.at < cacheMs);
  const codexFresh = Boolean(codexHit && now - codexHit.at < cacheMs);
  const antigravityFresh = Boolean(
    !opts?.skipCache && antigravityHit && now - antigravityHit.checkedAt < cacheMs,
  );
  if (claudeFresh && grokFresh && codexFresh && antigravityFresh) {
    return {
      claude: mergeClaudeSources(
        claudeHit?.lastAttemptFailed
          ? staleOfficial(usableClaudeSlice(claudeHit, now))
          : claudeHit?.slice ?? null,
      ),
      grok: mergeGrokOfficial(grokHit?.slice ?? null, log),
      codex: codexHit?.slice ?? codexLog,
      antigravity: antigravityHit?.lastAttemptFailed
        ? staleOfficial(antigravityHit.slice)
        : antigravityHit?.slice ?? null,
    };
  }

  let claudeLive: OfficialSlice | null = claudeFresh
    ? claudeHit?.lastAttemptFailed
      ? staleOfficial(usableClaudeSlice(claudeHit, now))
      : claudeHit?.slice ?? null
    : null;
  if (!claudeFresh) {
    const observedUpdatedAt = claudeHit?.updatedAt ?? -1;
    const refreshClaude = async (
      base: ClaudeCacheEntry | undefined,
      persist: boolean,
    ): Promise<OfficialSlice | null> => {
      if (base && now < base.nextAllowedAt) {
        const stale = usableClaudeSlice(base, now);
        claudeCache.set(home, {
          ...base,
          checkedAt: now,
          loadedAt: stale ? base.loadedAt : 0,
          slice: stale,
        });
        return staleOfficial(stale);
      }
      const readAuth = opts?.readClaudeAuth ?? readClaudeOauthAuth;
      const auth = await readAuth(home, now);
      if (!auth) {
        const stale = usableClaudeSlice(base, now);
        if (base) {
          claudeCache.set(home, {
            ...base,
            checkedAt: now,
            loadedAt: stale ? base.loadedAt : 0,
            slice: stale,
          });
        }
        return staleOfficial(stale);
      }
      const result = await fetchClaudeUsageResult(auth, { fetchImpl: opts?.fetchImpl, now });
      if (result.slice) {
        const entry: ClaudeCacheEntry = {
          checkedAt: now,
          loadedAt: now,
          slice: result.slice,
          failureCount: 0,
          nextAllowedAt: 0,
          updatedAt: now,
          lastAttemptFailed: false,
        };
        claudeCache.set(home, entry);
        if (persist) writeClaudeSnapshot(snapshotPath, entry);
        return result.slice;
      }
      const stale = usableClaudeSlice(base, now);
      const failureCount = (base?.failureCount ?? 0) + 1;
      const entry: ClaudeCacheEntry = {
        checkedAt: now,
        loadedAt: stale ? (base?.loadedAt ?? 0) : 0,
        slice: stale,
        failureCount,
        nextAllowedAt: now + claudeBackoffMs(failureCount, result.retryAfterMs),
        updatedAt: now,
        lastAttemptFailed: true,
      };
      claudeCache.set(home, entry);
      if (persist) writeClaudeSnapshot(snapshotPath, entry);
      return staleOfficial(stale);
    };

    const locked = await withClaudeSnapshotLock(snapshotPath, async () => {
      const lockedHit = newestClaudeEntry(
        claudeCache.get(home),
        readClaudeSnapshot(snapshotPath),
      );
      if (
        lockedHit
        && lockedHit.updatedAt > observedUpdatedAt
        && now - lockedHit.checkedAt < cacheMs
      ) {
        claudeCache.set(home, lockedHit);
        return lockedHit.lastAttemptFailed
          ? staleOfficial(usableClaudeSlice(lockedHit, now))
          : lockedHit.slice;
      }
      return refreshClaude(lockedHit, true);
    });
    if (locked.state === "acquired") {
      claudeLive = locked.value;
    } else if (locked.state === "busy") {
      const latest = newestClaudeEntry(
        claudeCache.get(home),
        readClaudeSnapshot(snapshotPath),
      );
      if (latest) claudeCache.set(home, latest);
      claudeLive = staleOfficial(usableClaudeSlice(latest, now));
    } else {
      claudeLive = await refreshClaude(claudeHit, false);
    }
  }

  let grokLive: OfficialSlice | null = grokFresh ? (grokHit?.slice ?? null) : null;
  if (!grokFresh) {
    const token = readGrokToken(grokHome);
    if (token) grokLive = await fetchGrokBilling(token, { fetchImpl: opts?.fetchImpl, now });
    grokCache.set(grokHome, { at: now, slice: grokLive });
  }

  let codexLive: OfficialSlice | null = codexFresh ? (codexHit?.slice ?? null) : null;
  if (!codexFresh) {
    const auth = readCodexToken(codexHome);
    if (auth) codexLive = await fetchCodexUsage(auth, { fetchImpl: opts?.fetchImpl, now });
    codexCache.set(codexHome, { at: now, slice: codexLive });
  }

  let antigravityLive: OfficialSlice | null = antigravityFresh
    ? antigravityHit?.lastAttemptFailed
      ? staleOfficial(antigravityHit.slice)
      : antigravityHit?.slice ?? null
    : null;
  if (!antigravityFresh) {
    let fetched: OfficialSlice | null = null;
    try {
      fetched = await readAntigravity({ home, fetchImpl: opts?.fetchImpl, now });
    } catch {
      fetched = null;
    }
    const keyAfterRefresh = await currentAntigravityKey();
    if (!antigravityKey || keyAfterRefresh !== antigravityKey) {
      if (antigravityKey) antigravityCache.delete(antigravityKey);
      if (keyAfterRefresh) {
        antigravityCacheKeyByHome.set(home, keyAfterRefresh);
      } else if (antigravityCacheKeyByHome.get(home) === antigravityKey) {
        antigravityCacheKeyByHome.delete(home);
      }
      antigravityKey = keyAfterRefresh;
      antigravityLive = null;
    } else if (fetched) {
      antigravityCache.set(antigravityKey, {
        checkedAt: now,
        loadedAt: now,
        slice: fetched,
        lastAttemptFailed: false,
      });
      antigravityLive = fetched;
    } else {
      antigravityLive = staleOfficial(antigravityHit?.slice ?? null);
      if (antigravityHit) {
        antigravityCache.set(antigravityKey, {
          ...antigravityHit,
          checkedAt: now,
          lastAttemptFailed: true,
        });
      }
    }
  }

  return {
    claude: mergeClaudeSources(claudeLive),
    grok: mergeGrokOfficial(grokLive, log),
    codex: codexLive ?? codexLog,
    antigravity: antigravityLive,
  };
}

export function officialFilesMtime(home = homedir(), grokHome?: string, codexHome?: string): number {
  const paths = [
    join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"),
    join(home, ".claude", ".credentials.json"),
    join(grokHomeOf(home, grokHome), "logs", "unified.jsonl"),
    join(grokHomeOf(home, grokHome), "auth.json"),
    join(codexHomeOf(home, codexHome), "auth.json"),
    join(home, ".gemini", "jetski-standalone-oauth-token"),
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "oauth_creds.json"),
  ];
  let m = 0;
  for (const p of paths) {
    try {
      m = Math.max(m, statSync(p).mtimeMs);
    } catch {
      /* missing */
    }
  }
  return m;
}

export function clearOfficialCache(): void {
  claudeCache.clear();
  grokCache.clear();
  codexCache.clear();
  antigravityCache.clear();
  antigravityCacheKeyByHome.clear();
  claudeHistoryFileCache = null;
  claudeHistorySlicesCache = null;
  grokLogFileCache = null;
}

const CLAUDE_STATUSLINE_STALE_MS = 15 * 60_000;

// 与 collector 的 envPath 逐字同语义：空串/纯空白环境变量视为未设置。
function envPath(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

export function claudeStatuslineSnapshotPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Balance", "claude-statusline.json");
  }
  if (platform === "win32") {
    return join(
      envPath(env.LOCALAPPDATA) ?? join(home, "AppData", "Local"),
      "Balance",
      "claude-statusline.json",
    );
  }
  return join(
    envPath(env.XDG_STATE_HOME) ?? join(home, ".local", "state"),
    "balance",
    "claude-statusline.json",
  );
}

export function readClaudeStatuslineSnapshot(path: string, now = Date.now()): OfficialSlice | null {
  const text = readText(path);
  if (!text) return null;
  try {
    const stored = JSON.parse(text) as { fetchedAt?: unknown; rate_limits?: unknown };
    const fetchedAt = Number(stored.fetchedAt);
    if (
      !Number.isFinite(fetchedAt)
      || fetchedAt > now + 5_000
      || now - fetchedAt > CLAUDE_STATUSLINE_STALE_MS
    ) return null;
    return parseClaudeStatuslinePayload({ rate_limits: stored.rate_limits }, {
      fetchedAt,
      source: "claude-statusline",
    });
  } catch {
    return null;
  }
}

export function mergeClaudeStatusline(
  statusline: OfficialSlice | null,
  oauth: OfficialSlice | null,
  fallback: OfficialSlice | null,
): OfficialSlice | null {
  const statusWindow = statusline?.windowPct != null
    && Number.isFinite(statusline.windowPct)
    && statusline.windowResetsAt != null
    && Number.isFinite(statusline.windowResetsAt);
  const statusWeek = statusline?.weekPct != null
    && Number.isFinite(statusline.weekPct)
    && statusline.weekResetsAt != null
    && Number.isFinite(statusline.weekResetsAt);
  const nonStatuslineBase = oauth ?? fallback;
  if (!nonStatuslineBase && !statusWindow && !statusWeek) return null;
  // oauth != null 时 base === oauth；否则 base === fallback。尾部 `...base` 已原样
  // 带上 products/quotaPools/modelWeekLimits/modelWeekLimitsStale/prepaid/onDemand
  // 及其 stale 位，返回对象里绝不能再对这些字段做显式二次覆盖——那会把 429/backoff
  // 下 staleOfficial 标好的 modelWeekLimitsStale:true 无条件翻回 false，打红
  // official.server.test.ts:482（"Claude last-success snapshot survives cache reset"）。
  // 仅当两个来源都为空、base 是 statusline 合成体时才显式给空值。
  const base: OfficialSlice = nonStatuslineBase ?? {
    ...statusline!,
    windowPct: null,
    weekPct: null,
    windowResetsAt: null,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: null,
    weekDurationMs: null,
    windowStale: true,
    weekStale: true,
    products: [],
    quotaPools: undefined,
    modelWeekLimits: undefined,
    modelWeekLimitsStale: undefined,
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
  };
  const baseWindowFetchedAt = base.windowFetchedAt ?? base.fetchedAt;
  const baseWeekFetchedAt = base.weekFetchedAt ?? base.fetchedAt;
  const statusWindowFetchedAt = statusline?.windowFetchedAt ?? statusline?.fetchedAt ?? -1;
  const statusWeekFetchedAt = statusline?.weekFetchedAt ?? statusline?.fetchedAt ?? -1;
  const useStatusWindow = Boolean(
    statusWindow
    && (base.windowPct == null || statusWindowFetchedAt >= baseWindowFetchedAt),
  );
  const useStatusWeek = Boolean(
    statusWeek
    && (base.weekPct == null || statusWeekFetchedAt >= baseWeekFetchedAt),
  );
  const windowFetchedAt = useStatusWindow ? statusWindowFetchedAt : baseWindowFetchedAt;
  const weekFetchedAt = useStatusWeek ? statusWeekFetchedAt : baseWeekFetchedAt;
  const usesStatusline = useStatusWindow || useStatusWeek;
  return {
    ...base,
    windowPct: useStatusWindow ? statusline!.windowPct : base.windowPct,
    weekPct: useStatusWeek ? statusline!.weekPct : base.weekPct,
    windowResetsAt: useStatusWindow ? statusline!.windowResetsAt : base.windowResetsAt,
    weekResetsAt: useStatusWeek ? statusline!.weekResetsAt : base.weekResetsAt,
    weekStartedAt: useStatusWeek ? statusline!.weekStartedAt : base.weekStartedAt,
    windowDurationMs: useStatusWindow ? statusline!.windowDurationMs : base.windowDurationMs,
    weekDurationMs: useStatusWeek ? statusline!.weekDurationMs : base.weekDurationMs,
    windowKind: useStatusWindow ? statusline!.windowKind : base.windowKind,
    windowFetchedAt,
    weekFetchedAt,
    fetchedAt: Math.max(windowFetchedAt, weekFetchedAt),
    source: usesStatusline
      ? oauth
        ? "claude-statusline+oauth"
        : "claude-statusline"
      : base.source,
    windowStale: useStatusWindow ? false : base.windowStale,
    weekStale: useStatusWeek ? false : base.weekStale,
  };
}
