import { costBreakdown, eventRawTokens } from "./cost.ts";
import type { UsageAgentId, UsageEvent } from "./types.ts";

export interface WindowObservation {
  observedUsd: number;
  observedTokens: number;
  pricedTokens: number;
  pricedEvents: number;
  modelMix: Record<string, number>;
  pricedTokenCoverage: number;
  pricedEventCoverage: number;
}

interface AgentCostIndex {
  timestamps: number[];
  usd: number[];
  tokens: number[];
  pricedTokens: number[];
  pricedEvents: number[];
  models: Map<string, number[]>;
}

export interface UsageCostIndex {
  agents: Record<UsageAgentId, AgentCostIndex>;
}

const AGENTS: UsageAgentId[] = ["claude", "grok", "codex"];

export function deduplicateUsageEvents(events: UsageEvent[]): UsageEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.agent}\0${event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyAgentIndex(): AgentCostIndex {
  return {
    timestamps: [],
    usd: [0],
    tokens: [0],
    pricedTokens: [0],
    pricedEvents: [0],
    models: new Map(),
  };
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildUsageCostIndex(events: UsageEvent[]): UsageCostIndex {
  const agents = Object.fromEntries(AGENTS.map((agent) => [agent, emptyAgentIndex()])) as Record<
    UsageAgentId,
    AgentCostIndex
  >;
  const uniqueEvents = deduplicateUsageEvents(events);
  for (const agent of AGENTS) {
    const ordered = uniqueEvents
      .filter((event) => event.agent === agent)
      .sort((left, right) => left.ts - right.ts);
    const index = agents[agent];
    const modelKeys = new Set<string>();
    const rows = ordered.map((event) => {
      const cost = costBreakdown(event);
      const key = cost.pricingModel == null
        ? null
        : `${cost.pricingModel}:${event.speed === "fast" ? "fast" : "standard"}`;
      if (key) modelKeys.add(key);
      return { event, cost, key };
    });
    for (const key of modelKeys) index.models.set(key, [0]);
    for (let position = 0; position < rows.length; position += 1) {
      const row = rows[position]!;
      index.timestamps.push(row.event.ts);
      index.usd.push(index.usd[position]! + (row.cost.priced ? row.cost.totalUsd : 0));
      index.tokens.push(index.tokens[position]! + eventRawTokens(row.event));
      index.pricedTokens.push(index.pricedTokens[position]! + row.cost.pricedTokens);
      index.pricedEvents.push(index.pricedEvents[position]! + (row.cost.fullyPriced ? 1 : 0));
      for (const [key, prefix] of index.models) {
        prefix.push(prefix[position]! + (row.key === key ? row.cost.totalUsd : 0));
      }
    }
  }
  return { agents };
}

export function observeIndexedWindow(
  index: UsageCostIndex,
  agent: UsageAgentId,
  start: number,
  end: number,
): WindowObservation {
  const rows = index.agents[agent];
  const left = lowerBound(rows.timestamps, start);
  const right = upperBound(rows.timestamps, end);
  const diff = (prefix: number[]) => prefix[right]! - prefix[left]!;
  const observedUsd = diff(rows.usd);
  const observedTokens = diff(rows.tokens);
  const pricedTokens = diff(rows.pricedTokens);
  const pricedEvents = diff(rows.pricedEvents);
  const eventCount = right - left;
  const modelTotals = [...rows.models.entries()]
    .map(([key, prefix]) => [key, diff(prefix)] as const)
    .filter(([, value]) => value > 0);
  const modelTotal = modelTotals.reduce((sum, [, value]) => sum + value, 0);
  return {
    observedUsd,
    observedTokens,
    pricedTokens,
    pricedEvents,
    modelMix: modelTotal > 0
      ? Object.fromEntries(modelTotals.map(([key, value]) => [key, value / modelTotal]))
      : {},
    pricedTokenCoverage: observedTokens > 0 ? pricedTokens / observedTokens : 1,
    pricedEventCoverage: eventCount > 0 ? pricedEvents / eventCount : 1,
  };
}
