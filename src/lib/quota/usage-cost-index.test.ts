import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUsageCostIndex,
  deduplicateUsageEvents,
  observeIndexedWindow,
} from "./usage-cost-index.ts";
import { eventsInWindow, observeWindow } from "./quota-value.ts";
import type { UsageEvent } from "./types.ts";
import type { UsageAgentId } from "./types.ts";

// ---------------------------------------------------------------------------
// deterministic pseudo-random generator (xorshift32, fixed seed)
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function pickOne<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// ---------------------------------------------------------------------------
// fixture: 500 events with edge cases for parity checking
// ---------------------------------------------------------------------------
const AGENTS: UsageAgentId[] = ["claude", "grok", "codex"];

// Models with known pricing (modelRaw values the pricing table resolves)
const KNOWN_MODELS: { agent: UsageAgentId; model: string; modelRaw: string }[] = [
  { agent: "claude", model: "opus", modelRaw: "claude-opus-5" },
  { agent: "claude", model: "sonnet", modelRaw: "claude-sonnet-4-20250514" },
  { agent: "codex", model: "gpt-5.4", modelRaw: "gpt-5.4" },
  { agent: "codex", model: "gpt-5.4-mini", modelRaw: "gpt-5.4-mini" },
  { agent: "grok", model: "grok-4.6", modelRaw: "grok-4.6" },
];

// Some unknown models (no pricing match -> cost=0)
const UNKNOWN_MODELS: { agent: UsageAgentId; model: string; modelRaw: string }[] = [
  { agent: "claude", model: "haiku", modelRaw: "unknown-model-xyz" },
  { agent: "codex", model: "gpt-5.4", modelRaw: "" },
];

function generateEvents(rng: () => number): UsageEvent[] {
  const events: UsageEvent[] = [];
  const baseTs = 1_000_000;

  for (let i = 0; i < 500; i++) {
    const modelSpec = rng() < 0.85
      ? pickOne(rng, KNOWN_MODELS)
      : pickOne(rng, UNKNOWN_MODELS);

    const hasCacheWriteUnsplit = rng() < 0.08;
    const hasImageInput = rng() < 0.1;
    const hasImageOutput = rng() < 0.05;
    const isFast = rng() < 0.15;
    const hasAnomaly = rng() < 0.05;

    const event: UsageEvent = {
      id: `evt-${i}`,
      agent: modelSpec.agent,
      model: modelSpec.model as UsageEvent["model"],
      modelRaw: modelSpec.modelRaw,
      ts: baseTs + i * 1000 + Math.floor(rng() * 500),
      sessionId: `session-${Math.floor(rng() * 10)}`,
      task: "test-task",
      tokensIn: Math.floor(rng() * 2000),
      tokensOut: Math.floor(rng() * 1000),
      cacheRead: Math.floor(rng() * 500),
      cacheWrite: Math.floor(rng() * 300),
      cacheWrite1h: rng() < 0.3 ? Math.floor(rng() * 100) : undefined,
      cacheWriteUnsplit: hasCacheWriteUnsplit ? true : undefined,
      imageInputTokens: hasImageInput ? Math.floor(rng() * 200) : undefined,
      imageOutputTokens: hasImageOutput ? Math.floor(rng() * 50) : undefined,
      reasoningMin: 0,
      speed: isFast ? "fast" : "standard",
      anomalies: hasAnomaly
        ? [{ code: "negative-token" as const, field: "output_tokens", rawValue: "-1" }]
        : undefined,
    };
    events.push(event);
  }

  // Edge case: duplicate ids across different timestamps.
  // "first occurrence in input array wins" is the dedup rule.
  // Create 20 events whose id appeared earlier, but with different timestamps
  // so some land outside a window while the original is inside, and vice versa.
  for (let d = 0; d < 20; d++) {
    const sourceIdx = Math.floor(rng() * 400);
    const source = events[sourceIdx]!;
    const dup: UsageEvent = {
      ...source,
      // Same agent+id, different ts — the dedup must keep only the first occurrence
      ts: source.ts + (rng() < 0.5 ? -50_000 : 50_000),
      tokensIn: source.tokensIn + 999, // different tokens to make a visible difference if dedup fails
    };
    events.push(dup);
  }

  return events;
}

function generateWindows(rng: () => number, events: UsageEvent[]): { agent: UsageAgentId; start: number; end: number }[] {
  const windows: { agent: UsageAgentId; start: number; end: number }[] = [];
  const baseTs = 1_000_000;
  const maxTs = baseTs + 520 * 1000;

  for (let w = 0; w < 100; w++) {
    const agent = pickOne(rng, AGENTS);
    const start = baseTs + Math.floor(rng() * (maxTs - baseTs) * 0.7);
    const span = 20_000 + Math.floor(rng() * 200_000);
    windows.push({ agent, start, end: start + span });
  }

  return windows;
}

// ---------------------------------------------------------------------------
// tolerance helpers
// ---------------------------------------------------------------------------
const TOLERANCE = 1e-9;

function nearEqual(a: number, b: number, label: string) {
  const diff = Math.abs(a - b);
  if (diff > TOLERANCE) {
    assert.fail(
      `${label}: ${a} vs ${b}, diff=${diff} exceeds tolerance ${TOLERANCE}`,
    );
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("deduplicateUsageEvents keeps first occurrence per (agent,id)", () => {
  const events: UsageEvent[] = [
    {
      id: "a", agent: "claude", model: "opus", modelRaw: "claude-opus-5",
      ts: 100, sessionId: "s", task: "t", tokensIn: 10, tokensOut: 5,
      cacheRead: 0, cacheWrite: 0, reasoningMin: 0,
    },
    {
      id: "a", agent: "claude", model: "opus", modelRaw: "claude-opus-5",
      ts: 200, sessionId: "s", task: "t", tokensIn: 999, tokensOut: 5,
      cacheRead: 0, cacheWrite: 0, reasoningMin: 0,
    },
    {
      id: "a", agent: "grok", model: "grok-4.6", modelRaw: "grok-4.6",
      ts: 150, sessionId: "s", task: "t", tokensIn: 50, tokensOut: 5,
      cacheRead: 0, cacheWrite: 0, reasoningMin: 0,
    },
  ];
  const deduped = deduplicateUsageEvents(events);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]!.tokensIn, 10); // first claude:a kept
  assert.equal(deduped[1]!.agent, "grok"); // grok:a is different agent, kept
});

test("indexed window parity with direct path across 100 windows", () => {
  const rng = makeRng(42);
  const events = generateEvents(rng);
  const windows = generateWindows(rng, events);
  const index = buildUsageCostIndex(events);

  for (let w = 0; w < windows.length; w++) {
    const { agent, start, end } = windows[w]!;
    const indexed = observeIndexedWindow(index, agent, start, end);
    const direct = observeWindow(eventsInWindow(events, agent, start, end));

    const label = `window[${w}] agent=${agent} [${start},${end}]`;
    nearEqual(indexed.observedUsd, direct.observedUsd, `${label} observedUsd`);
    nearEqual(indexed.observedTokens, direct.observedTokens, `${label} observedTokens`);
    nearEqual(indexed.pricedTokens, direct.pricedTokens, `${label} pricedTokens`);
    nearEqual(indexed.pricedEvents, direct.pricedEvents, `${label} pricedEvents`);
    nearEqual(
      indexed.pricedTokenCoverage,
      direct.pricedTokenCoverage,
      `${label} pricedTokenCoverage`,
    );
    nearEqual(
      indexed.pricedEventCoverage,
      direct.pricedEventCoverage,
      `${label} pricedEventCoverage`,
    );

    // modelMix keys must match
    const indexedKeys = Object.keys(indexed.modelMix).sort();
    const directKeys = Object.keys(direct.modelMix).sort();
    assert.deepStrictEqual(
      indexedKeys,
      directKeys,
      `${label} modelMix keys differ`,
    );
    for (const key of indexedKeys) {
      nearEqual(
        indexed.modelMix[key]!,
        direct.modelMix[key]!,
        `${label} modelMix[${key}]`,
      );
    }
  }
});

test("eventsInWindow uses (agent,id) dedup consistent with index", () => {
  // Create events where same (agent,id) appears twice with different timestamps
  // First occurrence is outside the window, second is inside
  const events: UsageEvent[] = [
    {
      id: "dup1", agent: "claude", model: "opus", modelRaw: "claude-opus-5",
      ts: 100, sessionId: "s", task: "t", tokensIn: 10, tokensOut: 5,
      cacheRead: 0, cacheWrite: 0, reasoningMin: 0,
    },
    {
      id: "dup1", agent: "claude", model: "opus", modelRaw: "claude-opus-5",
      ts: 500, sessionId: "s", task: "t", tokensIn: 999, tokensOut: 5,
      cacheRead: 0, cacheWrite: 0, reasoningMin: 0,
    },
  ];
  // Window [400, 600] — direct path should NOT include dup1 because the first
  // occurrence (ts=100) is outside and dedup keeps only first-seen.
  const windowed = eventsInWindow(events, "claude", 400, 600);
  // Under the new (agent,id) first-occurrence dedup, the first occurrence at
  // ts=100 is the canonical one; its ts is outside [400,600], so the window
  // should contain 0 events.
  assert.equal(windowed.length, 0);
});
