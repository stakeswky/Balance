import type { AgentId, ModelId, UsageEvent } from "./types";

function asModel(raw: string, agent: AgentId): ModelId {
  const s = raw.toLowerCase();
  if (agent === "claude") {
    if (s.includes("opus")) return "opus";
    if (s.includes("haiku")) return "haiku";
    return "sonnet";
  }
  if (s.includes("mini")) return "gpt-5-codex-mini";
  if (s.includes("5.4") || s.includes("o3")) return "gpt-5.4";
  return "gpt-5.3-codex";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseOne(raw: unknown, fallbackAgent: AgentId, index: number): UsageEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const msg = (o.message ?? o) as Record<string, unknown>;
  const usage = (o.usage ?? msg.usage ?? o.token_usage ?? {}) as Record<string, unknown>;

  const agentRaw = String(o.agent ?? o.source ?? fallbackAgent).toLowerCase();
  const agent: AgentId = agentRaw.includes("codex") || agentRaw.includes("openai") ? "codex" : "claude";

  const modelRaw = String(o.model ?? msg.model ?? (agent === "claude" ? "sonnet" : "gpt-5.3-codex"));
  const tsRaw = o.timestamp ?? o.ts ?? o.created_at ?? Date.now();
  const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw));
  if (!Number.isFinite(ts)) return null;

  const tokensIn = num(usage.input_tokens ?? usage.prompt_tokens ?? usage.tokensIn ?? o.tokensIn);
  const tokensOut = num(usage.output_tokens ?? usage.completion_tokens ?? usage.tokensOut ?? o.tokensOut);
  const cacheRead = num(usage.cache_read_input_tokens ?? usage.cache_read ?? o.cacheRead);
  const cacheWrite = num(usage.cache_creation_input_tokens ?? usage.cache_write ?? o.cacheWrite);
  const reasoningMin = num(usage.reasoning_minutes ?? o.reasoningMin ?? o.reasoning_minutes);

  if (tokensIn + tokensOut + cacheRead + cacheWrite + reasoningMin <= 0) return null;

  return {
    id: String(o.id ?? `imp_${ts}_${index}`),
    agent,
    model: asModel(modelRaw, agent),
    ts,
    sessionId: String(o.session_id ?? o.sessionId ?? o.conversation_id ?? `imp_sess_${index}`),
    task: String(o.task ?? o.cwd ?? o.prompt ?? "导入会话"),
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    reasoningMin,
  };
}

export function parseUsagePayload(text: string, fallbackAgent: AgentId = "claude"): UsageEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const events: UsageEvent[] = [];

  const tryJson = (blob: string) => {
    try {
      const data = JSON.parse(blob) as unknown;
      if (Array.isArray(data)) {
        data.forEach((row, i) => {
          const ev = parseOne(row, fallbackAgent, i);
          if (ev) events.push(ev);
        });
        return true;
      }
      if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        const list = (obj.events ?? obj.usage ?? obj.data) as unknown;
        if (Array.isArray(list)) {
          list.forEach((row, i) => {
            const ev = parseOne(row, fallbackAgent, i);
            if (ev) events.push(ev);
          });
          return true;
        }
        const ev = parseOne(data, fallbackAgent, 0);
        if (ev) {
          events.push(ev);
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  };

  if (tryJson(trimmed)) return events;

  trimmed.split(/\n+/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const ev = parseOne(JSON.parse(t), fallbackAgent, i);
      if (ev) events.push(ev);
    } catch {
      /* skip junk line */
    }
  });

  return events.sort((a, b) => a.ts - b.ts);
}
