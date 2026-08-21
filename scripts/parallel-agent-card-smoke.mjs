#!/usr/bin/env node
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const mode = process.argv[2] === "production" ? "production" : "development";
const server = await createServer({ mode, appType: "custom", server: { middlewareMode: true } });
try {
  const { AgentCard } = await server.ssrLoadModule("/src/components/balance/agent-card.tsx");
  const now = Date.now();
  const activeTasks = ["a", "b", "c", "d", "e"].map((id, index) => ({
    sessionId: "parent",
    actorId: `agent-${id}`,
    actorKind: index === 0 ? "workflow-subagent" : "subagent",
    cwd: "/tmp",
    task: `并行任务 ${id}`,
    writing: true,
    lastTs: now - index,
    startedAt: now - 1_000,
    turns: 1,
  }));
  const props = {
    name: "Claude",
    adapter: "runtime-smoke",
    plan: {
      id: "smoke",
      agent: "claude",
      name: "Smoke",
      priceUsd: 0,
      blurb: "",
      windowTokenBudget: 1,
      weekTokenBudget: 1,
      windowReasoningMin: 1,
      weekReasoningMin: 1,
      kind: "subscription",
    },
    meter: {
      agent: "claude",
      windowPct: 1,
      weekPct: 1,
      windowTokens: 0,
      weekTokens: 0,
      windowReasoningMin: 0,
      weekReasoningMin: 0,
      windowBudget: 1,
      weekBudget: 1,
      windowResetsAt: now + 1_000,
      weekResetsAt: now + 1_000,
      burnPctPerHour: 0,
      etaMs: null,
      apiUsdWindow: 0,
      apiUsdWeek: 0,
      status: "ok",
    },
    session: null,
    live: true,
    activeTasks,
    events: [],
    now,
    onToggle() {},
  };
  const liveHtml = renderToStaticMarkup(React.createElement(AgentCard, props));
  assert.match(liveHtml, /并行任务/);
  assert.match(liveHtml, /5 个活跃/);
  assert.match(liveHtml, /另有 1 个任务/);
  assert.match(liveHtml, /并行任务 a/);
  assert.doesNotMatch(liveHtml, /并行任务 e/);
  assert.doesNotMatch(liveHtml, /周限额刷新/);
  const pausedHtml = renderToStaticMarkup(React.createElement(AgentCard, { ...props, live: false }));
  assert.match(pausedHtml, /采集已暂停/);
  assert.doesNotMatch(pausedHtml, /5 个活跃/);
  const resetAt = Date.parse("2026-08-26T20:59:00Z");
  const resetHtml = renderToStaticMarkup(
    React.createElement(AgentCard, {
      ...props,
      weekResetsAt: resetAt,
      now: resetAt - 4 * 24 * 60 * 60 * 1000,
    }),
  );
  assert.match(resetHtml, /周限额刷新/);
  const fableHtml = renderToStaticMarkup(
    React.createElement(AgentCard, {
      ...props,
      weekResetsAt: resetAt,
      modelWeekLimit: {
        model: "fable",
        limitPctOfWeek: 50,
        usedPct: 24,
        resetsAt: resetAt,
      },
      now: resetAt - 4 * 24 * 60 * 60 * 1000,
    }),
  );
  assert.match(fableHtml, /周限额刷新/);
  assert.doesNotMatch(fableHtml, /Fable 5 周限额刷新/);
  process.stdout.write(`parallel-agent-card-smoke mode=${mode} ok\n`);
} finally {
  await server.close();
}
