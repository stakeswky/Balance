import type { OfficialQuota, OfficialSlice } from "../quota/official.ts";
import { buildAgentSchedulingProfiles } from "./capacity.ts";
import type {
  AgentCapacity,
  AgentRuntimeProbe,
  AgentSchedulingProfile,
  ClientQuotaEvidence,
  NativeAgentId,
  OrchestratorSettings,
  QuotaSnapshot,
  RoleSuccessRates,
} from "./types.ts";

export const QUOTA_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1_000;
export const QUOTA_CLOCK_SKEW_MS = 30 * 1_000;
export const QUOTA_RESET_MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1_000;

interface TrustedL3Evidence {
  remainingPct: number;
  confidence: "medium" | "high";
  observedAt: number;
}

interface OfficialObservation {
  remainingPct: number | null;
  observedAt: number | null;
  resetsAt: number | null;
  fresh: boolean;
  source: string | null;
}

function validPercentage(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validTimestamp(value: number | null, now: number): value is number {
  return value !== null
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= now + QUOTA_CLOCK_SKEW_MS;
}

function officialObservation(slice: OfficialSlice | null, now: number): OfficialObservation {
  if (!slice) {
    return { remainingPct: null, observedAt: null, resetsAt: null, fresh: false, source: null };
  }
  const candidates = [
    {
      usedPct: slice.windowPct,
      observedAt: slice.windowFetchedAt ?? slice.fetchedAt,
      resetsAt: slice.windowResetsAt,
      stale: slice.windowStale === true,
    },
    {
      usedPct: slice.weekPct,
      observedAt: slice.weekFetchedAt ?? slice.fetchedAt,
      resetsAt: slice.weekResetsAt,
      stale: slice.weekStale === true,
    },
  ].filter((candidate) => validPercentage(candidate.usedPct));
  if (candidates.length === 0) {
    return {
      remainingPct: null,
      observedAt: null,
      resetsAt: null,
      fresh: false,
      source: slice.source ?? null,
    };
  }
  candidates.sort((left, right) => right.usedPct! - left.usedPct!);
  const selected = candidates[0]!;
  const observedAt = validTimestamp(selected.observedAt, now) ? selected.observedAt : null;
  const resetsAt = selected.resetsAt !== null
    && Number.isSafeInteger(selected.resetsAt)
    && selected.resetsAt >= 0
    && selected.resetsAt <= now + QUOTA_RESET_MAX_FUTURE_MS
      ? selected.resetsAt
      : null;
  const fresh = (
    !selected.stale
    && observedAt !== null
    && now - observedAt <= QUOTA_SNAPSHOT_MAX_AGE_MS
    && (resetsAt === null || resetsAt > now)
  );
  return {
    remainingPct: Math.max(0, 100 - selected.usedPct!),
    observedAt,
    resetsAt,
    fresh,
    source: slice.source ?? null,
  };
}

function emptyRates(): RoleSuccessRates {
  return { planningSuccessRate: null, executionSuccessRate: null, repairSuccessRate: null };
}

export function buildTrustedQuotaSnapshot(input: {
  clientEvidence: Record<NativeAgentId, ClientQuotaEvidence>;
  officialQuota: OfficialQuota;
  runtimes: Record<NativeAgentId, AgentRuntimeProbe>;
  settings: OrchestratorSettings;
  roleSuccessRates?: Partial<Record<NativeAgentId, RoleSuccessRates>>;
  trustedL3?: Partial<Record<NativeAgentId, TrustedL3Evidence>>;
  now: number;
}): { snapshot: QuotaSnapshot; profiles: AgentSchedulingProfile[] } {
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("quota snapshot time is invalid");
  const capacities: AgentCapacity[] = (["claude", "codex", "grok"] as const).map((agent) => {
    const official = officialObservation(input.officialQuota[agent], input.now);
    const client = input.clientEvidence[agent];
    const trustedL3 = input.trustedL3?.[agent];
    const rates = input.roleSuccessRates?.[agent] ?? emptyRates();
    return {
      agent,
      enabled: input.settings.agents[agent].enabled,
      installed: input.runtimes[agent].ok && Boolean(input.runtimes[agent].path),
      version: input.runtimes[agent].version,
      binaryPath: input.runtimes[agent].ok ? input.runtimes[agent].path : null,
      officialRemainingPct: official.remainingPct,
      officialObservedAt: official.observedAt,
      officialResetsAt: official.resetsAt,
      officialFresh: official.fresh,
      officialSource: official.source,
      l3RemainingPct: trustedL3?.remainingPct ?? client.l3RemainingPct,
      l3Confidence: trustedL3?.confidence ?? client.l3Confidence,
      l3ObservedAt: trustedL3?.observedAt ?? client.l3ObservedAt,
      l3Trusted: Boolean(trustedL3),
      planningSuccessRate: rates.planningSuccessRate,
      executionSuccessRate: rates.executionSuccessRate,
      repairSuccessRate: rates.repairSuccessRate,
      allowUnknownQuota: input.settings.agents[agent].allowUnknownQuota,
    };
  });
  const profiles = buildAgentSchedulingProfiles({ capacities, now: input.now });
  return {
    profiles,
    snapshot: {
      capturedAt: input.now,
      evidence: Object.fromEntries(profiles.map((profile) => [profile.agent, {
        officialRemainingPct: profile.officialRemainingPct,
        officialObservedAt: profile.officialObservedAt,
        officialResetsAt: profile.officialResetsAt,
        officialFresh: profile.officialFresh,
        officialSource: profile.officialSource,
        l3RemainingPct: profile.l3RemainingPct,
        l3Confidence: profile.l3Confidence,
        l3ObservedAt: profile.l3ObservedAt,
        l3Trusted: profile.l3Trusted,
        computedExecutionUnits: profile.executionUnits,
        admissionSource: profile.admissionSource,
        diagnostics: [...profile.diagnostics, ...profile.exclusionReasons],
      }])) as QuotaSnapshot["evidence"],
    },
  };
}

export function quotaSnapshotIsFresh(snapshot: QuotaSnapshot, now: number): boolean {
  return Number.isSafeInteger(now)
    && now >= 0
    && snapshot.capturedAt <= now + QUOTA_CLOCK_SKEW_MS
    && now - snapshot.capturedAt <= QUOTA_SNAPSHOT_MAX_AGE_MS;
}
