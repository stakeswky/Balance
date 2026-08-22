import type { ModelId } from "./types.ts";

export interface OfficialProductShare {
  product: string;
  usagePercent: number | null;
}

export interface OfficialModelWeekLimit {
  usedPct: number;
  resetsAt: number | null;
}

export type OfficialModelWeekLimits = Partial<Record<ModelId, OfficialModelWeekLimit>>;

export interface OfficialQuotaPool {
  id: string;
  kind: "model-week" | "extra-usage" | "product-share";
  usagePercent: number | null;
  startsAt: number | null;
  resetsAt: number | null;
  durationMs: number | null;
  models: ModelId[];
  exactUsedUsd: number | null;
  exactLimitUsd: number | null;
  fetchedAt: number;
  stale?: boolean;
}

export interface OfficialSlice {
  agent: "claude" | "grok" | "codex";
  windowPct: number | null;
  weekPct: number | null;
  windowResetsAt: number | null;
  weekResetsAt: number | null;
  weekStartedAt: number | null;
  windowDurationMs: number | null;
  weekDurationMs: number | null;
  burnPctPerHour: number;
  planLabel: string | null;
  products: OfficialProductShare[];
  prepaidBalance: number | null;
  onDemandUsed: number | null;
  onDemandCap: number | null;
  modelWeekLimits?: OfficialModelWeekLimits;
  quotaPools?: OfficialQuotaPool[];
  weekPeriodKind?: "weekly" | "monthly";
  windowStale?: boolean;
  weekStale?: boolean;
  modelWeekLimitsStale?: boolean;
  source: string;
  fetchedAt: number;
  windowFetchedAt?: number;
  weekFetchedAt?: number;
  windowKind: "five_hour" | "weekly";
}

export interface OfficialQuota {
  claude: OfficialSlice | null;
  grok: OfficialSlice | null;
  codex: OfficialSlice | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export interface ClaudeHistoryPoint {
  t: number;
  fh: number;
  sd: number;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function timestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v >= 1_000_000_000_000 ? v : v * 1000;
  }
  if (typeof v !== "string" || !v) return null;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function claudeWindow(
  raw: unknown,
  percentKey: "utilization" | "percent",
): { usedPct: number; resetsAt: number | null } | null {
  const value = record(raw);
  const candidate = value ? value[percentKey] : raw;
  if (
    candidate == null
    || candidate === ""
    || (typeof candidate !== "number" && typeof candidate !== "string")
  ) return null;
  const usedPct = typeof candidate === "number" ? candidate : Number(candidate);
  if (!Number.isFinite(usedPct)) return null;
  return {
    usedPct: clampPct(usedPct),
    resetsAt: value ? timestampMs(value.resets_at) : null,
  };
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function nullableNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function claudeModelPool(
  root: Record<string, unknown>,
  field: "seven_day_sonnet" | "seven_day_opus",
  model: ModelId,
  fetchedAt: number,
): OfficialQuotaPool | null {
  const parsed = claudeWindow(root[field], "utilization");
  if (!parsed) return null;
  return {
    id: field,
    kind: "model-week",
    usagePercent: parsed.usedPct,
    startsAt: parsed.resetsAt == null ? null : parsed.resetsAt - WEEK_MS,
    resetsAt: parsed.resetsAt,
    durationMs: WEEK_MS,
    models: [model],
    exactUsedUsd: null,
    exactLimitUsd: null,
    fetchedAt,
    stale: false,
  };
}

function claudeExtraUsage(
  root: Record<string, unknown>,
  fetchedAt: number,
): OfficialQuotaPool | null {
  const extra = record(root.extra_usage);
  if (!extra || extra.is_enabled === false) return null;
  const used = nullableNumber(extra.used_credits);
  const limit = nullableNumber(extra.monthly_limit);
  const utilization = nullableNumber(extra.utilization);
  if (used == null && limit == null && utilization == null) return null;
  return {
    id: "extra_usage",
    kind: "extra-usage",
    usagePercent: utilization == null ? null : clampPct(utilization),
    startsAt: null,
    resetsAt: timestampMs(extra.resets_at),
    durationMs: null,
    models: [],
    exactUsedUsd: used,
    exactLimitUsd: limit,
    fetchedAt,
    stale: false,
  };
}

export function quotaPoolsWithStale(
  pools: OfficialQuotaPool[] | undefined,
  stale: boolean,
): OfficialQuotaPool[] | undefined {
  return pools?.map((pool) => ({ ...pool, stale }));
}

function claudeLimit(
  root: Record<string, unknown>,
  kind: "session" | "weekly_all",
): { usedPct: number; resetsAt: number | null } | null {
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const limit = record(item);
    if (!limit || limit.kind !== kind) continue;
    const parsed = claudeWindow(limit, "percent");
    if (parsed) return parsed;
  }
  return null;
}

function fableLimit(root: Record<string, unknown>): OfficialModelWeekLimit | null {
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const limit = record(item);
    if (!limit || limit.kind !== "weekly_scoped") continue;
    const scope = record(limit.scope);
    const model = record(scope?.model);
    const displayName = typeof model?.display_name === "string" ? model.display_name.toLowerCase() : "";
    if (displayName !== "fable" && displayName !== "fable 5") continue;
    const parsed = claudeWindow(limit, "percent");
    if (parsed) return parsed;
  }
  return claudeWindow(root.seven_day_overage_included, "utilization");
}

export function parseClaudeUsagePayload(
  raw: unknown,
  opts?: { fetchedAt?: number; source?: string },
): OfficialSlice | null {
  const root = record(raw);
  if (!root) return null;
  const fiveHour = claudeLimit(root, "session") ?? claudeWindow(root.five_hour, "utilization");
  const sevenDay = claudeLimit(root, "weekly_all") ?? claudeWindow(root.seven_day, "utilization");
  const fable = fableLimit(root);
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  const sonnetPool = claudeModelPool(root, "seven_day_sonnet", "sonnet", fetchedAt);
  const opusPool = claudeModelPool(root, "seven_day_opus", "opus", fetchedAt);
  const extraUsage = claudeExtraUsage(root, fetchedAt);
  const fablePool: OfficialQuotaPool | null = fable
    ? {
        id: "seven_day_fable",
        kind: "model-week",
        usagePercent: fable.usedPct,
        startsAt: fable.resetsAt == null ? null : fable.resetsAt - WEEK_MS,
        resetsAt: fable.resetsAt,
        durationMs: WEEK_MS,
        models: ["fable"],
        exactUsedUsd: null,
        exactLimitUsd: null,
        fetchedAt,
        stale: false,
      }
    : null;
  const quotaPools = [fablePool, sonnetPool, opusPool, extraUsage].filter(
    (pool): pool is OfficialQuotaPool => pool != null,
  );
  if (!fiveHour && !sevenDay && quotaPools.length === 0) return null;
  const weekResetsAt = sevenDay?.resetsAt
    ?? fable?.resetsAt
    ?? sonnetPool?.resetsAt
    ?? opusPool?.resetsAt
    ?? null;
  const modelWeekLimitEntries: OfficialModelWeekLimits = {
    ...(fable ? { fable } : {}),
    ...(sonnetPool?.usagePercent != null
      ? { sonnet: { usedPct: sonnetPool.usagePercent, resetsAt: sonnetPool.resetsAt } }
      : {}),
    ...(opusPool?.usagePercent != null
      ? { opus: { usedPct: opusPool.usagePercent, resetsAt: opusPool.resetsAt } }
      : {}),
  };
  return {
    agent: "claude",
    windowPct: fiveHour?.usedPct ?? null,
    weekPct: sevenDay?.usedPct ?? null,
    windowResetsAt: fiveHour?.resetsAt ?? null,
    weekResetsAt,
    weekStartedAt: weekResetsAt == null ? null : weekResetsAt - WEEK_MS,
    windowDurationMs: FIVE_HOUR_MS,
    weekDurationMs: WEEK_MS,
    burnPctPerHour: 0,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    modelWeekLimits: Object.keys(modelWeekLimitEntries).length
      ? modelWeekLimitEntries
      : undefined,
    quotaPools,
    source: opts?.source ?? "oauth-usage",
    fetchedAt,
    windowKind: "five_hour",
  };
}

export function parseClaudeHistoryPoints(raw: unknown): ClaudeHistoryPoint[] {
  if (!raw || typeof raw !== "object") return [];
  const samples = (raw as { samples?: unknown }).samples;
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const parsed: ClaudeHistoryPoint[] = [];
  for (const s of samples) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const t = num(o.t);
    const u = o.u && typeof o.u === "object" ? (o.u as Record<string, unknown>) : {};
    if (!t) continue;
    parsed.push({ t, fh: clampPct(num(u.fh)), sd: clampPct(num(u.sd)) });
  }
  parsed.sort((a, b) => a.t - b.t);
  return parsed;
}

export function slicesFromClaudeHistory(points: ClaudeHistoryPoint[]): OfficialSlice[] {
  const out: OfficialSlice[] = [];
  let fiveStartedAt: number | null = null;
  let weekStartedAt: number | null = null;
  let anchored = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = i > 0 ? points[i - 1]! : null;
    if (prev && p.fh <= 1 && p.fh < prev.fh) fiveStartedAt = p.t;
    if (prev && p.sd <= 1 && p.sd < prev.sd) weekStartedAt = p.t;
    if (fiveStartedAt != null && p.t > fiveStartedAt + FIVE_HOUR_MS + 60_000) {
      fiveStartedAt = null;
    }
    if (weekStartedAt != null) {
      while (p.t > weekStartedAt + WEEK_MS + 60_000) weekStartedAt += WEEK_MS;
    }
    if (fiveStartedAt != null || weekStartedAt != null) anchored = true;
    if (!anchored) continue;
    const slice: OfficialSlice = {
      agent: "claude",
      windowPct: p.fh,
      weekPct: p.sd,
      windowResetsAt: fiveStartedAt == null ? null : fiveStartedAt + FIVE_HOUR_MS,
      weekResetsAt: weekStartedAt == null ? null : weekStartedAt + WEEK_MS,
      weekStartedAt,
      windowDurationMs: FIVE_HOUR_MS,
      weekDurationMs: WEEK_MS,
      burnPctPerHour: 0,
      planLabel: null,
      products: [],
      prepaidBalance: null,
      onDemandUsed: null,
      onDemandCap: null,
      source: "plan-usage-history",
      fetchedAt: p.t,
      windowKind: "five_hour",
    };
    const last = out.at(-1);
    const samePlateau = Boolean(
      last
        && last.windowResetsAt === slice.windowResetsAt
        && last.weekResetsAt === slice.weekResetsAt
        && last.windowPct === slice.windowPct
        && last.weekPct === slice.weekPct,
    );
    if (samePlateau) out[out.length - 1] = slice;
    else out.push(slice);
  }
  return out;
}

export function parseClaudePlanHistory(
  raw: unknown,
  now = Date.now(),
): OfficialSlice | null {
  const parsed = parseClaudeHistoryPoints(raw);
  if (!parsed.length) return null;
  const last = parsed[parsed.length - 1]!;
  const latestAnchored = slicesFromClaudeHistory(parsed).at(-1) ?? null;
  const from = now - 90 * 60 * 1000;
  const recent = parsed.filter((s) => s.t >= from);
  let burn = 0;
  if (recent.length >= 2) {
    const a = recent[0]!;
    const b = recent[recent.length - 1]!;
    const dtH = (b.t - a.t) / 3_600_000;
    if (dtH > 0.05) {
      const delta = b.fh >= a.fh ? b.fh - a.fh : b.fh; // reset: treat as rise from 0
      burn = delta / dtH;
    }
  }
  return {
    agent: "claude",
    windowPct: last.fh,
    weekPct: last.sd,
    windowResetsAt: latestAnchored?.windowResetsAt ?? null,
    weekResetsAt: latestAnchored?.weekResetsAt ?? null,
    weekStartedAt: latestAnchored?.weekStartedAt ?? null,
    windowDurationMs: 5 * 60 * 60 * 1000,
    weekDurationMs: 7 * 24 * 60 * 60 * 1000,
    burnPctPerHour: burn,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: "plan-usage-history",
    fetchedAt: last.t,
    windowKind: "five_hour",
  };
}

function unwrapVal(v: unknown): number {
  if (v && typeof v === "object" && "val" in (v as object)) return num((v as { val: unknown }).val);
  return num(v);
}

function parseGrokProducts(cfg: Record<string, unknown>): OfficialProductShare[] {
  const raw = cfg.productUsage;
  if (!Array.isArray(raw)) return [];
  const out: OfficialProductShare[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const product = String(o.product ?? "");
    if (!product) continue;
    out.push({
      product,
      usagePercent: o.usagePercent == null ? null : clampPct(num(o.usagePercent)),
    });
  }
  return out;
}

export function parseGrokBillingPayload(
  raw: unknown,
  opts?: { fetchedAt?: number; source?: string; planLabel?: string | null },
): OfficialSlice | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const cfg = (root.config && typeof root.config === "object" ? root.config : root) as Record<string, unknown>;
  if (cfg.creditUsagePercent == null && cfg.currentPeriod == null && !cfg.billingPeriodEnd) return null;
  const period = (cfg.currentPeriod && typeof cfg.currentPeriod === "object"
    ? cfg.currentPeriod
    : {}) as Record<string, unknown>;
  const weekPct = cfg.creditUsagePercent == null ? null : clampPct(num(cfg.creditUsagePercent));
  const end = period.end ? Date.parse(String(period.end)) : Date.parse(String(cfg.billingPeriodEnd ?? ""));
  const start = period.start ? Date.parse(String(period.start)) : Date.parse(String(cfg.billingPeriodStart ?? ""));
  const tier =
    opts?.planLabel ??
    (root.subscriptionTier != null
      ? String(root.subscriptionTier)
      : cfg.subscription_tier != null
        ? String(cfg.subscription_tier)
        : null);
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? end - start
    : null;
  const weekPeriodKind = durationMs != null && durationMs > 8 * 24 * 60 * 60_000
    ? "monthly"
    : "weekly";
  return {
    agent: "grok",
    windowPct: null,
    weekPct,
    windowResetsAt: null,
    weekResetsAt: Number.isFinite(end) ? end : null,
    weekStartedAt: Number.isFinite(start) ? start : null,
    windowDurationMs: null,
    weekDurationMs: durationMs,
    weekPeriodKind,
    burnPctPerHour: 0,
    planLabel: tier,
    products: parseGrokProducts(cfg),
    prepaidBalance: cfg.prepaidBalance == null ? null : unwrapVal(cfg.prepaidBalance),
    onDemandUsed: cfg.onDemandUsed == null ? null : unwrapVal(cfg.onDemandUsed),
    onDemandCap: cfg.onDemandCap == null ? null : unwrapVal(cfg.onDemandCap),
    source: opts?.source ?? "billing-api",
    fetchedAt: opts?.fetchedAt ?? Date.now(),
    windowKind: "weekly",
  };
}

export function parseGrokBillingLogLine(line: string): OfficialSlice | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.msg !== "billing: fetched credits config") return null;
  const ctx = (o.ctx && typeof o.ctx === "object" ? o.ctx : {}) as Record<string, unknown>;
  const ts = o.ts ? Date.parse(String(o.ts)) : Date.now();
  return parseGrokBillingPayload(
    { config: ctx.config, subscriptionTier: ctx.subscriptionTier },
    { fetchedAt: Number.isFinite(ts) ? ts : Date.now(), source: "unified-billing-log" },
  );
}

export function parseGrokBillingLogAll(text: string): OfficialSlice[] {
  const out: OfficialSlice[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("fetched credits config")) continue;
    const parsed = parseGrokBillingLogLine(line);
    if (!parsed || parsed.weekPct == null) continue;
    const last = out.at(-1);
    if (
      last &&
      last.weekStartedAt === parsed.weekStartedAt &&
      last.weekResetsAt === parsed.weekResetsAt &&
      Math.floor(last.weekPct ?? -1) === Math.floor(parsed.weekPct)
    ) {
      out[out.length - 1] = parsed;
      continue;
    }
    out.push(parsed);
  }
  return out;
}

export function parseGrokBillingLog(text: string): OfficialSlice | null {
  const all = parseGrokBillingLogAll(text);
  return all.at(-1) ?? null;
}

export function grokPlanIdFromLabel(label: string | null): string | null {
  if (!label) return null;
  const s = label.toLowerCase();
  if (s.includes("heavy")) return "grok-heavy";
  if (s.includes("premium+") || s.includes("supergrok") || s.includes("premium")) return "grok-super";
  if (s.includes("free")) return "grok-free";
  return "grok-super";
}

export function grokProductLabel(product: string): string {
  if (product === "GrokBuild") return "Grok Build / CLI";
  if (product === "GrokAppBuilder") return "App Builder";
  if (product === "GrokChat") return "Grok Chat";
  if (product.toLowerCase().includes("spark")) return "Codex Spark";
  return product;
}

export function grokAccessTokenFromAuthFile(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.key === "string" && o.key) return o.key;
    if (typeof o.access_token === "string" && o.access_token) return o.access_token;
  }
  return null;
}

export function mergeGrokOfficial(
  live: OfficialSlice | null,
  log: OfficialSlice | null,
  planLabel?: string | null,
): OfficialSlice | null {
  const base = live ?? log;
  if (!base) return null;
  return {
    ...base,
    planLabel: base.planLabel ?? log?.planLabel ?? planLabel ?? null,
    products: base.products.length ? base.products : (log?.products ?? []),
    prepaidBalance: base.prepaidBalance ?? log?.prepaidBalance ?? null,
    onDemandUsed: base.onDemandUsed ?? log?.onDemandUsed ?? null,
    onDemandCap: base.onDemandCap ?? log?.onDemandCap ?? null,
  };
}

export function codexPlanLabelFromType(planType: string | null | undefined): string | null {
  if (!planType) return null;
  const s = planType.toLowerCase().replace(/\s+/g, "");
  if (s.includes("20x") || s.includes("20×")) return "ChatGPT Pro 20×";
  if (s.includes("5x") || s.includes("5×")) return "ChatGPT Pro 5×";
  if (s.includes("pro")) return "ChatGPT Pro";
  if (s.includes("plus")) return "ChatGPT Plus";
  if (s.includes("team") || s.includes("business")) return "ChatGPT Business";
  if (s.includes("enterprise")) return "ChatGPT Enterprise";
  if (s.includes("free")) return "ChatGPT";
  return planType;
}

export function codexPlanIdFromLabel(label: string | null): string | null {
  if (!label) return null;
  const s = label.toLowerCase().replace(/\s+/g, "");
  if (s.includes("20x") || s.includes("20×")) return "chatgpt-pro-20x";
  if (s.includes("5x") || s.includes("5×")) return "chatgpt-pro-5x";
  if (s.includes("pro")) return "chatgpt-pro";
  if (s.includes("team") || s.includes("business") || s.includes("enterprise")) return "chatgpt-team";
  if (s.includes("api")) return "openai-api";
  if (s.includes("plus") || s.includes("chatgpt")) return "chatgpt-plus";
  return "chatgpt-plus";
}

export function nextCodexPlanId(currentId: string, label: string | null): string {
  const parsed = codexPlanIdFromLabel(label);
  if (!parsed || parsed === "chatgpt-pro") return currentId;
  return parsed;
}

export function codexAuthFromFile(raw: unknown): { token: string; accountId: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const tokens = o.tokens && typeof o.tokens === "object" ? (o.tokens as Record<string, unknown>) : o;
  const token = typeof tokens.access_token === "string" ? tokens.access_token : null;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
  if (!token || !accountId) return null;
  return { token, accountId };
}

interface CodexWindow {
  usedPercent: number;
  windowSeconds: number;
  resetsAt: number | null;
}

function parseCodexWindow(raw: unknown, fetchedAt: number): CodexWindow | null {
  const value = record(raw);
  if (!value || (value.used_percent == null && value.usedPercent == null)) return null;
  const usedPercent = clampPct(num(value.used_percent ?? value.usedPercent));
  const windowSeconds = value.limit_window_seconds != null
    ? num(value.limit_window_seconds)
    : value.window_minutes != null
      ? num(value.window_minutes) * 60
      : value.window_seconds != null
        ? num(value.window_seconds)
        : 0;
  const absolute = value.reset_at ?? value.resets_at;
  const relativeRaw = value.resets_in_seconds;
  const relativeSeconds = relativeRaw == null || relativeRaw === ""
    ? null
    : Number(relativeRaw);
  let resetsAt: number | null = null;
  if (absolute != null) {
    const parsed = num(absolute);
    if (parsed > 0) resetsAt = parsed >= 1_000_000_000_000 ? parsed : parsed * 1000;
  } else if (relativeSeconds != null && Number.isFinite(relativeSeconds) && relativeSeconds >= 0) {
    resetsAt = fetchedAt + relativeSeconds * 1000;
  }
  return { usedPercent, windowSeconds, resetsAt };
}

function isWeeklyWindow(w: CodexWindow): boolean {
  return w.windowSeconds >= 24 * 60 * 60;
}

function emptyOfficial(agent: OfficialSlice["agent"], source: string, fetchedAt: number, planLabel: string | null): OfficialSlice {
  return {
    agent,
    windowPct: null,
    weekPct: null,
    windowResetsAt: null,
    weekResetsAt: null,
    weekStartedAt: null,
    windowDurationMs: null,
    weekDurationMs: null,
    burnPctPerHour: 0,
    planLabel,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source,
    fetchedAt,
    windowKind: "weekly",
  };
}

function applyCodexWindows(
  slice: OfficialSlice,
  primary: CodexWindow | null,
  secondary: CodexWindow | null,
): OfficialSlice {
  const windows = [primary, secondary].filter((w): w is CodexWindow => Boolean(w));
  if (!windows.length) return slice;
  const weekly = windows.find(isWeeklyWindow) ?? null;
  const five = windows.find((w) => !isWeeklyWindow(w)) ?? null;
  if (five) {
    slice.windowKind = "five_hour";
    slice.windowPct = five.usedPercent;
    slice.windowResetsAt = five.resetsAt;
    slice.windowDurationMs = five.windowSeconds > 0 ? five.windowSeconds * 1000 : null;
    if (weekly) {
      slice.weekPct = weekly.usedPercent;
      slice.weekResetsAt = weekly.resetsAt;
      slice.weekDurationMs = weekly.windowSeconds > 0 ? weekly.windowSeconds * 1000 : null;
    }
  } else if (weekly) {
    slice.windowKind = "weekly";
    slice.weekPct = weekly.usedPercent;
    slice.weekResetsAt = weekly.resetsAt;
    slice.weekDurationMs = weekly.windowSeconds > 0 ? weekly.windowSeconds * 1000 : null;
    slice.windowPct = null;
    slice.windowResetsAt = null;
    slice.windowDurationMs = null;
  }
  return slice;
}

export function parseCodexRateLimits(
  raw: unknown,
  opts?: { fetchedAt?: number; source?: string; planType?: string | null },
): OfficialSlice | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  const primary = parseCodexWindow(o.primary ?? o.primary_window, fetchedAt);
  const secondary = parseCodexWindow(o.secondary ?? o.secondary_window, fetchedAt);
  if (!primary && !secondary && o.rate_limit == null) return null;
  const planType = opts?.planType ?? (typeof o.plan_type === "string" ? o.plan_type : null);
  const slice = emptyOfficial("codex", opts?.source ?? "session-rate-limits", fetchedAt, codexPlanLabelFromType(planType));
  const credits = o.credits && typeof o.credits === "object" ? (o.credits as Record<string, unknown>) : {};
  if (credits.balance != null) slice.prepaidBalance = num(credits.balance);
  return applyCodexWindows(slice, primary, secondary);
}

export function parseCodexUsagePayload(
  raw: unknown,
  opts?: { fetchedAt?: number; source?: string },
): OfficialSlice | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const rate = (root.rate_limit && typeof root.rate_limit === "object"
    ? root.rate_limit
    : root) as Record<string, unknown>;
  const planType = typeof root.plan_type === "string" ? root.plan_type : null;
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  const primary = parseCodexWindow(rate.primary_window ?? rate.primary, fetchedAt);
  const secondary = parseCodexWindow(rate.secondary_window ?? rate.secondary, fetchedAt);
  if (!primary && !secondary && planType == null) return null;
  const slice = emptyOfficial("codex", opts?.source ?? "wham-usage", fetchedAt, codexPlanLabelFromType(planType));
  applyCodexWindows(slice, primary, secondary);
  const extra = root.additional_rate_limits;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = String(o.limit_name ?? o.metered_feature ?? "");
      if (!name) continue;
      const nested = (o.rate_limit && typeof o.rate_limit === "object" ? o.rate_limit : o) as Record<string, unknown>;
      const win = parseCodexWindow(nested.primary_window ?? nested.primary, fetchedAt) ?? parseCodexWindow(nested, fetchedAt);
      slice.products.push({ product: name, usagePercent: win ? win.usedPercent : null });
    }
  }
  const credits = root.credits && typeof root.credits === "object" ? (root.credits as Record<string, unknown>) : {};
  if (credits.balance != null) slice.prepaidBalance = num(credits.balance);
  return slice;
}

export function parseCodexRateLimitLine(line: string): OfficialSlice | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = (o.payload && typeof o.payload === "object" ? o.payload : o) as Record<string, unknown>;
  if (payload.type !== "token_count" && o.type !== "event_msg" && !payload.rate_limits) {
    if (!payload.rate_limits && !(o.rate_limits)) return null;
  }
  const rl = payload.rate_limits ?? o.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const ts = o.timestamp ? Date.parse(String(o.timestamp)) : Date.now();
  const planType = typeof (rl as { plan_type?: unknown }).plan_type === "string"
    ? (rl as { plan_type: string }).plan_type
    : null;
  return parseCodexRateLimits(rl, {
    fetchedAt: Number.isFinite(ts) ? ts : Date.now(),
    source: "session-rate-limits",
    planType,
  });
}

export function parseCodexRateLimitLog(text: string): OfficialSlice | null {
  let last: OfficialSlice | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("rate_limits") && !line.includes("token_count")) continue;
    const parsed = parseCodexRateLimitLine(line);
    if (parsed) last = parsed;
  }
  return last;
}

export function parseClaudeStatuslinePayload(
  raw: unknown,
  opts?: { fetchedAt?: number; source?: string },
): OfficialSlice | null {
  const root = record(raw);
  const limits = record(root?.rate_limits);
  if (!limits) return null;
  const parseWindow = (value: unknown) => {
    const row = record(value);
    if (!row) return null;
    const used = nullableNumber(row.used_percentage ?? row.utilization);
    const resetsAt = timestampMs(row.resets_at);
    if (used == null || resetsAt == null) return null;
    return { usedPct: clampPct(used), resetsAt };
  };
  const fiveHour = parseWindow(limits.five_hour);
  const sevenDay = parseWindow(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  return {
    agent: "claude",
    windowPct: fiveHour?.usedPct ?? null,
    weekPct: sevenDay?.usedPct ?? null,
    windowResetsAt: fiveHour?.resetsAt ?? null,
    weekResetsAt: sevenDay?.resetsAt ?? null,
    weekStartedAt: sevenDay?.resetsAt == null ? null : sevenDay.resetsAt - WEEK_MS,
    windowDurationMs: FIVE_HOUR_MS,
    weekDurationMs: WEEK_MS,
    burnPctPerHour: 0,
    planLabel: null,
    products: [],
    prepaidBalance: null,
    onDemandUsed: null,
    onDemandCap: null,
    source: opts?.source ?? "claude-statusline",
    fetchedAt,
    windowKind: "five_hour",
  };
}

export function collapseOfficialPlateaus(history: OfficialSlice[]): OfficialSlice[] {
  const output: OfficialSlice[] = [];
  for (const slice of [...history].sort((left, right) => left.fetchedAt - right.fetchedAt)) {
    const previous = output.at(-1);
    const samePlateau = previous != null
      && previous.agent === slice.agent
      && previous.windowResetsAt === slice.windowResetsAt
      && previous.weekResetsAt === slice.weekResetsAt
      && previous.windowPct === slice.windowPct
      && previous.weekPct === slice.weekPct;
    if (samePlateau) output[output.length - 1] = slice;
    else output.push(slice);
  }
  return output;
}

export { unwrapVal };
