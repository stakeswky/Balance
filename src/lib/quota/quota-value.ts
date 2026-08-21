import { costBreakdown, eventRawTokens } from "./cost.ts";
import { OPENAI_CREDITS_PER_USD, PRICING_VERSION } from "./pricing.ts";
import type { OfficialSlice } from "./official.ts";
import type { AgentId, UsageEvent } from "./types.ts";
import { WEEK_MS, WINDOW_MS } from "./types.ts";

export type ValueConfidence = "none" | "low" | "medium" | "high";
export type CalibrationSource = "none" | "current-window" | "historical-prior";

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
  planLabel?: string | null;
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
  calibrationSource: CalibrationSource;
  pricingVersion: string;
  externalUsageDetected: boolean;
  anomalousPairs: number;
}

const FIVE_H = WINDOW_MS;
const WEEK = WEEK_MS;
const WINDOW_ID_TOLERANCE_MS = 2_000;
const COMPENSATION_RESET_MIN_DROP_PCT = 2;

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
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value));
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

interface ParsedOfficialWindowId {
  agent: string;
  kind: string;
  product: string;
  startsAt: number | null;
  resetsAt: number | null;
}

function parseOfficialWindowId(windowId: string): ParsedOfficialWindowId | null {
  const parts = windowId.split(":");
  if (parts.length < 5) return null;
  const startToken = parts.at(-2)!;
  const resetToken = parts.at(-1)!;
  const parseAnchor = (value: string): number | null | undefined => {
    if (value === "na") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const startsAt = parseAnchor(startToken);
  const resetsAt = parseAnchor(resetToken);
  if (startsAt === undefined || resetsAt === undefined) return null;
  return {
    agent: parts[0]!,
    kind: parts[1]!,
    product: parts.slice(2, -2).join(":"),
    startsAt,
    resetsAt,
  };
}

export function sameOfficialWindowId(left: string, right: string): boolean {
  const a = parseOfficialWindowId(left);
  const b = parseOfficialWindowId(right);
  if (!a || !b) return normalizeOfficialWindowId(left) === normalizeOfficialWindowId(right);
  if (a.agent !== b.agent || a.kind !== b.kind || a.product !== b.product) return false;
  const sameAnchor = (x: number | null, y: number | null) =>
    x == null || y == null ? x === y : Math.abs(x - y) <= WINDOW_ID_TOLERANCE_MS;
  return sameAnchor(a.startsAt, b.startsAt) && sameAnchor(a.resetsAt, b.resetsAt);
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
  if (official?.windowResetsAt && official.windowResetsAt > now) {
    const span = official.windowDurationMs ?? FIVE_H;
    return {
      start: official.windowResetsAt - span,
      end: Math.min(now, official.windowResetsAt),
      rolling: false,
      resetsAt: official.windowResetsAt,
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
      pricedTokens += cost.pricedTokens;
      if (cost.fullyPriced) pricedEvents += 1;
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

export function weightedMedian(rows: { value: number; weight: number }[]): number {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return median(rows.map((row) => row.value));
  const sorted = [...rows].sort((left, right) => left.value - right.value);
  const half = total / 2;
  let accumulated = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index]!;
    accumulated += row.weight;
    const tolerance = Number.EPSILON * Math.max(1, total) * 8;
    if (Math.abs(accumulated - half) <= tolerance) {
      const right = sorted[index + 1];
      return right ? (row.value + right.value) / 2 : row.value;
    }
    if (accumulated > half) return row.value;
  }
  return sorted.at(-1)!.value;
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

function weightedMad(rows: { value: number; weight: number }[], center: number): number {
  return weightedMedian(rows.map((row) => ({
    value: Math.abs(row.value - center),
    weight: row.weight,
  })));
}

function relativeCenterDistance(left: number, right: number): number {
  const scale = Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
  return Math.abs(left - right) / scale;
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
  segmentId: number;
  groupKey: string;
}

interface QuotaSlopeScan {
  slopes: QuotaSlope[];
  latestGroupKey: string | null;
  latestSegmentId: number;
  /** doc §14: cumulative-usd regressions are discarded but must be recorded. */
  cumulativeDropPairs: number;
}

function scanValidSlopes(samples: QuotaSample[]): QuotaSlopeScan {
  const slopes: QuotaSlope[] = [];
  const groups = new Map<string, QuotaSample[]>();
  for (const row of normalizeWindowSamples(samples)) {
    const groupKey = `${row.windowId}\u0000${row.pricingVersion}`;
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  let latestGroupKey: string | null = null;
  let latestSegmentId = 0;
  let latestTimestampMs = -Infinity;
  let cumulativeDropPairs = 0;
  for (const [groupKey, ordered] of groups) {
    let anchor: QuotaSample | null = null;
    let segmentId = 0;
    for (const row of ordered) {
      if (row.pricedTokenCoverage < 0.8) {
        anchor = null;
        segmentId += 1;
        continue;
      }
      if (!anchor) {
        anchor = row;
        continue;
      }

      const dPct = row.usedPercent - anchor.usedPercent;
      const dUsd = row.cumulativeObservedUsd - anchor.cumulativeObservedUsd;
      if (dUsd < 0) {
        cumulativeDropPairs += 1;
        anchor = row;
        segmentId += 1;
        continue;
      }
      if (dPct < 0) {
        anchor = row;
        segmentId += 1;
        continue;
      }
      if (dPct < 1) continue;
      if (dPct > 0 && dUsd === 0) {
        slopes.push({
          value: 0,
          weight: dPct,
          external: true,
          modelMix: {},
          segmentId,
          groupKey,
        });
        anchor = row;
        segmentId += 1;
        continue;
      }
      if (dUsd > 0) {
        slopes.push({
          value: dUsd / dPct,
          weight: dPct,
          external: false,
          modelMix: intervalModelMix(anchor, row),
          segmentId,
          groupKey,
        });
      }
      anchor = row;
    }
    const groupTimestampMs = ordered.at(-1)?.timestampMs ?? -Infinity;
    if (groupTimestampMs > latestTimestampMs) {
      latestTimestampMs = groupTimestampMs;
      latestGroupKey = groupKey;
      latestSegmentId = segmentId;
    }
  }
  return { slopes, latestGroupKey, latestSegmentId, cumulativeDropPairs };
}

export function validSlopes(samples: QuotaSample[]): QuotaSlope[] {
  return scanValidSlopes(samples).slopes;
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
      if (row.usedPercent < maxPct) {
        if (maxPct - row.usedPercent <= COMPENSATION_RESET_MIN_DROP_PCT) continue;
        out.push(row);
        maxPct = row.usedPercent;
        continue;
      }
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
  anomalousPairs: number;
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
    anomalousPairs: 0,
  };
  if (rolling) return empty;
  const normalized = normalizeWindowSamples(samples);
  const scan = scanValidSlopes(normalized);
  const rawSlopes = scan.slopes;
  const anomalousPairs = scan.cumulativeDropPairs;
  // Anomaly diagnostics must see every slope, including the interval-censored
  // first/last plateaus; only the point estimator censors them below.
  const externalUsageDetected = rawSlopes.some((slope) => slope.external);
  const currentSegmentSlopes = scan.latestGroupKey == null
    ? []
    : rawSlopes.filter((slope) =>
        slope.groupKey === scan.latestGroupKey
        && slope.segmentId === scan.latestSegmentId,
      );
  // Point estimation only trusts the segment that is current when the scan
  // ends; a fresh post-reset segment without slopes yields an empty estimate
  // instead of reusing an older segment. The first and current percentage
  // plateaus are interval-censored, so keep them out of the estimate unless
  // there are too few interior transitions.
  const estimationSlopes = currentSegmentSlopes.length >= 3
    ? currentSegmentSlopes.slice(1, -1)
    : currentSegmentSlopes;
  const usable = estimationSlopes.filter((slope) => !slope.external && slope.value > 0);
  if (!usable.length) return { ...empty, externalUsageDetected, anomalousPairs };

  const agent = normalized[0]?.agent;
  const currentMix = [...rawSlopes]
    .reverse()
    .find((slope) => !slope.external && slope.value > 0 && hasModelMix(slope.modelMix))?.modelMix ?? {};
  const compatible =
    agent === "codex" || !hasModelMix(currentMix)
      ? usable
      : usable.filter((slope) => hasModelMix(slope.modelMix) && modelMixDrift(slope.modelMix, currentMix) <= 0.35);
  if (!compatible.length) return { ...empty, externalUsageDetected, anomalousPairs };

  const provisionalCenter = weightedMedian(compatible);
  const modelMixUnknown = !hasModelMix(currentMix)
    || compatible.some((slope) => !hasModelMix(slope.modelMix));
  const cheapSlopes = new Set(
    compatible.filter((slope) => {
      if (slope.value >= provisionalCenter * 0.4) return false;
      if (!hasModelMix(currentMix) || !hasModelMix(slope.modelMix)) return false;
      return modelMixDrift(slope.modelMix, currentMix) < 0.15;
    }),
  );
  const candidates = compatible.filter((slope) => !cheapSlopes.has(slope));
  if (!candidates.length) {
    return { ...empty, externalUsageDetected: externalUsageDetected || cheapSlopes.size > 0, anomalousPairs };
  }

  const unweightedCenter = median(candidates.map((slope) => slope.value));
  const weightedCenter = weightedMedian(candidates);
  const mad = weightedMad(candidates, weightedCenter);
  const threshold = Math.max(3 * mad, 0.25 * weightedCenter);
  const kept = candidates.filter((slope) =>
    Math.abs(slope.value - weightedCenter) <= threshold,
  );
  if (!kept.length) return { ...empty, externalUsageDetected: externalUsageDetected || cheapSlopes.size > 0, anomalousPairs };
  const centerConflict = relativeCenterDistance(unweightedCenter, weightedCenter) > 0.35;

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

  const cheap = cheapSlopes.size > 0;
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
  if (centerConflict && (confidence === "high" || confidence === "medium")) {
    confidence = "low";
  }
  if (modelMixUnknown && (confidence === "high" || confidence === "medium")) {
    confidence = "low";
  }
  const downgrade = (c: ValueConfidence): ValueConfidence =>
    c === "high" ? "medium" : c === "medium" ? "low" : "none";
  if (externalUsageDetected && confidence !== "none") confidence = downgrade(confidence);
  if (confidence === "none") return { ...empty, externalUsageDetected: externalUsageDetected || cheap, anomalousPairs };

  let band = drift >= 0.15 ? 0.25 : 0.15;
  if (confidence === "high" && usedPct % 1 !== 0) band = Math.min(band, 0.1);
  if (confidence !== "high") band = Math.max(band, 1 / sumPct);
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
    externalUsageDetected: externalUsageDetected || cheap,
    anomalousPairs,
  };
}

export function makeSample(opts: {
  windowId: string;
  agent: AgentId;
  product?: string | null;
  timestampMs: number;
  usedPercent: number;
  events: UsageEvent[];
  planLabel?: string | null;
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
    planLabel: opts.planLabel ?? null,
  };
}

function retentionGroup(sample: QuotaSample): string {
  const kind = sample.windowId.split(":")[1] ?? "unknown";
  return `${sample.agent}:${kind}:${sample.product ?? "_"}`;
}

export function mergeSamples(existing: QuotaSample[], incoming: QuotaSample): QuotaSample[] {
  const canonicalExisting = existing.map(normalizeSampleWindowId);
  const normalizedIncoming = normalizeSampleWindowId(incoming);
  const matchedWindowId = canonicalExisting.find((row) =>
    sameOfficialWindowId(row.windowId, normalizedIncoming.windowId),
  )?.windowId;
  const canonicalIncoming = matchedWindowId
    ? { ...normalizedIncoming, windowId: matchedWindowId }
    : normalizedIncoming;
  const same = canonicalExisting.filter((row) =>
    sameOfficialWindowId(row.windowId, canonicalIncoming.windowId),
  );
  const others = canonicalExisting.filter((row) =>
    !sameOfficialWindowId(row.windowId, canonicalIncoming.windowId),
  );
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
    const stale = kind === "weekly" ? slice.weekStale : slice.windowStale;
    if (used == null || stale) return;

    const sampledAt = slice.fetchedAt;
    if (!Number.isFinite(sampledAt) || sampledAt <= 0) return;
    if (sampledAt > now) return;
    const bounds = windowBounds(slice, kind, sampledAt);
    if (bounds.rolling || sampledAt < bounds.start || sampledAt > bounds.end) return;

    const windowId = officialWindowId(slice.agent, kind, null, bounds.start, bounds.resetsAt);
    const next = makeSample({
      windowId,
      agent: slice.agent,
      timestampMs: sampledAt,
      usedPercent: used,
      events: eventsInWindow(
        events,
        slice.agent,
        bounds.start,
        Math.min(bounds.end, sampledAt, now),
      ),
      planLabel: slice.planLabel,
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

export function historicalWindowPrior(
  samples: QuotaSample[],
  currentWindowId: string,
  currentWindowStartMs: number,
  agent: AgentId,
  kind: "five_hour" | "weekly",
  planLabel: string | null,
  usedPct: number,
  currentModelMix: Record<string, number>,
): ReturnType<typeof calibrateFromSamples> | null {
  const groups = new Map<string, QuotaSample[]>();
  for (const sample of samples) {
    if (sample.agent !== agent || sample.pricingVersion !== PRICING_VERSION) continue;
    if ((sample.planLabel ?? null) !== planLabel) continue;
    if ((sample.windowId.split(":")[1] ?? "") !== kind) continue;
    if (sameOfficialWindowId(sample.windowId, currentWindowId)) continue;
    const rows = groups.get(sample.windowId) ?? [];
    rows.push(sample);
    groups.set(sample.windowId, rows);
  }

  const windowEstimates = [...groups.values()]
    .map((rows) => {
      const ordered = normalizeWindowSamples(rows);
      const last = ordered.at(-1);
      if (!last) return null;
      const identity = parseOfficialWindowId(last.windowId);
      if (
        !identity
        || identity.resetsAt == null
        || identity.resetsAt > currentWindowStartMs
      ) return null;
      if (!hasModelMix(currentModelMix) || !hasModelMix(last.modelMix)) return null;
      if (modelMixDrift(last.modelMix, currentModelMix) > 0.35) return null;
      const result = calibrateFromSamples(ordered, last.usedPercent, false);
      const span = last.usedPercent - (ordered[0]?.usedPercent ?? last.usedPercent);
      if (result.totalPointUsd == null || result.confidence === "none" || span < 5) return null;
      return { value: result.totalPointUsd / 100, weight: span, at: last.timestampMs };
    })
    .filter((row): row is { value: number; weight: number; at: number } => row != null)
    .sort((left, right) => right.at - left.at)
    .slice(0, 3);

  if (!windowEstimates.length) return null;
  const point = weightedMedian(windowEstimates);
  const lowRaw = weightedPercentile(windowEstimates, 0.25);
  const highRaw = weightedPercentile(windowEstimates, 0.75);
  const spread = point > 0 ? (highRaw - lowRaw) / point : Number.POSITIVE_INFINITY;
  if (windowEstimates.length > 1 && spread > 0.35) return null;
  const low = Math.min(lowRaw, point * 0.75);
  const high = Math.max(highRaw, point * 1.25);
  const remaining = 100 - Math.max(0, Math.min(100, usedPct));
  return {
    totalLowUsd: low * 100,
    totalPointUsd: point * 100,
    totalHighUsd: high * 100,
    remainingLowUsd: low * remaining,
    remainingPointUsd: point * remaining,
    remainingHighUsd: high * remaining,
    confidence: "low",
    externalUsageDetected: false,
    anomalousPairs: 0,
  };
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
    anomalousPairs: 0,
  };
  const compatibleSamples = (samples ?? []).filter((sample) =>
    sameOfficialWindowId(sample.windowId, windowId),
  );
  const currentCalibration = official
    ? calibrateFromSamples(compatibleSamples, usedPct, bounds.rolling)
    : emptyCal;
  // §12: any external-usage signal disqualifies borrowing a prior — either
  // sample-derived (external slopes in the current window) or L1-derived
  // (official percent moved while locally priced spend is zero).
  const externallyConsumed =
    currentCalibration.externalUsageDetected || (usedPct > 0 && obs.observedUsd === 0);
  const prior = official
    && !bounds.rolling
    && currentCalibration.confidence === "none"
    && !externallyConsumed
    ? historicalWindowPrior(
        samples ?? [],
        windowId,
        bounds.start,
        agent,
        kind,
        official.planLabel,
        usedPct,
        obs.modelMix,
      )
    : null;
  const cal = prior
    ? { ...prior, anomalousPairs: currentCalibration.anomalousPairs }
    : currentCalibration;
  const calibrationSource: CalibrationSource = prior
    ? "historical-prior"
    : cal.confidence === "none"
      ? "none"
      : "current-window";
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
    calibrationSource,
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
