import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, MODEL_META, planById } from "./plans";
import type {
  AgentId,
  MeterSnapshot,
  ModelId,
  ModelShare,
  PlanDef,
  UsageEvent,
} from "./types";
import { WEEK_MS, WINDOW_MS } from "./types";

export function weightedTokens(event: UsageEvent): number {
  const meta = MODEL_META[event.model];
  const raw =
    event.tokensIn +
    event.tokensOut +
    event.cacheRead * CACHE_READ_FACTOR +
    event.cacheWrite * CACHE_WRITE_FACTOR;
  return raw * meta.weight;
}

export function rawTokens(event: UsageEvent): number {
  return event.tokensIn + event.tokensOut + event.cacheRead + event.cacheWrite;
}

export function apiUsd(event: UsageEvent): number {
  const meta = MODEL_META[event.model];
  const inTok = event.tokensIn + event.cacheWrite * CACHE_WRITE_FACTOR + event.cacheRead * CACHE_READ_FACTOR;
  return (inTok / 1_000_000) * meta.inPerM + (event.tokensOut / 1_000_000) * meta.outPerM;
}

export function inWindow(events: UsageEvent[], now: number, span: number, agent?: AgentId) {
  const from = now - span;
  return events.filter((e) => e.ts >= from && e.ts <= now && (agent ? e.agent === agent : true));
}

function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(140, n));
}

export function eventWindowShare(event: UsageEvent, plan: PlanDef): number {
  if (plan.agent === "codex" && plan.windowReasoningMin > 0) {
    const reason = (event.reasoningMin / plan.windowReasoningMin) * 100;
    const tok = (weightedTokens(event) / plan.windowTokenBudget) * 100;
    return reason * 0.72 + tok * 0.28;
  }
  return (weightedTokens(event) / plan.windowTokenBudget) * 100;
}

export function eventWeekShare(event: UsageEvent, plan: PlanDef, boostPct: number): number {
  const boost = 1 + Math.max(0, boostPct) / 100;
  if (plan.agent === "codex" && plan.weekReasoningMin > 0) {
    const reason = (event.reasoningMin / (plan.weekReasoningMin * boost)) * 100;
    const tok = (weightedTokens(event) / (plan.weekTokenBudget * boost)) * 100;
    return reason * 0.72 + tok * 0.28;
  }
  return (weightedTokens(event) / (plan.weekTokenBudget * boost)) * 100;
}

export function meterFor(
  events: UsageEvent[],
  agent: AgentId,
  plan: PlanDef,
  now: number,
  boostPct: number,
): MeterSnapshot {
  const win = inWindow(events, now, WINDOW_MS, agent);
  const week = inWindow(events, now, WEEK_MS, agent);
  const windowPct = clampPct(win.reduce((s, e) => s + eventWindowShare(e, plan), 0));
  const weekPct = clampPct(week.reduce((s, e) => s + eventWeekShare(e, plan, boostPct), 0));
  const windowTokens = win.reduce((s, e) => s + rawTokens(e), 0);
  const weekTokens = week.reduce((s, e) => s + rawTokens(e), 0);
  const windowReasoningMin = win.reduce((s, e) => s + e.reasoningMin, 0);
  const weekReasoningMin = week.reduce((s, e) => s + e.reasoningMin, 0);

  const recent = win.filter((e) => e.ts >= now - 45 * 60 * 1000);
  const recentPct = recent.reduce((s, e) => s + eventWindowShare(e, plan), 0);
  const burnPctPerHour = recent.length ? (recentPct / 45) * 60 : 0;

  const remain = Math.max(0, 100 - windowPct);
  const etaMs = burnPctPerHour > 0.4 ? (remain / burnPctPerHour) * 60 * 60 * 1000 : null;

  let status: MeterSnapshot["status"] = "ok";
  if (windowPct >= 88 || weekPct >= 88) status = "critical";
  else if (windowPct >= 68 || weekPct >= 72) status = "watch";

  const oldest = win.reduce((min, e) => Math.min(min, e.ts), now);
  const windowResetsAt = win.length ? oldest + WINDOW_MS : now + WINDOW_MS;

  return {
    agent,
    windowPct,
    weekPct,
    windowTokens,
    weekTokens,
    windowReasoningMin,
    weekReasoningMin,
    windowBudget: plan.windowTokenBudget,
    weekBudget: plan.weekTokenBudget * (1 + Math.max(0, boostPct) / 100),
    windowResetsAt,
    weekResetsAt: now - (now % (24 * 60 * 60 * 1000)) + WEEK_MS,
    burnPctPerHour,
    etaMs,
    apiUsdWindow: win.reduce((s, e) => s + apiUsd(e), 0),
    apiUsdWeek: week.reduce((s, e) => s + apiUsd(e), 0),
    status,
  };
}

export function modelShares(events: UsageEvent[], agent: AgentId, now: number, span: number): ModelShare[] {
  const slice = inWindow(events, now, span, agent);
  const byModel = new Map<ModelId, { tokens: number; events: number }>();
  let total = 0;
  for (const e of slice) {
    const t = rawTokens(e);
    total += t;
    const cur = byModel.get(e.model) ?? { tokens: 0, events: 0 };
    cur.tokens += t;
    cur.events += 1;
    byModel.set(e.model, cur);
  }
  return [...byModel.entries()]
    .map(([model, v]) => ({
      model,
      tokens: v.tokens,
      events: v.events,
      pct: total ? (v.tokens / total) * 100 : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function hourlySeries(events: UsageEvent[], now: number, hours: number) {
  const buckets: { t: number; claude: number; codex: number; label: string }[] = [];
  const hour = 60 * 60 * 1000;
  for (let i = hours - 1; i >= 0; i--) {
    const end = now - i * hour;
    const start = end - hour;
    const slice = events.filter((e) => e.ts > start && e.ts <= end);
    const claude = slice.filter((e) => e.agent === "claude").reduce((s, e) => s + rawTokens(e), 0);
    const codex = slice.filter((e) => e.agent === "codex").reduce((s, e) => s + rawTokens(e), 0);
    const d = new Date(end);
    buckets.push({
      t: end,
      claude,
      codex,
      label: `${d.getHours().toString().padStart(2, "0")}:00`,
    });
  }
  return buckets;
}

export function dailySeries(events: UsageEvent[], now: number, days: number) {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const origin = startOfToday.getTime();
  const buckets: { t: number; label: string; claude: number; codex: number; total: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = origin - i * day;
    const end = start + day;
    const slice = events.filter((e) => e.ts >= start && e.ts < end);
    const claude = slice.filter((e) => e.agent === "claude").reduce((s, e) => s + rawTokens(e), 0);
    const codex = slice.filter((e) => e.agent === "codex").reduce((s, e) => s + rawTokens(e), 0);
    const d = new Date(start);
    buckets.push({
      t: start,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      claude,
      codex,
      total: claude + codex,
    });
  }
  return buckets;
}

export interface SessionGroup {
  id: string;
  agent: AgentId;
  task: string;
  model: ModelId;
  start: number;
  end: number;
  events: number;
  tokens: number;
  weighted: number;
  reasoningMin: number;
  usd: number;
}

export function groupSessions(events: UsageEvent[], now: number, span: number): SessionGroup[] {
  const slice = inWindow(events, now, span);
  const map = new Map<string, SessionGroup>();
  for (const e of slice) {
    const cur = map.get(e.sessionId);
    if (!cur) {
      map.set(e.sessionId, {
        id: e.sessionId,
        agent: e.agent,
        task: e.task,
        model: e.model,
        start: e.ts,
        end: e.ts,
        events: 1,
        tokens: rawTokens(e),
        weighted: weightedTokens(e),
        reasoningMin: e.reasoningMin,
        usd: apiUsd(e),
      });
    } else {
      cur.start = Math.min(cur.start, e.ts);
      cur.end = Math.max(cur.end, e.ts);
      cur.events += 1;
      cur.tokens += rawTokens(e);
      cur.weighted += weightedTokens(e);
      cur.reasoningMin += e.reasoningMin;
      cur.usd += apiUsd(e);
    }
  }
  return [...map.values()].sort((a, b) => b.end - a.end);
}

export function comparePlans(
  events: UsageEvent[],
  agent: AgentId,
  plans: PlanDef[],
  now: number,
  boostPct: number,
) {
  return plans.map((plan) => {
    const meter = meterFor(events, agent, plan, now, boostPct);
    return {
      plan,
      windowPct: meter.windowPct,
      weekPct: meter.weekPct,
      status: meter.status,
    };
  });
}

export function routingAdvice(claude: MeterSnapshot, codex: MeterSnapshot) {
  const tips: { title: string; body: string }[] = [];
  if (claude.windowPct >= 68) {
    tips.push({
      title: "Claude 切到 Sonnet / Haiku",
      body: "窗口已过警戒。简单改文件用 Haiku，重重构再开 Opus，能把窗消耗压到约五分之一。",
    });
  }
  if (codex.windowPct >= 68) {
    tips.push({
      title: "Codex 降推理档",
      body: "Plus 窗按推理分钟计。短任务用 Codex Mini，避免 GPT-5.4 长思考把五小时窗吃光。",
    });
  }
  if (claude.windowPct < 40 && codex.windowPct >= 70) {
    tips.push({
      title: "把重活交给 Claude",
      body: "Claude 窗口还松。长重构先走 Claude Code，Codex 留审查和补测试。",
    });
  }
  if (codex.windowPct < 40 && claude.windowPct >= 70) {
    tips.push({
      title: "把重活交给 Codex",
      body: "Claude 先碰到上限。生成样板、补测试交给 Codex，把 Opus 留给难的设计。",
    });
  }
  if (!tips.length) {
    tips.push({
      title: "双开节奏正常",
      body: "两边窗口都还宽裕。保持现在的模型组合即可，不必为了省额度降智。",
    });
  }
  return tips.slice(0, 3);
}

export function eventsToCsv(events: UsageEvent[]): string {
  const header = [
    "ts",
    "agent",
    "model",
    "session",
    "task",
    "tokens_in",
    "tokens_out",
    "cache_read",
    "cache_write",
    "reasoning_min",
  ];
  const rows = events.map((e) =>
    [
      new Date(e.ts).toISOString(),
      e.agent,
      e.model,
      e.sessionId,
      `"${e.task.replaceAll('"', '""')}"`,
      e.tokensIn,
      e.tokensOut,
      e.cacheRead,
      e.cacheWrite,
      e.reasoningMin.toFixed(2),
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toString();
}

export function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}

export function formatPct(n: number): string {
  return `${Math.min(100, n).toFixed(n >= 10 ? 0 : 1)}%`;
}

export function resolvePlans(claudePlanId: string, codexPlanId: string) {
  return { claude: planById(claudePlanId), codex: planById(codexPlanId) };
}
