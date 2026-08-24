import type { NativeAgentId } from "./types.ts";

const AGENTS = ["claude", "codex", "grok"] as const;
const DEFAULT_TTL_MS = 15 * 60 * 1_000;

export interface CapacityReservationConflict {
  agent: NativeAgentId;
  requestedUnits: number;
  availableUnits: number;
  reservedByOtherRuns: number;
}

export class CapacityReservationConflictError extends Error {
  readonly conflicts: CapacityReservationConflict[];

  constructor(conflicts: CapacityReservationConflict[]) {
    super("requested wave capacity is reserved by another run");
    this.name = "CapacityReservationConflictError";
    this.conflicts = conflicts;
  }
}

export interface CapacityReservation {
  runId: string;
  waveId: string;
  requests: Partial<Record<NativeAgentId, number>>;
  acquiredAt: number;
  readonly expiresAt: number;
  readonly renewalIntervalMs: number;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface ReserveWaveInput {
  runId: string;
  waveId: string;
  requests: Partial<Record<NativeAgentId, number>>;
  availableUnits: Record<NativeAgentId, number>;
  signal: AbortSignal;
}

export interface CapacityReservationSnapshot {
  active: number;
  reservedUnits: Record<NativeAgentId, number>;
  reservations: Array<{
    runId: string;
    waveId: string;
    requests: Partial<Record<NativeAgentId, number>>;
    acquiredAt: number;
    expiresAt: number;
  }>;
}

export interface CapacityReservationManager {
  reserveWave(input: ReserveWaveInput): Promise<CapacityReservation>;
  releaseRun(runId: string): Promise<void>;
  snapshot(): CapacityReservationSnapshot;
  shutdown(): Promise<void>;
}

interface ActiveReservation {
  token: symbol;
  key: string;
  requestFingerprint: string;
  signal: AbortSignal;
  abortListener: () => void;
  handle: CapacityReservation;
}

function abortError(): Error {
  return new DOMException("capacity reservation was aborted", "AbortError");
}

function assertIdentifier(value: string, name: string): void {
  if (value.length < 1 || value.length > 200 || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be a bounded non-empty identifier`);
  }
}

function normalizedRequests(
  requests: Partial<Record<NativeAgentId, number>>,
): Partial<Record<NativeAgentId, number>> {
  const keys = Object.keys(requests);
  if (keys.some((key) => !AGENTS.includes(key as NativeAgentId))) {
    throw new Error("capacity requests contain an unknown Agent");
  }
  const normalized: Partial<Record<NativeAgentId, number>> = {};
  for (const agent of AGENTS) {
    const units = requests[agent];
    if (units === undefined || units === 0) continue;
    if (!Number.isSafeInteger(units) || units < 1) {
      throw new Error("capacity reservation units must be positive safe integers");
    }
    normalized[agent] = units;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("capacity reservation must request at least one unit");
  }
  return normalized;
}

function validateAvailableUnits(availableUnits: Record<NativeAgentId, number>): void {
  for (const agent of AGENTS) {
    const units = availableUnits[agent];
    if (!Number.isSafeInteger(units) || units < 0) {
      throw new Error("available capacity units must be nonnegative safe integers");
    }
  }
}

export function createCapacityReservationManager(options: {
  ttlMs?: number;
  now?: () => number;
} = {}): CapacityReservationManager {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error("capacity reservation TTL must be a positive safe integer");
  }
  const now = options.now ?? Date.now;
  const active = new Map<string, ActiveReservation>();
  let shutDown = false;

  const releaseToken = (key: string, token: symbol): void => {
    const current = active.get(key);
    if (!current || current.token !== token) return;
    current.signal.removeEventListener("abort", current.abortListener);
    active.delete(key);
  };

  const cleanupExpired = (): void => {
    const currentTime = now();
    for (const [key, reservation] of active) {
      if (reservation.handle.expiresAt <= currentTime) {
        releaseToken(key, reservation.token);
      }
    }
  };

  const reservedUnits = (excludingKey: string | null = null): Record<NativeAgentId, number> => {
    const totals: Record<NativeAgentId, number> = { claude: 0, codex: 0, grok: 0 };
    for (const reservation of active.values()) {
      if (reservation.key === excludingKey) continue;
      for (const agent of AGENTS) {
        totals[agent] += reservation.handle.requests[agent] ?? 0;
      }
    }
    return totals;
  };

  return {
    async reserveWave(input) {
      if (shutDown) throw new Error("capacity reservation manager is shut down");
      if (input.signal.aborted) throw abortError();
      assertIdentifier(input.runId, "runId");
      assertIdentifier(input.waveId, "waveId");
      const requests = normalizedRequests(input.requests);
      validateAvailableUnits(input.availableUnits);
      cleanupExpired();
      const key = `${input.runId}\0${input.waveId}`;
      const requestFingerprint = JSON.stringify(requests);
      const existing = active.get(key);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new Error("idempotent reservation key was reused with different units");
        }
        return existing.handle;
      }
      const reserved = reservedUnits();
      const conflicts = AGENTS.flatMap((agent): CapacityReservationConflict[] => {
        const requestedUnits = requests[agent] ?? 0;
        const remainingUnits = Math.max(0, input.availableUnits[agent] - reserved[agent]);
        return requestedUnits > remainingUnits ? [{
          agent,
          requestedUnits,
          availableUnits: remainingUnits,
          reservedByOtherRuns: reserved[agent],
        }] : [];
      });
      if (conflicts.length > 0) throw new CapacityReservationConflictError(conflicts);

      const token = Symbol(key);
      const acquiredAt = now();
      let expiresAt = acquiredAt + ttlMs;
      const abortListener = () => releaseToken(key, token);
      let released = false;
      const handle: CapacityReservation = {
        runId: input.runId,
        waveId: input.waveId,
        requests,
        acquiredAt,
        get expiresAt() {
          return expiresAt;
        },
        renewalIntervalMs: Math.max(1, Math.floor(ttlMs / 3)),
        async renew() {
          if (released) throw new Error("capacity reservation was released");
          const current = active.get(key);
          if (!current || current.token !== token) {
            throw new Error("capacity reservation is no longer active or has expired");
          }
          expiresAt = now() + ttlMs;
        },
        async release() {
          if (released) return;
          released = true;
          releaseToken(key, token);
        },
      };
      active.set(key, { token, key, requestFingerprint, signal: input.signal, abortListener, handle });
      input.signal.addEventListener("abort", abortListener, { once: true });
      if (input.signal.aborted) releaseToken(key, token);
      return handle;
    },
    async releaseRun(runId) {
      assertIdentifier(runId, "runId");
      for (const [key, reservation] of [...active]) {
        if (reservation.handle.runId === runId) releaseToken(key, reservation.token);
      }
    },
    snapshot() {
      cleanupExpired();
      return {
        active: active.size,
        reservedUnits: reservedUnits(),
        reservations: [...active.values()].map(({ handle }) => ({
          runId: handle.runId,
          waveId: handle.waveId,
          requests: { ...handle.requests },
          acquiredAt: handle.acquiredAt,
          expiresAt: handle.expiresAt,
        })),
      };
    },
    async shutdown() {
      if (shutDown) return;
      shutDown = true;
      for (const [key, reservation] of [...active]) releaseToken(key, reservation.token);
    },
  };
}
