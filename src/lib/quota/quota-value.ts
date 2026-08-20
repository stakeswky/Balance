import { costBreakdown, eventRawTokens } from "./cost.ts";
import { OPENAI_CREDITS_PER_USD, PRICING_VERSION } from "./pricing.ts";
import type { OfficialSlice } from "./official.ts";
import type { AgentId, UsageEvent } from "./types.ts";
import { WEEK_MS, WINDOW_MS } from "./types.ts";

export type ValueConfidence = "none" | "low" | "medium" | "high";

export interface QuotaSample {
  windowId: string;
  agent: AgentId;
  product: string | null;
  timestampMs: number;
  usedPercent: number;
  cumulativeObservedUsd: number;
  pricedTokenCoverage: number;
  modelMix: Record<string, number>;
  pricingVersion: string;
}

export interface QuotaValue {
  usedPct: number;
  l1Usd: number;
  l1Credits: number | null;
  l1Tokens: number;
  pricedTokenCoverage: number;
  pricedEventCoverage: number;
  rolling: boolean;
  windowId: string;
  totalLowUsd: number | null;
  totalPointUsd: number | null;
  totalHighUsd: number | null;
  remainingLowUsd: number | null;
  remainingPointUsd: number | null;
  remainingHighUsd: number | null;
  totalLowCredits: number | null;
  totalPointCredits: number | null;
  totalHighCredits: number | null;
  remainingLowCredits: number | null;
  remainingPointCredits: number | null;
  remainingHighCredits: number | null;
  confidence: ValueConfidence;
  pricingVersion: string;
  externalUsageDetected: boolean;
}

const FIVE_H = WINDOW_MS;
const WEEK = WEEK_MS;
const WINDOW_ID_GRANULARITY_MS = 60_000;
const MIN_REAL_WINDOW_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

function advanceWindow(start: number, span: number, now: number): { start: number; resetsAt: number } {
  if (!(span > 0)) return { start, resetsAt: start + span };
  if (now < start) return { start, resetsAt: start + span };
  const n = Math.floor((now - start) / span);
  const nextStart = start + n * span;
  return { start: nextStart, resetsAt: nextStart + span };
}

export function officialWindowId(
  agent: AgentId,
  kind: "five_hour" | "weekly" | "product",
  product: string | null,
  startsAt: number | null,
  resetsAt: number | null,
): string {
  return `${agent}:${kind}:${product ?? "_"}:${canonicalWindowAnchor(startsAt)}:${canonicalWindowAnchor(resetsAt)}`;
}

function canonicalWindowAnchor(value: number | null): string {
  if (value == null) return "na";
  if (!Number.isFinite(value) || value < MIN_REAL_WINDOW_TIMESTAMP_MS) return String(value);
  return String(Math.round(value / WINDOW_ID_GRANULARITY_MS) * WINDOW_ID_GRANULARITY_MS);
}

function canonicalWindowAnchorToken(value: string): string | null {
  if (value === "na") return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return canonicalWindowAnchor(parsed);
}

function normalizeOfficialWindowId(windowId: string): string {
  const parts = windowId.split(":");
  if (parts.length < 5) return windowId;
  const agent = parts[0];
  const kind = parts[1];
  if ((agent !== "claude" && agent !== "codex" && agent !== "grok")
    || (kind !== "five_hour" && kind !== "weekly" && kind !== "product")) {
    return windowId;
  }
  const startsAt = canonicalWindowAnchorToken(parts[parts.length - 2]!);
  const resetsAt = canonicalWindowAnchorToken(parts[parts.length - 1]!);
  if (startsAt == null || resetsAt == null) return windowId;
  const product = parts.slice(2, -2).join(":");
  return `${agent}:${kind}:${product}:${startsAt}:${resetsAt}`;
}

function normalizeSampleWindowId(sample: QuotaSample): QuotaSample {
  const windowId = normalizeOfficialWindowId(sample.windowId);
  if (windowId === sample.windowId) return sample;
  return { ...sample, windowId };
}

export function windowBounds(
  official: OfficialSlice | null | undefined,
  kind: "five_hour" | "weekly",
  now: number,
): { start: number; end: number; rolling: boolean; resetsAt: number | null } {
  const end = Math.min(now, (kind === "weekly" ? official?.weekResetsAt : official?.windowResetsAt) ?? now);
  if (kind === "weekly") {
    if (official?.weekStartedAt) {
      return { start: official.weekStartedAt, end, rolling: false, resetsAt: official.weekResetsAt };
    }
    if (official?.weekResetsAt) {
      return {
        start: official.weekResetsAt - (official.weekDurationMs ?? WEEK),
        end,
        rolling: false,
        resetsAt: official.weekResetsAt,
      };
    }
    return { start: now - WEEK, end: now, rolling: true, resetsAt: official?.weekResetsAt ?? null };
  }
  if (official?.windowResetsAt) {
    const span = official.windowDurationMs ?? FIVE_H;
    const originStart = official.windowResetsAt - span;
    const rolled = advanceWindow(originStart, span, now);
    return {
      start: rolled.start,
      end: Math.min(now, rolled.resetsAt),
      rolling: false,
      resetsAt: rolled.resetsAt,
    };
  }
  return { start: now - FIVE_H, end: now, rolling: true, resetsAt: null };
}

export function eventsInWindow(events: UsageEvent[], agent: AgentId, start: number, end: number): UsageEvent[] {
  const seen = new Set<string>();
  const out: UsageEvent[] = [];
  for (const e of events) {
    if (e.agent !== agent) continue;
    if (e.ts < start || e.ts > end) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function observeWindow(events: UsageEvent[]): {
  observedUsd: number;
  observedTokens: number;
  pricedTokens: number;
  pricedEvents: number;
  modelMix: Record<string, number>;
  pricedTokenCoverage: number;
  pricedEventCoverage: number;
} {
  let observedUsd = 0;
  let observedTokens = 0;
  let pricedTokens = 0;
  let pricedEvents = 0;
  const mix: Record<string, number> = {};
  for (const e of events) {
    const tokens = eventRawTokens(e);
    const cost = costBreakdown(e);
    observedTokens += tokens;
    if (cost.priced && cost.pricingQuality !== "unknown") {
      observedUsd += cost.totalUsd;
      const uncertainWriteTokens = e.cacheWriteUnsplit ? Math.max(0, e.cacheWrite) : 0;
      pricedTokens += Math.max(0, tokens - uncertainWriteTokens);
      pricedEvents += 1;
      const key = cost.pricingModel ?? e.model;
      mix[key] = (mix[key] ?? 0) + cost.totalUsd;
    }
  }
  const mixTotal = Object.values(mix).reduce((s, n) => s + n, 0);
  const modelMix: Record<string, number> = {};
  if (mixTotal > 0) {
    for (const [k, v] of Object.entries(mix)) modelMix[k] = v / mixTotal;
  }
  return {
    observedUsd,
    observedTokens,
    pricedTokens,
    pricedEvents,
    modelMix,
    pricedTokenCoverage: observedTokens > 0 ? pricedTokens / observedTokens : 1,
    pricedEventCoverage: events.length > 0 ? pricedEvents / events.length : 1,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function weightedMedian(rows: { value: number; weight: number }[]): number {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (total <= 0) return median(rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  let acc = 0;
  for (const row of sorted) {
    acc += row.weight;
    if (acc >= total / 2) return row.value;
  }
  return sorted[sorted.length - 1]!.value;
}

function weightedPercentile(rows: { value: number; weight: number }[], p: number): number {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (total <= 0) return median(rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const target = total * p;
  let acc = 0;
  for (const row of sorted) {
    acc += row.weight;
    if (acc >= target) return row.value;
  }
  return sorted[sorted.length - 1]!.value;
}

function modelMixDrift(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return 0.5 * sum;
}

function hasModelMix(mix: Record<string, number>): boolean {
  return Object.values(mix).some((share) => share > 0);
}

function intervalModelMix(a: QuotaSample, b: QuotaSample): Record<string, number> {
  const keys = new Set([...Object.keys(a.modelMix), ...Object.keys(b.modelMix)]);
  const deltas: Record<string, number> = {};
  let total = 0;
  for (const key of keys) {
    const before = a.cumulativeObservedUsd * (a.modelMix[key] ?? 0);
    const after = b.cumulativeObservedUsd * (b.modelMix[key] ?? 0);
    const delta = Math.max(0, after - before);
    if (delta <= 0) continue;
    deltas[key] = delta;
    total += delta;
  }
  if (total <= 0) return {};
  return Object.fromEntries(Object.entries(deltas).map(([key, value]) => [key, value / total]));
}

interface QuotaSlope {
  value: number;
  weight: number;
  external: boolean;
  modelMix: Record<string, number>;
}

export function validSlopes(samples: QuotaSample[]): QuotaSlope[] {
  const out: QuotaSlope[] = [];
  const groups = new Map<string, QuotaSample[]>();
  for (const row of normalizeWindowSamples(samples)) {
    const key = `${row.windowId}\u0000${row.pricingVersion}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const ordered of groups.values()) {
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1]!;
      const b = ordered[i]!;
      const dPct = b.usedPercent - a.usedPercent;
      const dUsd = b.cumulativeObservedUsd - a.cumulativeObservedUsd;
      if (dPct < 1) continue;
      if (dUsd < 0) continue;
      if (b.pricedTokenCoverage < 0.8 || a.pricedTokenCoverage < 0.8) continue;
      if (dUsd === 0) {
        out.push({ value: 0, weight: dPct, external: true, modelMix: {} });
        continue;
      }
      out.push({ value: dUsd / dPct, weight: dPct, external: false, modelMix: intervalModelMix(a, b) });
    }
  }
  return out;
}

export function normalizeWindowSamples(samples: QuotaSample[]): QuotaSample[] {
  const groups = new Map<string, QuotaSample[]>();
  for (const original of samples) {
    const row = normalizeSampleWindowId(original);
    const key = `${row.windowId}\u0000${row.pricingVersion}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const normalized: QuotaSample[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.timestampMs - b.timestampMs);
    const out: QuotaSample[] = [];
    let maxPct = -Infinity;
    for (const row of ordered) {
      if (row.usedPercent < maxPct) continue;
      if (row.usedPercent === maxPct) {
        out[out.length - 1] = row;
        continue;
      }
      out.push(row);
      maxPct = row.usedPercent;
    }
    normalized.push(...out);
  }
  return normalized.sort((a, b) => a.timestampMs - b.timestampMs);
}

export function calibrateFromSamples(samples: QuotaSample[], usedPct: number, rolling: boolean): {
  totalLowUsd: number | null;
  totalPointUsd: number | null;
  totalHighUsd: number | null;
  remainingLowUsd: number | null;
  remainingPointUsd: number | null;
  remainingHighUsd: number | null;
  confidence: ValueConfidence;
  externalUsageDetected: boolean;
} {
  const empty = {
    totalLowUsd: null,
    totalPointUsd: null,
    totalHighUsd: null,
    remainingLowUsd: null,
    remainingPointUsd: null,
    remainingHighUsd: null,
    confidence: "none" as const,
    externalUsageDetected: false,
  };
  if (rolling) return empty;
  const normalized = normalizeWindowSamples(samples);
  const rawSlopes = validSlopes(normalized);
  // The first and current percentage plateaus are interval-censored: their
  // unseen beginning/end makes their USD-per-percent slope systematically
  // unstable. Keep them only when there are too few interior transitions.
  const slopes = rawSlopes.length >= 3 ? rawSlopes.slice(1, -1) : rawSlopes;
  const externalUsageDetected = slopes.some((s) => s.external);
  const usable = slopes.filter((s) => !s.external && s.value > 0);
  if (!usable.length) return { ...empty, externalUsageDetected };

  const agent = normalized[0]?.agent;
  const currentMix = [...rawSlopes]
    .reverse()
    .find((slope) => !slope.external && slope.value > 0 && hasModelMix(slope.modelMix))?.modelMix ?? {};
  const compatible =
    agent === "codex" || !hasModelMix(currentMix)
      ? usable
      : usable.filter((slope) => hasModelMix(slope.modelMix) && modelMixDrift(slope.modelMix, currentMix) <= 0.35);
  if (!compatible.length) return { ...empty, externalUsageDetected };

  const values = compatible.map((s) => s.value);
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  const kept = compatible.filter((s) => Math.abs(s.value - m) <= Math.max(3 * mad, 0.25 * m));
  if (!kept.length) return { ...empty, externalUsageDetected };

  const point = weightedMedian(kept);
  const lowRaw = weightedPercentile(kept, 0.25);
  const highRaw = weightedPercentile(kept, 0.75);
  const slopeDispersion = point > 0 ? (highRaw - lowRaw) / point : 1;

  const last = normalized.at(-1);
  // OpenAI's current Codex rate card prices all supported models at the same
  // 25 credits per API-equivalent USD, so Codex model mix does not change the
  // calibration unit. Other providers retain the conservative drift gate.
  const drift =
    agent === "codex" || !hasModelMix(currentMix)
      ? 0
      : weightedMedian(
          kept.map((slope) => ({ value: modelMixDrift(slope.modelMix, currentMix), weight: slope.weight })),
        );

  const cheap = compatible.some((s) => s.value < m * 0.4);
  const sumPct = kept.reduce((s, r) => s + r.weight, 0);
  const coverage = last?.pricedTokenCoverage ?? 0;
  let confidence: ValueConfidence = "none";
  if (kept.length >= 6 && sumPct >= 15 && coverage >= 0.95 && drift < 0.15 && slopeDispersion <= 0.2) {
    confidence = "high";
  } else if (kept.length >= 3 && sumPct >= 5 && coverage >= 0.9 && drift <= 0.35) {
    confidence = "medium";
  } else if (kept.length >= 1 && sumPct >= 2 && coverage >= 0.8) {
    confidence = "low";
  }
  const downgrade = (c: ValueConfidence): ValueConfidence =>
    c === "high" ? "medium" : c === "medium" ? "low" : "none";
  if (externalUsageDetected && confidence !== "none") confidence = downgrade(confidence);
  if (cheap && confidence !== "none") confidence = downgrade(confidence);
  if (confidence === "none") return { ...empty, externalUsageDetected };

  let band = drift >= 0.15 ? 0.25 : 0.15;
  if (confidence === "high" && usedPct % 1 !== 0) band = Math.min(band, 0.1);
  const low = Math.min(lowRaw, point * (1 - band));
  const high = Math.max(highRaw, point * (1 + band));

  const u = Math.max(0, Math.min(100, usedPct));
  return {
    totalLowUsd: low * 100,
    totalPointUsd: point * 100,
    totalHighUsd: high * 100,
    remainingLowUsd: low * (100 - u),
    remainingPointUsd: point * (100 - u),
    remainingHighUsd: high * (100 - u),
    confidence,
    externalUsageDetected,
  };
}

export function makeSample(opts: {
  windowId: string;
  agent: AgentId;
  product?: string | null;
  timestampMs: number;
  usedPercent: number;
  events: UsageEvent[];
}): QuotaSample | null {
  const obs = observeWindow(opts.events);
  return {
    windowId: opts.windowId,
    agent: opts.agent,
    product: opts.product ?? null,
    timestampMs: opts.timestampMs,
    usedPercent: opts.usedPercent,
    cumulativeObservedUsd: obs.observedUsd,
    pricedTokenCoverage: obs.pricedTokenCoverage,
    modelMix: obs.modelMix,
    pricingVersion: PRICING_VERSION,
  };
}

function retentionGroup(sample: QuotaSample): string {
  const kind = sample.windowId.split(":")[1] ?? "unknown";
  return `${sample.agent}:${kind}:${sample.product ?? "_"}`;
}

export function mergeSamples(existing: QuotaSample[], incoming: QuotaSample): QuotaSample[] {
  const canonicalExisting = existing.map(normalizeSampleWindowId);
  const canonicalIncoming = normalizeSampleWindowId(incoming);
  const same = canonicalExisting.filter((s) => s.windowId === canonicalIncoming.windowId);
  const others = canonicalExisting.filter((s) => s.windowId !== canonicalIncoming.windowId);
  const nextSame = normalizeWindowSamples([...same, canonicalIncoming]).slice(-128);
  const combined = others.concat(nextSame);
  const latestByWindow = new Map<string, { group: string; at: number }>();
  for (const sample of combined) {
    if (sample.agent !== canonicalIncoming.agent) continue;
    const current = latestByWindow.get(sample.windowId);
    if (!current || sample.timestampMs > current.at) {
      latestByWindow.set(sample.windowId, {
        group: retentionGroup(sample),
        at: sample.timestampMs,
      });
    }
  }
  const grouped = new Map<string, Array<{ windowId: string; at: number }>>();
  for (const [windowId, meta] of latestByWindow) {
    const rows = grouped.get(meta.group) ?? [];
    rows.push({ windowId, at: meta.at });
    grouped.set(meta.group, rows);
  }
  const keep = new Set<string>();
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.at - right.at);
    for (const row of rows.slice(-8)) keep.add(row.windowId);
  }
  return combined.filter((sample) => sample.agent !== canonicalIncoming.agent || keep.has(sample.windowId));
}

export function samplesFromOfficialHistory(
  events: UsageEvent[],
  history: OfficialSlice[],
  existing: QuotaSample[],
): QuotaSample[] {
  let samples = existing;
  for (const slice of [...history].sort((a, b) => a.fetchedAt - b.fetchedAt)) {
    samples = samplesFromOfficial(
      events,
      {
        claude: slice.agent === "claude" ? slice : null,
        grok: slice.agent === "grok" ? slice : null,
        codex: slice.agent === "codex" ? slice : null,
      },
      slice.fetchedAt,
      samples,
    );
  }
  return samples;
}

export function samplesFromOfficial(
  events: UsageEvent[],
  official: { claude: OfficialSlice | null; grok: OfficialSlice | null; codex: OfficialSlice | null },
  now: number,
  existing: QuotaSample[],
): QuotaSample[] {
  let samples = existing;
  const consider = (slice: OfficialSlice | null, kind: "five_hour" | "weekly") => {
    if (!slice) return;
    const used = kind === "weekly" ? slice.weekPct : slice.windowPct;
    if (used == null) return;
    const bounds = windowBounds(slice, kind, now);
    if (bounds.rolling) return;
    const windowId = officialWindowId(slice.agent, kind, null, bounds.start, bounds.resetsAt);
    const next = makeSample({
      windowId,
      agent: slice.agent,
      timestampMs: slice.fetchedAt || now,
      usedPercent: used,
      events: eventsInWindow(events, slice.agent, bounds.start, bounds.end),
    });
    if (next) samples = mergeSamples(samples, next);
  };
  consider(official.claude, "five_hour");
  consider(official.claude, "weekly");
  consider(official.grok, "five_hour");
  consider(official.grok, "weekly");
  consider(official.codex, "five_hour");
  consider(official.codex, "weekly");
  return samples;
}

export function quotaValueFor(
  events: UsageEvent[],
  agent: AgentId,
  official: OfficialSlice | null | undefined,
  kind: "five_hour" | "weekly",
  now: number,
  samples: QuotaSample[],
): QuotaValue {
  const usedPct = (kind === "weekly" ? official?.weekPct : official?.windowPct) ?? 0;
  const bounds = windowBounds(official, kind, now);
  const windowId = officialWindowId(agent, kind, null, bounds.rolling ? null : bounds.start, bounds.resetsAt);
  const slice = eventsInWindow(events, agent, bounds.start, bounds.end);
  const obs = observeWindow(slice);
  const emptyCal = {
    totalLowUsd: null,
    totalPointUsd: null,
    totalHighUsd: null,
    remainingLowUsd: null,
    remainingPointUsd: null,
    remainingHighUsd: null,
    confidence: "none" as const,
    externalUsageDetected: false,
  };
  const compatibleSamples = (samples ?? []).filter(
    (sample) => normalizeOfficialWindowId(sample.windowId) === windowId,
  );
  const cal = official
    ? calibrateFromSamples(
        compatibleSamples,
        usedPct,
        bounds.rolling,
      )
    : emptyCal;
  const toCredits = (usd: number | null): number | null =>
    agent === "codex" && usd != null ? usd * OPENAI_CREDITS_PER_USD : null;
  return {
    usedPct,
    l1Usd: obs.observedUsd,
    l1Credits: toCredits(obs.observedUsd),
    l1Tokens: obs.observedTokens,
    pricedTokenCoverage: obs.pricedTokenCoverage,
    pricedEventCoverage: obs.pricedEventCoverage,
    rolling: bounds.rolling,
    windowId,
    ...cal,
    totalLowCredits: toCredits(cal.totalLowUsd),
    totalPointCredits: toCredits(cal.totalPointUsd),
    totalHighCredits: toCredits(cal.totalHighUsd),
    remainingLowCredits: toCredits(cal.remainingLowUsd),
    remainingPointCredits: toCredits(cal.remainingPointUsd),
    remainingHighCredits: toCredits(cal.remainingHighUsd),
    externalUsageDetected: cal.externalUsageDetected || (usedPct > 0 && obs.observedUsd === 0),
    pricingVersion: PRICING_VERSION,
  };
}
