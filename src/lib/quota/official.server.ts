import { execFile } from "node:child_process";
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  codexAuthFromFile,
  grokAccessTokenFromAuthFile,
  mergeGrokOfficial,
  parseClaudeHistoryPoints,
  parseClaudePlanHistory,
  parseClaudeUsagePayload,
  parseCodexRateLimitLog,
  parseCodexUsagePayload,
  parseGrokBillingLog,
  parseGrokBillingLogAll,
  parseGrokBillingPayload,
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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ReadClaudeAuth = (home: string, now: number) => Promise<ClaudeOauthAuth | null>;
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

function readClaudeOfficial(home: string, now: number): OfficialSlice | null {
  const claudePath = join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
  const claudeRaw = readText(claudePath);
  if (!claudeRaw) return null;
  try {
    return parseClaudePlanHistory(JSON.parse(claudeRaw), now);
  } catch {
    return null;
  }
}

function readGrokLog(grokHome: string): OfficialSlice | null {
  const grokRaw = readText(join(grokHome, "logs", "unified.jsonl"));
  return grokRaw ? parseGrokBillingLog(grokRaw) : null;
}

export function readOfficialHistory(opts?: { home?: string; grokHome?: string }): OfficialSlice[] {
  const home = opts?.home ?? homedir();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const out: OfficialSlice[] = [];
  const claudeRaw = readText(join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"));
  if (claudeRaw) {
    try {
      out.push(...slicesFromClaudeHistory(parseClaudeHistoryPoints(JSON.parse(claudeRaw))));
    } catch {
      /* ignore malformed history */
    }
  }
  const grokRaw = readText(join(grokHome, "logs", "unified.jsonl"));
  if (grokRaw) out.push(...parseGrokBillingLogAll(grokRaw));
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
  return {
    agent: history.agent,
    windowPct: live.windowPct ?? history.windowPct,
    weekPct: live.weekPct ?? history.weekPct,
    windowResetsAt: live.windowResetsAt ?? history.windowResetsAt,
    weekResetsAt: live.weekResetsAt ?? history.weekResetsAt,
    weekStartedAt: live.weekStartedAt ?? history.weekStartedAt,
    windowDurationMs: live.windowDurationMs ?? history.windowDurationMs,
    weekDurationMs: live.weekDurationMs ?? history.weekDurationMs,
    burnPctPerHour: history.burnPctPerHour || live.burnPctPerHour,
    planLabel: live.planLabel ?? history.planLabel,
    products: live.products.length ? live.products : history.products,
    prepaidBalance: live.prepaidBalance ?? history.prepaidBalance,
    onDemandUsed: live.onDemandUsed ?? history.onDemandUsed,
    onDemandCap: live.onDemandCap ?? history.onDemandCap,
    modelWeekLimits: live.modelWeekLimits ?? history.modelWeekLimits,
    source: live.source,
    fetchedAt: Math.max(live.fetchedAt, history.fetchedAt),
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

export async function readOfficialQuota(opts?: {
  home?: string;
  grokHome?: string;
  codexHome?: string;
  now?: number;
  fetchImpl?: FetchLike;
  readClaudeAuth?: ReadClaudeAuth;
  skipCache?: boolean;
  cacheMs?: number;
}): Promise<OfficialQuota> {
  const home = opts?.home ?? homedir();
  const now = opts?.now ?? Date.now();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const codexHome = codexHomeOf(home, opts?.codexHome);
  const claudeHistory = readClaudeOfficial(home, now);
  const log = readGrokLog(grokHome);
  const codexLog = readCodexOfficialFromSessions(codexHome);

  const cacheMs = opts?.cacheMs ?? GROK_BILLING_CACHE_MS;
  const claudeHit = claudeCache.get(home);
  const grokHit = !opts?.skipCache ? grokCache.get(grokHome) : undefined;
  const codexHit = !opts?.skipCache ? codexCache.get(codexHome) : undefined;
  const claudeFresh = Boolean(
    !opts?.skipCache && claudeHit && now - claudeHit.checkedAt < cacheMs,
  );
  const grokFresh = Boolean(grokHit && now - grokHit.at < cacheMs);
  const codexFresh = Boolean(codexHit && now - codexHit.at < cacheMs);
  if (claudeFresh && grokFresh && codexFresh) {
    return {
      claude: mergeClaudeOfficial(claudeHit?.slice ?? null, claudeHistory),
      grok: mergeGrokOfficial(grokHit?.slice ?? null, log),
      codex: codexHit?.slice ?? codexLog,
    };
  }

  let claudeLive: OfficialSlice | null = claudeFresh ? (claudeHit?.slice ?? null) : null;
  if (!claudeFresh) {
    if (claudeHit && now < claudeHit.nextAllowedAt) {
      const stale = now - claudeHit.loadedAt <= CLAUDE_USAGE_STALE_MS
        ? claudeHit.slice
        : null;
      claudeLive = stale;
      claudeCache.set(home, {
        ...claudeHit,
        checkedAt: now,
        loadedAt: stale ? claudeHit.loadedAt : 0,
        slice: stale,
      });
    } else {
      const readAuth = opts?.readClaudeAuth ?? readClaudeOauthAuth;
      const auth = await readAuth(home, now);
      const result = auth
        ? await fetchClaudeUsageResult(auth, { fetchImpl: opts?.fetchImpl, now })
        : { slice: null, status: null, retryAfterMs: null };
      if (result.slice) {
        claudeLive = result.slice;
        claudeCache.set(home, {
          checkedAt: now,
          loadedAt: now,
          slice: result.slice,
          failureCount: 0,
          nextAllowedAt: 0,
          updatedAt: now,
          lastAttemptFailed: false,
        });
      } else {
        const stale = claudeHit && now - claudeHit.loadedAt <= CLAUDE_USAGE_STALE_MS
          ? claudeHit.slice
          : null;
        const failureCount = auth ? (claudeHit?.failureCount ?? 0) + 1 : 0;
        claudeLive = stale;
        claudeCache.set(home, {
          checkedAt: now,
          loadedAt: stale ? (claudeHit?.loadedAt ?? 0) : 0,
          slice: stale,
          failureCount,
          nextAllowedAt: auth
            ? now + claudeBackoffMs(failureCount, result.retryAfterMs)
            : 0,
          updatedAt: now,
          lastAttemptFailed: Boolean(auth),
        });
      }
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

  return {
    claude: mergeClaudeOfficial(claudeLive, claudeHistory),
    grok: mergeGrokOfficial(grokLive, log),
    codex: codexLive ?? codexLog,
  };
}

export function officialFilesMtime(home = homedir(), grokHome?: string, codexHome?: string): number {
  const paths = [
    join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"),
    join(home, ".claude", ".credentials.json"),
    join(grokHomeOf(home, grokHome), "logs", "unified.jsonl"),
    join(grokHomeOf(home, grokHome), "auth.json"),
    join(codexHomeOf(home, codexHome), "auth.json"),
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
}
