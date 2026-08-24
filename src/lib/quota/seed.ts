import { eventWeekShare, eventWindowShare, inWindow } from "./engine.ts";
import { planById } from "./plans.ts";
import type { ModelId, SessionState, UsageAgentId, UsageEvent } from "./types.ts";
import { WEEK_MS, WINDOW_MS } from "./types.ts";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLAUDE_TASKS = [
  "重构鉴权中间件",
  "补齐 dashboard 类型",
  "拆分 route 组件",
  "修 hydration 不一致",
  "写 PGLite 迁移",
  "扫描依赖漏洞",
  "整理 server function",
  "压测用量计算",
  "接入 ingest 协议",
  "校准 5 小时窗口",
];

const CODEX_TASKS = [
  "生成 API client",
  "补测试夹具",
  "迁移 Zod schema",
  "优化打包配置",
  "整理 eslint 规则",
  "写 ingest 适配器",
  "核对 token 权重",
  "补齐错误边界",
  "导出周报 JSON",
  "同步套餐预设",
];

const GROK_TASKS = [
  "接 Grok 会话日志",
  "校准 turn_completed 用量",
  "三路时间线",
  "写 SuperGrok 套餐",
  "只读轮询 ~/.grok",
  "去重 prompt_id",
  "预览页实机验收",
];

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length)] as T;
}

function id(rng: () => number, prefix: string) {
  return `${prefix}_${Math.floor(rng() * 1e9).toString(36)}${Math.floor(rng() * 1e9).toString(36)}`;
}

function claudeModel(rng: () => number): ModelId {
  const r = rng();
  if (r < 0.18) return "fable";
  if (r < 0.72) return "opus";
  if (r < 0.94) return "sonnet";
  return "haiku";
}

function codexModel(rng: () => number): ModelId {
  const r = rng();
  if (r < 0.55) return "gpt-5.6-sol";
  if (r < 0.85) return "gpt-5.6-terra";
  return "gpt-5.6-luna";
}

function grokModel(rng: () => number): ModelId {
  const r = rng();
  if (r < 0.12) return "grok-4.5";
  return "grok-4.6";
}

function modelRawOf(model: ModelId): string {
  switch (model) {
    case "fable":
      return "claude-fable-5";
    case "opus":
      return "claude-opus-5";
    case "sonnet":
      return "claude-sonnet-5";
    case "haiku":
      return "claude-haiku-4-5";
    case "gpt-5.6-sol":
      return "gpt-5.6-sol";
    case "gpt-5.6-terra":
      return "gpt-5.6-terra";
    case "gpt-5.6-luna":
      return "gpt-5.6-luna";
    case "gpt-5.5":
      return "gpt-5.5";
    case "gpt-5.4":
      return "gpt-5.4";
    case "gpt-5.4-mini":
      return "gpt-5.4-mini";
    case "daybreak-blue":
      return "daybreak-blue";
    case "daybreak-red":
      return "daybreak-red";
    case "grok-4.3":
      return "grok-4.3";
    case "grok-4.20":
      return "grok-4.20";
    case "grok-4.6":
      return "grok-4.6";
    case "grok-4.5":
      return "grok-4.5";
  }
}

function makeEvent(
  rng: () => number,
  agent: UsageAgentId,
  ts: number,
  sessionId: string,
  task: string,
  model: ModelId,
  intensity = 1,
): UsageEvent {
  const modelRaw = modelRawOf(model);
  if (agent === "claude") {
    const heavy = model === "opus";
    const tokensIn = Math.round((heavy ? 24000 : 11000) * (0.7 + rng()) * intensity);
    const tokensOut = Math.round((heavy ? 2800 : 1400) * (0.6 + rng()) * intensity);
    const cacheRead = Math.round((heavy ? 36000 : 14000) * (0.4 + rng()));
    const cacheWrite = Math.round((heavy ? 5000 : 1800) * (0.4 + rng()) * intensity);
    return {
      id: id(rng, "ev"),
      agent,
      model,
      modelRaw,
      ts,
      sessionId,
      task,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
      reasoningMin: 0,
    };
  }
  if (agent === "grok") {
    return {
      id: id(rng, "ev"),
      agent,
      model,
      modelRaw,
      ts,
      sessionId,
      task,
      tokensIn: Math.round(18000 * (0.7 + rng()) * intensity),
      tokensOut: Math.round(2200 * (0.6 + rng()) * intensity),
      cacheRead: Math.round(24000 * (0.4 + rng())),
      cacheWrite: Math.round(900 * rng() * intensity),
      reasoningMin: 0,
    };
  }
  const reasoningMin =
    (model === "gpt-5.6-sol" ? 3.1 : model === "gpt-5.6-terra" ? 1.8 : 0.7) * (0.7 + rng()) * intensity;
  return {
    id: id(rng, "ev"),
    agent,
    model,
    modelRaw,
    ts,
    sessionId,
    task,
    tokensIn: Math.round(6200 * (0.6 + rng()) * intensity),
    tokensOut: Math.round(2100 * (0.5 + rng()) * intensity),
    cacheRead: Math.round(900 * rng()),
    cacheWrite: Math.round(500 * rng()),
    reasoningMin,
  };
}

function fillAgent(
  rng: () => number,
  agent: UsageAgentId,
  now: number,
  windowTarget: number,
  weekTarget: number,
  boostPct: number,
) {
  const plan = planById(
    agent === "claude" ? "claude-max-5x" : agent === "grok" ? "grok-super" : "chatgpt-plus",
  );
  const tasks = agent === "claude" ? CLAUDE_TASKS : agent === "grok" ? GROK_TASKS : CODEX_TASKS;
  const events: UsageEvent[] = [];
  let guard = 0;

  const windowPct = () =>
    inWindow(events, now, WINDOW_MS, agent).reduce((s, e) => s + eventWindowShare(e, plan), 0);
  const weekPct = () =>
    inWindow(events, now, WEEK_MS, agent).reduce((s, e) => s + eventWeekShare(e, plan, boostPct), 0);

  const pushSession = (maxAgeH: number, minAgeH: number, intensity: number) => {
    const ageH = minAgeH + rng() * Math.max(0.05, maxAgeH - minAgeH);
    const started = now - ageH * 3600_000;
    const sessionId = id(rng, agent === "claude" ? "cc" : agent === "grok" ? "gk" : "cx");
    const task = pick(rng, tasks);
    const model = agent === "claude" ? claudeModel(rng) : agent === "grok" ? grokModel(rng) : codexModel(rng);
    const n = 3 + Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      const ts = Math.min(now - 30_000, started + i * (3 + rng() * 8) * 60_000);
      events.push(makeEvent(rng, agent, ts, sessionId, task, model, intensity));
    }
  };

  while (weekPct() < weekTarget && guard < 80) {
    pushSession(96, 8, 0.85);
    guard += 1;
  }
  guard = 0;
  while (windowPct() < windowTarget && guard < 40) {
    pushSession(4.6, 0.08, 1.15);
    guard += 1;
  }
  return events;
}

export function seedHistory(now = Date.now()): UsageEvent[] {
  const day = new Date(now);
  const seed = day.getFullYear() * 10000 + (day.getMonth() + 1) * 100 + day.getDate();
  const rng = mulberry32(seed + 41);
  const events = [
    ...fillAgent(rng, "claude", now, 61, 34, 50),
    ...fillAgent(rng, "grok", now, 48, 30, 50),
    ...fillAgent(rng, "codex", now, 47, 28, 50),
  ];
  return events.sort((a, b) => a.ts - b.ts);
}

export function nextLiveEvent(
  rng: () => number,
  agent: UsageAgentId,
  session: SessionState,
  now: number,
): UsageEvent {
  return makeEvent(rng, agent, now, session.id, session.task, session.model, 0.72);
}

export function newSession(rng: () => number, agent: UsageAgentId, now: number): SessionState {
  const tasks = agent === "claude" ? CLAUDE_TASKS : agent === "grok" ? GROK_TASKS : CODEX_TASKS;
  const model = agent === "claude" ? claudeModel(rng) : agent === "grok" ? grokModel(rng) : codexModel(rng);
  return {
    id: id(rng, agent === "claude" ? "cc" : agent === "grok" ? "gk" : "cx"),
    task: pick(rng, tasks),
    model,
    modelRaw: modelRawOf(model),
    startedAt: now,
    events: 0,
    tokens: 0,
  };
}

export function liveRng() {
  return mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
}

export { CLAUDE_TASKS, CODEX_TASKS };
