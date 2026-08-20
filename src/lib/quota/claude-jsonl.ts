import type { ActorKind, ClaudeModelId, UsageEvent } from "./types.ts";
import { claudeCacheWrites } from "./tokens.ts";

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  lastUser: string;
  actorId?: string;
  actorKind?: ActorKind;
}

export function clipTask(s: string, n = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export function asClaudeModel(raw: string): ClaudeModelId {
  const s = raw.toLowerCase();
  if (s.includes("fable") || s.includes("mythos")) return "fable";
  if (s.includes("opus")) return "opus";
  if (s.includes("haiku")) return "haiku";
  return "sonnet";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}



function parseTs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw;
  }
  if (typeof raw === "string" && raw) {
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const bits: string[] = [];
  for (const c of content) {
    if (typeof c === "string") bits.push(c);
    else if (c && typeof c === "object" && "text" in c) bits.push(String((c as { text?: unknown }).text ?? ""));
  }
  return bits.join("\n").trim();
}

export function normalizedActorId(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.startsWith("agent-") ? raw : `agent-${raw}`;
}

export function applyMetaLine(obj: Record<string, unknown>, meta: SessionMeta): void {
  const typ = obj.type;
  if (typeof obj.cwd === "string" && obj.cwd) meta.cwd = obj.cwd;
  if (typeof obj.sessionId === "string" && obj.sessionId) meta.sessionId = obj.sessionId;
  const actorId = normalizedActorId(obj.agentId);
  if (actorId) meta.actorId = actorId;
  if (obj.attributionAgent === "workflow-subagent") meta.actorKind = "workflow-subagent";
  else if (meta.actorId && !meta.actorKind) meta.actorKind = "subagent";
  if (typ === "custom-title" && typeof obj.customTitle === "string") meta.title = obj.customTitle;
  if (typ === "last-prompt" && typeof obj.lastPrompt === "string") meta.lastUser = obj.lastPrompt;
  if (typ === "user") {
    const msg = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : {};
    const txt = textFromContent(msg.content);
    if (
      txt &&
      !txt.startsWith("[{") &&
      !txt.includes("<local-command") &&
      !txt.trimStart().startsWith("<system-reminder>")
    ) {
      meta.lastUser = txt;
    }
  }
}

export function parseJsonlLine(line: string, meta: SessionMeta): UsageEvent | null {
  const t = line.trim();
  if (!t) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  applyMetaLine(obj, meta);
  if (obj.type !== "assistant") return null;
  const msg = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : {};
  const usage = (msg.usage ?? obj.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;

  const tokensIn = num(usage.input_tokens ?? usage.prompt_tokens);
  const tokensOut = num(usage.output_tokens ?? usage.completion_tokens);
  const cacheRead = num(usage.cache_read_input_tokens ?? usage.cache_read);
  const writes = claudeCacheWrites(usage);
  if (tokensIn + tokensOut + cacheRead + writes.cacheWrite5mTokens + writes.cacheWrite1hTokens <= 0) return null;

  const ts = parseTs(obj.timestamp ?? obj.ts) ?? Date.now();
  const id = String(obj.requestId ?? msg.id ?? obj.uuid ?? `${meta.sessionId}:${ts}`);
  const sessionId = String(obj.sessionId ?? meta.sessionId);
  const modelRaw = String(msg.model ?? obj.model ?? "claude-sonnet-5");
  const model = asClaudeModel(modelRaw);
  const task = clipTask(meta.title || meta.lastUser || meta.cwd || sessionId);

  return {
    id,
    agent: "claude",
    model,
    modelRaw,
    ts,
    sessionId,
    actorId: meta.actorId,
    actorKind: meta.actorKind,
    task,
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite: writes.cacheWrite5mTokens,
    cacheWrite1h: writes.cacheWrite1hTokens,
    cacheWriteUnsplit: writes.splitUnknown || undefined,
    reasoningMin: 0,
  };
}

export function foldByRequestId(events: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const ev of events) map.set(ev.id, ev);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
