import { exclusiveCachedInput, normalizeImageTokens, normalizeToken, optionalModel, usageSpeed } from "./tokens.ts";
import type { ModelId, UsageAgentId, UsageAnomaly, UsageEvent } from "./types.ts";

function asModel(raw: string, agent: UsageAgentId): ModelId {
  const s = raw.toLowerCase();
  if (agent === "claude") {
    if (s.includes("fable") || s.includes("mythos")) return "fable";
    if (s.includes("opus")) return "opus";
    if (s.includes("haiku")) return "haiku";
    return "sonnet";
  }
  if (agent === "grok") {
    if (s.includes("4.20")) return "grok-4.20";
    if (s.includes("4.6")) return "grok-4.6";
    if (s.includes("4.5")) return "grok-4.5";
    if (s.includes("4.3")) return "grok-4.3";
    return "grok-4.6";
  }
  if (s.includes("daybreak-red")) return "daybreak-red";
  if (s.includes("daybreak-blue")) return "daybreak-blue";
  if (s.includes("5.4-mini")) return "gpt-5.4-mini";
  if (s.includes("5.5")) return "gpt-5.5";
  if (s.includes("luna") || s.includes("mini") || s.includes("spark")) return "gpt-5.6-luna";
  if (s.includes("terra")) return "gpt-5.6-terra";
  if (s.includes("sol") || s.includes("5.6")) return "gpt-5.6-sol";
  if (s.includes("5.4") || s.includes("o3")) return "gpt-5.4";
  return "gpt-5.6-sol";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseOne(raw: unknown, fallbackAgent: UsageAgentId, index: number): UsageEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const msg = (o.message ?? o) as Record<string, unknown>;
  const usage = (o.usage ?? msg.usage ?? o.token_usage ?? {}) as Record<string, unknown>;

  const agentRaw = String(o.agent ?? o.source ?? fallbackAgent).toLowerCase();
  const agent: UsageAgentId = agentRaw.includes("grok") || agentRaw.includes("xai")
    ? "grok"
    : agentRaw.includes("codex") || agentRaw.includes("openai")
      ? "codex"
      : "claude";

  const modelRaw = optionalModel(o.model ?? msg.model);
  const tsRaw = o.timestamp ?? o.ts ?? o.created_at ?? Date.now();
  const tsNum = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw));
  const ts = Number.isFinite(tsNum) ? (tsNum > 0 && tsNum < 1e12 ? tsNum * 1000 : tsNum) : NaN;
  if (!Number.isFinite(ts)) return null;

  const inputRaw = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.tokensIn ?? o.tokensIn;
  const cachedRaw = usage.cache_read_input_tokens ?? usage.cache_read ?? usage.cachedReadTokens
    ?? usage.cacheRead ?? o.cacheRead;
  const output = normalizeToken(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.tokensOut ?? o.tokensOut,
    "output_tokens",
  );
  const write = normalizeToken(
    usage.cache_creation_input_tokens ?? usage.cache_write ?? usage.cacheCreationTokens
      ?? usage.cacheWrite ?? o.cacheWrite,
    "cache_creation_input_tokens",
  );
  const input = normalizeToken(inputRaw, "input_tokens");
  const cached = normalizeToken(cachedRaw, "cached_input_tokens");
  const split = agent === "codex" || agent === "grok"
    ? exclusiveCachedInput(inputRaw, cachedRaw)
    : {
        uncachedInputTokens: input.value,
        cacheReadTokens: cached.value,
        cachedExceedsInput: false,
        anomalies: [...input.anomalies, ...cached.anomalies],
      };
  const images = normalizeImageTokens(
    usage.image_input_tokens ?? usage.imageInputTokens
      ?? o.image_input_tokens ?? o.imageInputTokens,
    usage.image_output_tokens ?? usage.imageOutputTokens
      ?? o.image_output_tokens ?? o.imageOutputTokens,
  );
  const anomalies: UsageAnomaly[] = [
    ...split.anomalies,
    ...output.anomalies,
    ...write.anomalies,
    ...images.anomalies,
  ];
  const tokensIn = split.uncachedInputTokens;
  const tokensOut = output.value;
  const cacheRead = split.cacheReadTokens;
  const cacheWrite = write.value;
  const reasoningMin = num(usage.reasoning_minutes ?? o.reasoningMin ?? o.reasoning_minutes);
  const speed = usageSpeed(usage.speed ?? o.speed);

  if (
    tokensIn + tokensOut + cacheRead + cacheWrite + reasoningMin
      + images.imageInputTokens + images.imageOutputTokens <= 0
    && anomalies.length === 0
  ) return null;

  return {
    id: String(o.id ?? `imp_${ts}_${index}`),
    agent,
    model: asModel(modelRaw ?? "", agent),
    modelRaw,
    ts,
    sessionId: String(o.session_id ?? o.sessionId ?? o.conversation_id ?? `imp_sess_${index}`),
    task: String(o.task ?? o.cwd ?? o.prompt ?? "导入会话"),
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    imageInputTokens: images.imageInputTokens,
    imageOutputTokens: images.imageOutputTokens,
    reasoningMin,
    speed,
    anomalies: anomalies.length ? anomalies : undefined,
  };
}

export function parseUsagePayload(text: string, fallbackAgent: UsageAgentId = "claude"): UsageEvent[] {
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
