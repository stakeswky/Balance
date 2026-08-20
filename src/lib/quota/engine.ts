import { costBreakdown, eventRawTokens } from "./cost.ts";
import { modelDisplayLabel } from "./model-label.ts";
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, MODEL_META, planById } from "./plans.ts";
import type { OfficialSlice } from "./official.ts";
import type {
  AgentId,
  MeterSnapshot,
  ModelId,
  ModelWeekLimitSnapshot,
  ModelShare,
  PlanDef,
  UsageEvent,
} from "./types.ts";
import { WEEK_MS, WINDOW_MS } from "./types.ts";

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
  return eventRawTokens(event);
}

export function apiUsd(event: UsageEvent): number {
  return costBreakdown(event).totalUsd;
}

export function inWindow(events: UsageEvent[], now: number, span: number, agent?: AgentId) {
  const from = now - span;
  return events.filter((e) => e.ts >= from && e.ts <= now && (agent ? e.agent === agent : true));
}

function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(140, n));
}

function meterStatus(windowPct: number, weekPct: number): MeterSnapshot["status"] {
  if (windowPct >= 88 || weekPct >= 88) return "critical";
  if (windowPct >= 68 || weekPct >= 72) return "watch";
  return "ok";
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

export function modelWeekLimitFor(
  plan: PlanDef,
  official: OfficialSlice | null | undefined,
  model: ModelId,
): ModelWeekLimitSnapshot | null {
  const limitPctOfWeek = plan.modelWeekLimitPct?.[model];
  const observed = official?.modelWeekLimits?.[model];
  if (limitPctOfWeek == null || limitPctOfWeek <= 0 || !observed) return null;
  return {
    model,
    limitPctOfWeek,
    usedPct: Math.max(0, Math.min(100, observed.usedPct)),
    resetsAt: observed.resetsAt,
  };
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
    status: meterStatus(windowPct, weekPct),
  };
}

export function applyOfficial(meter: MeterSnapshot, official: OfficialSlice | null | undefined): MeterSnapshot {
  if (!official) return meter;
  let windowPct = meter.windowPct;
  let weekPct = meter.weekPct;
  let burnPctPerHour = meter.burnPctPerHour;
  let windowResetsAt = meter.windowResetsAt;
  let weekResetsAt = meter.weekResetsAt;
  if (official.windowKind === "weekly") {
    if (official.weekPct != null) {
      weekPct = official.weekPct;
    }
    if (official.weekResetsAt) {
      weekResetsAt = official.weekResetsAt;
    }
    burnPctPerHour = official.burnPctPerHour;
  } else {
    if (official.windowPct != null) windowPct = official.windowPct;
    if (official.weekPct != null) weekPct = official.weekPct;
    if (official.windowResetsAt) windowResetsAt = official.windowResetsAt;
    if (official.weekResetsAt) weekResetsAt = official.weekResetsAt;
    if (official.burnPctPerHour > 0) burnPctPerHour = official.burnPctPerHour;
  }
  const remain = Math.max(0, 100 - windowPct);
  const etaMs = burnPctPerHour > 0.4 ? (remain / burnPctPerHour) * 60 * 60 * 1000 : null;
  return {
    ...meter,
    windowPct,
    weekPct,
    windowResetsAt,
    weekResetsAt,
    burnPctPerHour,
    etaMs,
    status: meterStatus(windowPct, weekPct),
  };
}

export function modelShares(events: UsageEvent[], agent: AgentId, now: number, span: number): ModelShare[] {
  const slice = inWindow(events, now, span, agent);
  const byLabel = new Map<string, { model: ModelId; tokens: number; events: number }>();
  let total = 0;
  for (const e of slice) {
    const t = rawTokens(e);
    total += t;
    const label = modelDisplayLabel(e.modelRaw, e.model);
    const cur = byLabel.get(label) ?? { model: e.model, tokens: 0, events: 0 };
    cur.tokens += t;
    cur.events += 1;
    byLabel.set(label, cur);
  }
  return [...byLabel.entries()]
    .map(([label, v]) => ({
      model: v.model,
      label,
      tokens: v.tokens,
      events: v.events,
      pct: total ? (v.tokens / total) * 100 : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function hourlySeries(events: UsageEvent[], now: number, hours: number) {
  const buckets: { t: number; claude: number; grok: number; codex: number; label: string }[] = [];
  const hour = 60 * 60 * 1000;
  for (let i = hours - 1; i >= 0; i--) {
    const end = now - i * hour;
    const start = end - hour;
    const slice = events.filter((e) => e.ts > start && e.ts <= end);
    const claude = slice.filter((e) => e.agent === "claude").reduce((s, e) => s + rawTokens(e), 0);
    const grok = slice.filter((e) => e.agent === "grok").reduce((s, e) => s + rawTokens(e), 0);
    const codex = slice.filter((e) => e.agent === "codex").reduce((s, e) => s + rawTokens(e), 0);
    const d = new Date(end);
    buckets.push({
      t: end,
      claude,
      grok,
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
  const buckets: { t: number; label: string; claude: number; grok: number; codex: number; total: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = origin - i * day;
    const end = start + day;
    const slice = events.filter((e) => e.ts >= start && e.ts < end);
    const claude = slice.filter((e) => e.agent === "claude").reduce((s, e) => s + rawTokens(e), 0);
    const grok = slice.filter((e) => e.agent === "grok").reduce((s, e) => s + rawTokens(e), 0);
    const codex = slice.filter((e) => e.agent === "codex").reduce((s, e) => s + rawTokens(e), 0);
    const d = new Date(start);
    buckets.push({
      t: start,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      claude,
      grok,
      codex,
      total: claude + grok + codex,
    });
  }
  return buckets;
}

export interface SessionGroup {
  id: string;
  agent: AgentId;
  task: string;
  model: ModelId;
  modelRaw?: string;
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
        modelRaw: e.modelRaw,
        start: e.ts,
        end: e.ts,
        events: 1,
        tokens: rawTokens(e),
        weighted: weightedTokens(e),
        reasoningMin: e.reasoningMin,
        usd: apiUsd(e),
      });
    } else {
      if (e.ts >= cur.end) {
        cur.model = e.model;
        cur.modelRaw = e.modelRaw;
      }
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

export interface PlanComparisonBaseline {
  currentPlanId: string;
  currentMeter: MeterSnapshot;
}

export interface PlanComparisonRow {
  plan: PlanDef;
  windowPct: number;
  weekPct: number;
  status: MeterSnapshot["status"];
}

function scaledComparedPct(rawPct: number, baselineRawPct: number, baselineOfficialPct: number): number {
  if (!(baselineRawPct > 0) || !Number.isFinite(baselineOfficialPct)) return rawPct;
  return clampPct(rawPct * (baselineOfficialPct / baselineRawPct));
}

export function comparePlans(
  events: UsageEvent[],
  agent: AgentId,
  plans: PlanDef[],
  now: number,
  boostPct: number,
  baseline?: PlanComparisonBaseline | null,
): PlanComparisonRow[] {
  const currentPlan =
    baseline?.currentMeter.agent === agent
      ? plans.find((plan) => plan.id === baseline.currentPlanId) ?? null
      : null;
  const currentLocal = currentPlan ? meterFor(events, agent, currentPlan, now, boostPct) : null;

  return plans.map((plan) => {
    const meter = meterFor(events, agent, plan, now, boostPct);
    let windowPct = meter.windowPct;
    let weekPct = meter.weekPct;
    if (baseline?.currentMeter.agent === agent && currentPlan && currentLocal) {
      if (plan.id === currentPlan.id) {
        windowPct = baseline.currentMeter.windowPct;
        weekPct = baseline.currentMeter.weekPct;
      } else {
        windowPct = scaledComparedPct(meter.windowPct, currentLocal.windowPct, baseline.currentMeter.windowPct);
        weekPct = scaledComparedPct(meter.weekPct, currentLocal.weekPct, baseline.currentMeter.weekPct);
      }
    }
    return {
      plan,
      windowPct,
      weekPct,
      status: meterStatus(windowPct, weekPct),
    };
  });
}

export function routingAdvice(meters: readonly MeterSnapshot[]) {
  const tips: { title: string; body: string }[] = [];
  const byAgent = new Map(meters.map((meter) => [meter.agent, meter]));
  const load = (agent: AgentId) => {
    const meter = byAgent.get(agent);
    return meter ? Math.max(meter.windowPct, meter.weekPct) : null;
  };
  const claude = byAgent.get("claude");
  const grokLoad = load("grok");
  const codexLoad = load("codex");

  if (claude && claude.windowPct >= 68) {
    tips.push({
      title: "Claude 切到 Sonnet / Haiku",
      body: "窗口已过警戒。简单改文件用 Haiku 4.5，重重构再开 Opus 5。",
    });
  }
  if (grokLoad != null && grokLoad >= 68) {
    tips.push({
      title: "Grok 先歇一轮或换档",
      body: "Grok 窗已经紧。短修补继续用 4.6，长推理等周额度回补。",
    });
  }
  if (codexLoad != null && codexLoad >= 68) {
    tips.push({
      title: "Codex 降到 Terra / Luna",
      body: "周额度已经紧。短任务用 GPT-5.6 Luna，把 Sol 留给难的实现。",
    });
  }

  const strained = meters.some((meter) => Math.max(meter.windowPct, meter.weekPct) >= 70);
  const receiver = meters
    .filter((meter) => Math.max(meter.windowPct, meter.weekPct) < 40)
    .sort(
      (a, b) =>
        Math.max(a.windowPct, a.weekPct) - Math.max(b.windowPct, b.weekPct),
    )[0];
  if (strained && receiver) {
    const name =
      receiver.agent === "claude" ? "Claude" : receiver.agent === "grok" ? "Grok" : "Codex";
    tips.push({
      title: `把重活交给 ${name}`,
      body: `${name} 当前窗口更宽裕，下一趟长任务优先走这一路。`,
    });
  }
  if (!tips.length && meters.length) {
    tips.push({
      title: meters.length === 1 ? "当前 Agent 节奏正常" : `${meters.length} 路节奏正常`,
      body: "可见 Agent 的窗口都还宽裕，保持当前模型组合即可。",
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
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 10_000) return `${sign}$${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${sign}$${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return `${sign}$${v.toFixed(0)}`;
  if (v >= 10) return `${sign}$${v.toFixed(1)}`;
  if (v >= 1) return `${sign}$${v.toFixed(2)}`;
  return `${sign}$${v.toFixed(4)}`;
}

export function formatUsdRange(low: number | null | undefined, high: number | null | undefined): string {
  if (low == null || high == null) return "样本不足";
  return `${formatUsd(low)}–${formatUsd(high)}`;
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
