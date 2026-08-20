import { MODEL_META } from "./plans.ts";
import type { ModelId } from "./types.ts";

const FAMILY_TITLE: Record<string, string> = {
  fable: "Fable",
  mythos: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

function stripDateSuffix(raw: string): string {
  return raw.replace(/-\d{8}(?:[a-z].*)?$/i, "");
}

/** Human label from the log's raw model id, not the collapsed family. */
export function modelDisplayLabel(modelRaw?: string | null, family?: ModelId | null): string {
  const raw = (modelRaw ?? "").trim();
  if (raw) {
    const pretty = prettyFromRaw(raw);
    if (pretty) return pretty;
  }
  if (family && MODEL_META[family]) return MODEL_META[family].label;
  return raw || "未知模型";
}

function prettyFromRaw(raw: string): string | null {
  const key = raw.toLowerCase().replaceAll("_", "-");
  if (MODEL_META[key as ModelId]) return MODEL_META[key as ModelId].label;

  const stripped = stripDateSuffix(key);

  const grok = stripped.match(/grok-(\d+(?:\.\d+)?)/);
  if (grok) return `Grok ${grok[1]}`;

  const gpt = stripped.match(/gpt-(\d+(?:\.\d+)?)(?:-(sol|terra|luna|mini))?/);
  if (gpt) {
    const tier = gpt[2] ? ` ${gpt[2][0]!.toUpperCase()}${gpt[2].slice(1)}` : "";
    return `GPT-${gpt[1]}${tier}`;
  }

  const claude = stripped.match(/(fable|mythos|opus|sonnet|haiku)(?:-(\d+)(?:[.-](\d+))?)?/);
  if (claude) {
    const name = FAMILY_TITLE[claude[1]!] ?? claude[1]!;
    if (!claude[2]) return null;
    const ver = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2];
    return `${name} ${ver}`;
  }

  return null;
}
