import { spawn } from "node:child_process";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  AgentRuntimeProbe,
  NativeAgentId,
  OrchestratorSettings,
} from "./types.ts";

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

function appendCandidate(candidates: string[], value: string | undefined): void {
  if (!value || !isAbsolute(value) || candidates.includes(value)) return;
  candidates.push(value);
}

export function candidateBinaryPaths(
  agent: NativeAgentId,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : undefined;
  if (agent === "claude") {
    appendCandidate(candidates, home ? join(home, ".local", "bin", "claude") : undefined);
    appendCandidate(candidates, home ? join(home, ".claude", "local", "claude") : undefined);
    appendCandidate(candidates, "/opt/homebrew/bin/claude");
    appendCandidate(candidates, "/usr/local/bin/claude");
  } else if (agent === "codex") {
    appendCandidate(
      candidates,
      env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? join(env.CODEX_HOME, "bin", "codex") : undefined,
    );
    appendCandidate(candidates, "/opt/homebrew/bin/codex");
    appendCandidate(candidates, "/usr/local/bin/codex");
    appendCandidate(candidates, home ? join(home, ".local", "bin", "codex") : undefined);
  } else {
    appendCandidate(
      candidates,
      env.GROK_HOME && isAbsolute(env.GROK_HOME) ? join(env.GROK_HOME, "bin", "grok") : undefined,
    );
    appendCandidate(candidates, home ? join(home, ".grok", "bin", "grok") : undefined);
    appendCandidate(candidates, "/opt/homebrew/bin/grok");
    appendCandidate(candidates, "/usr/local/bin/grok");
  }
  return candidates;
}

export async function validateBinaryPath(path: string): Promise<string> {
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    throw new Error("native agent binary path must be absolute and contain no NUL");
  }
  let inputMetadata;
  try {
    inputMetadata = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`native agent binary not found (${code ?? "unknown"}): ${path}`);
  }
  const canonical = inputMetadata.isSymbolicLink() ? await realpath(path) : path;
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error(`native agent binary is not a regular file: ${path}`);
  try {
    await access(canonical, constants.X_OK);
  } catch {
    throw new Error(`native agent binary is not executable: ${path}`);
  }
  return canonical;
}

function probeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    NO_COLOR: "1",
  };
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

function killProbeGroup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The child may already have exited or failed to become a process group.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The child already exited.
  }
}

export async function probeBinary(
  agent: NativeAgentId,
  binaryPath: string,
  signal?: AbortSignal,
): Promise<AgentRuntimeProbe> {
  let canonical: string;
  try {
    canonical = await validateBinaryPath(binaryPath);
  } catch (error) {
    return {
      agent,
      ok: false,
      path: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (signal?.aborted) {
    return { agent, ok: false, path: canonical, version: null, error: "version probe was aborted" };
  }

  return new Promise<AgentRuntimeProbe>((resolve) => {
    const child = spawn(canonical, ["--version"], {
      detached: process.platform !== "win32",
      env: probeEnvironment(process.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: AgentRuntimeProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(0, PROBE_OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      finish({ agent, ok: false, path: canonical, version: null, error: error.message });
    });
    child.once("close", (code, closeSignal) => {
      if (timedOut) {
        finish({ agent, ok: false, path: canonical, version: null, error: "version probe timed out after 3000ms" });
        return;
      }
      if (signal?.aborted) {
        finish({ agent, ok: false, path: canonical, version: null, error: "version probe was aborted" });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/, 1)[0];
        finish({
          agent,
          ok: false,
          path: canonical,
          version: null,
          error: `version probe exited with ${code ?? closeSignal ?? "unknown"}${detail ? `: ${detail}` : ""}`,
        });
        return;
      }
      const version = (stdout.trim() || stderr.trim()).split(/\r?\n/, 1)[0]?.slice(0, 500) ?? "";
      finish(
        version
          ? { agent, ok: true, path: canonical, version, error: null }
          : { agent, ok: false, path: canonical, version: null, error: "version probe returned no version text" },
      );
    });
    const onAbort = (): void => {
      killProbeGroup(child.pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      killProbeGroup(child.pid);
    }, PROBE_TIMEOUT_MS);
    timeout.unref();
  });
}

async function discoverAgent(
  agent: NativeAgentId,
  settings: OrchestratorSettings,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
): Promise<AgentRuntimeProbe> {
  const configured = settings.agents[agent].binaryPath;
  const candidates = configured ? [configured] : candidateBinaryPaths(agent, env);
  let lastFailure: AgentRuntimeProbe | null = null;
  for (const candidate of candidates) {
    const result = await probeBinary(agent, candidate, signal);
    if (result.ok) return result;
    lastFailure = result;
    if (signal?.aborted) return result;
  }
  return lastFailure ?? {
    agent,
    ok: false,
    path: null,
    version: null,
    error: `no ${agent} binary candidate is configured`,
  };
}

export async function discoverNativeAgents(
  settings: OrchestratorSettings,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<NativeAgentId, AgentRuntimeProbe>> {
  const [claude, codex, grok] = await Promise.all([
    discoverAgent("claude", settings, signal, env),
    discoverAgent("codex", settings, signal, env),
    discoverAgent("grok", settings, signal, env),
  ]);
  return { claude, codex, grok };
}
