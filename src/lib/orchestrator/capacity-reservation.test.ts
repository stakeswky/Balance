import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapacityReservationConflictError,
  createCapacityReservationManager,
} from "./capacity-reservation.server.ts";

const AVAILABLE = { claude: 0, codex: 7, grok: 1 } as const;

test("atomically prevents two runs from reserving the same wave capacity", async () => {
  const manager = createCapacityReservationManager({ ttlMs: 60_000 });
  const first = await manager.reserveWave({
    runId: "run-one",
    waveId: "wave-1",
    requests: { codex: 6 },
    availableUnits: AVAILABLE,
    signal: new AbortController().signal,
  });

  await assert.rejects(
    () => manager.reserveWave({
      runId: "run-two",
      waveId: "wave-1",
      requests: { codex: 6 },
      availableUnits: AVAILABLE,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CapacityReservationConflictError);
      assert.deepEqual(error.conflicts, [{
        agent: "codex",
        requestedUnits: 6,
        availableUnits: 1,
        reservedByOtherRuns: 6,
      }]);
      return true;
    },
  );
  assert.deepEqual(manager.snapshot().reservedUnits, { claude: 0, codex: 6, grok: 0 });

  await first.release();
  const second = await manager.reserveWave({
    runId: "run-two",
    waveId: "wave-1",
    requests: { codex: 6 },
    availableUnits: AVAILABLE,
    signal: new AbortController().signal,
  });
  assert.equal(manager.snapshot().active, 1);
  await second.release();
});

test("repeated reserve and release for the same run wave are idempotent", async () => {
  const manager = createCapacityReservationManager({ ttlMs: 60_000 });
  const input = {
    runId: "run-one",
    waveId: "wave-1",
    requests: { codex: 3 },
    availableUnits: AVAILABLE,
    signal: new AbortController().signal,
  };
  const first = await manager.reserveWave(input);
  const repeated = await manager.reserveWave(input);
  assert.equal(first, repeated);
  assert.equal(manager.snapshot().active, 1);
  assert.equal(manager.snapshot().reservedUnits.codex, 3);
  await first.release();
  await repeated.release();
  assert.equal(manager.snapshot().active, 0);
});

test("abort, expiry, releaseRun and shutdown clear reservations safely", async () => {
  let now = 1_000;
  const manager = createCapacityReservationManager({ ttlMs: 50, now: () => now });
  const controller = new AbortController();
  await manager.reserveWave({
    runId: "run-one", waveId: "wave-1", requests: { codex: 1 },
    availableUnits: AVAILABLE, signal: controller.signal,
  });
  controller.abort();
  await Promise.resolve();
  assert.equal(manager.snapshot().active, 0);

  await manager.reserveWave({
    runId: "run-two", waveId: "wave-1", requests: { codex: 1 },
    availableUnits: AVAILABLE, signal: new AbortController().signal,
  });
  now += 51;
  assert.equal(manager.snapshot().active, 0);

  await manager.reserveWave({
    runId: "run-three", waveId: "wave-1", requests: { codex: 1 },
    availableUnits: AVAILABLE, signal: new AbortController().signal,
  });
  await manager.releaseRun("run-three");
  assert.equal(manager.snapshot().active, 0);

  await manager.shutdown();
  assert.equal(manager.snapshot().active, 0);
  await assert.rejects(
    () => manager.reserveWave({
      runId: "run-four", waveId: "wave-1", requests: { codex: 1 },
      availableUnits: AVAILABLE, signal: new AbortController().signal,
    }),
    /shut/i,
  );
  await manager.shutdown();
});

test("rejects invalid units and a changed duplicate request", async () => {
  const manager = createCapacityReservationManager({ ttlMs: 60_000 });
  const signal = new AbortController().signal;
  await assert.rejects(
    () => manager.reserveWave({
      runId: "run-one", waveId: "wave-1", requests: { codex: Number.NaN },
      availableUnits: AVAILABLE, signal,
    }),
    /unit/i,
  );
  await manager.reserveWave({
    runId: "run-one", waveId: "wave-1", requests: { codex: 1 },
    availableUnits: AVAILABLE, signal,
  });
  await assert.rejects(
    () => manager.reserveWave({
      runId: "run-one", waveId: "wave-1", requests: { codex: 2 },
      availableUnits: AVAILABLE, signal,
    }),
    /idempotent|different/i,
  );
});
