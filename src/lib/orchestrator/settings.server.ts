import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  orchestratorStateDir,
} from "./paths.server.ts";
import { probeBinary } from "./runtime.server.ts";
import { orchestratorSettingsSchema } from "./schemas.ts";
import type { OrchestratorSettings } from "./types.ts";

export { orchestratorSettingsSchema } from "./schemas.ts";

export interface SettingsStoreOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface LoadedOrchestratorSettings {
  settings: OrchestratorSettings;
  diagnostics: string[];
}

export function defaultOrchestratorSettings(): OrchestratorSettings {
  return {
    globalMaxConcurrency: 3,
    agents: {
      claude: { agent: "claude", enabled: true, binaryPath: null, allowUnknownQuota: false },
      codex: { agent: "codex", enabled: true, binaryPath: null, allowUnknownQuota: false },
      grok: { agent: "grok", enabled: true, binaryPath: null, allowUnknownQuota: false },
    },
  };
}

function settingsRoot(options: SettingsStoreOptions): string {
  return options.root ?? orchestratorStateDir(options.env, options.platform);
}

export async function loadOrchestratorSettings(
  options: SettingsStoreOptions = {},
): Promise<LoadedOrchestratorSettings> {
  const root = settingsRoot(options);
  await ensurePrivateDirectory(root);
  const path = join(root, "settings.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: defaultOrchestratorSettings(), diagnostics: [] };
    }
    return {
      settings: defaultOrchestratorSettings(),
      diagnostics: [
        `无法读取原生 Agent 设置：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  try {
    return { settings: orchestratorSettingsSchema.parse(JSON.parse(text)), diagnostics: [] };
  } catch (error) {
    return {
      settings: defaultOrchestratorSettings(),
      diagnostics: [
        `无法读取原生 Agent 设置，已使用安全默认值：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export async function saveOrchestratorSettings(
  input: OrchestratorSettings,
  options: SettingsStoreOptions = {},
): Promise<OrchestratorSettings> {
  const settings = orchestratorSettingsSchema.parse(input);
  for (const agent of ["claude", "codex", "grok"] as const) {
    const configuredPath = settings.agents[agent].binaryPath;
    if (!configuredPath) continue;
    const probe = await probeBinary(agent, configuredPath);
    if (!probe.ok || !probe.path) {
      throw new Error(`${agent} version probe failed: ${probe.error ?? "unknown error"}`);
    }
    settings.agents[agent].binaryPath = probe.path;
  }
  const root = settingsRoot(options);
  await atomicWritePrivateJson(join(root, "settings.json"), settings);
  return settings;
}
