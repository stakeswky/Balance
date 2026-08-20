import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  codexAuthFromFile,
  grokAccessTokenFromAuthFile,
  mergeGrokOfficial,
  parseClaudeHistoryPoints,
  parseClaudePlanHistory,
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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

export async function readOfficialQuota(opts?: {
  home?: string;
  grokHome?: string;
  codexHome?: string;
  now?: number;
  fetchImpl?: FetchLike;
  skipCache?: boolean;
  cacheMs?: number;
}): Promise<OfficialQuota> {
  const home = opts?.home ?? homedir();
  const now = opts?.now ?? Date.now();
  const grokHome = grokHomeOf(home, opts?.grokHome);
  const codexHome = codexHomeOf(home, opts?.codexHome);
  const claude = readClaudeOfficial(home, now);
  const log = readGrokLog(grokHome);
  const codexLog = readCodexOfficialFromSessions(codexHome);

  const cacheMs = opts?.cacheMs ?? GROK_BILLING_CACHE_MS;
  const grokHit = !opts?.skipCache ? grokCache.get(grokHome) : undefined;
  const codexHit = !opts?.skipCache ? codexCache.get(codexHome) : undefined;
  const grokFresh = grokHit && now - grokHit.at < cacheMs;
  const codexFresh = codexHit && now - codexHit.at < cacheMs;
  if (grokFresh && codexFresh) {
    return {
      claude,
      grok: mergeGrokOfficial(grokHit.slice, log),
      codex: codexHit.slice ?? codexLog,
    };
  }

  let grokLive: OfficialSlice | null = grokFresh ? grokHit.slice : null;
  if (!grokFresh) {
    const token = readGrokToken(grokHome);
    if (token) grokLive = await fetchGrokBilling(token, { fetchImpl: opts?.fetchImpl, now });
    grokCache.set(grokHome, { at: now, slice: grokLive });
  }

  let codexLive: OfficialSlice | null = codexFresh ? (codexHit.slice ?? null) : null;
  if (!codexFresh) {
    const auth = readCodexToken(codexHome);
    if (auth) codexLive = await fetchCodexUsage(auth, { fetchImpl: opts?.fetchImpl, now });
    codexCache.set(codexHome, { at: now, slice: codexLive });
  }

  return {
    claude,
    grok: mergeGrokOfficial(grokLive, log),
    codex: codexLive ?? codexLog,
  };
}

export function officialFilesMtime(home = homedir(), grokHome?: string, codexHome?: string): number {
  const paths = [
    join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"),
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
  grokCache.clear();
  codexCache.clear();
}
