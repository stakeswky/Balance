import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAvailability } from "./agent-availability";

export interface AgentDetectionOptions {
  home?: string;
  grokHome?: string;
  codexHome?: string;
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
  const grokHome = options.grokHome || process.env.GROK_HOME || join(home, ".grok");
  const codexHome = options.codexHome || process.env.CODEX_HOME || join(home, ".codex");
  return {
    claude: isDirectory(join(home, ".claude")) || isDirectory(join(home, ".config", "claude")),
    grok: isDirectory(grokHome),
    codex: isDirectory(codexHome),
  };
}
