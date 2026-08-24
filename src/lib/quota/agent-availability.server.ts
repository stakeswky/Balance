import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAgyExecutable } from "./antigravity.server.ts";
import type { AgentAvailability } from "./agent-availability";

export interface AgentDetectionOptions {
  home?: string;
  grokHome?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function detectAgentAvailability(
  options: AgentDetectionOptions = {},
): AgentAvailability {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const grokHome = options.grokHome || env.GROK_HOME || join(home, ".grok");
  const codexHome = options.codexHome || env.CODEX_HOME || join(home, ".codex");
  return {
    claude: isDirectory(join(home, ".claude")) || isDirectory(join(home, ".config", "claude")),
    grok: isDirectory(grokHome),
    codex: isDirectory(codexHome),
    antigravity: findAgyExecutable({ home, platform, env }) != null,
  };
}
