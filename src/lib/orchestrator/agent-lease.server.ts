import type { NativeAgentId } from "./types.ts";

export type AgentLeaseRole = "planning" | "execution" | "repair";

export interface AgentLease {
  agent: NativeAgentId;
  runId: string;
  taskId: string;
  role: AgentLeaseRole;
  acquiredAt: number;
  release(): Promise<void>;
}

export interface AgentLeaseManager {
  acquire(input: {
    agent: NativeAgentId;
    runId: string;
    taskId: string;
    role: AgentLeaseRole;
    signal: AbortSignal;
  }): Promise<AgentLease>;
  setGlobalMaxConcurrency(value: number): void;
  shutdown(): Promise<void>;
  snapshot(): { active: number; waiting: number };
}

interface LeaseRequest {
  agent: NativeAgentId;
  runId: string;
  taskId: string;
  role: AgentLeaseRole;
  signal: AbortSignal;
  resolve(lease: AgentLease): void;
  reject(error: Error): void;
  onAbort(): void;
}

function cancelledError(): Error {
  const error = new Error("Agent lease request was cancelled");
  error.name = "AbortError";
  return error;
}

export function createAgentLeaseManager(options: {
  globalMaxConcurrency: number;
  now?: () => number;
}): AgentLeaseManager {
  if (!Number.isSafeInteger(options.globalMaxConcurrency) || options.globalMaxConcurrency < 1) {
    throw new Error("global Agent concurrency must be a positive safe integer");
  }
  const now = options.now ?? Date.now;
  const active = new Map<NativeAgentId, symbol>();
  const waiting: LeaseRequest[] = [];
  let globalMaxConcurrency = options.globalMaxConcurrency;
  let shuttingDown = false;

  const drain = (): void => {
    if (shuttingDown) return;
    while (active.size < globalMaxConcurrency) {
      const index = waiting.findIndex(
        (request) => !request.signal.aborted && !active.has(request.agent),
      );
      if (index < 0) return;
      const request = waiting.splice(index, 1)[0]!;
      request.signal.removeEventListener("abort", request.onAbort);
      if (request.signal.aborted) {
        request.reject(cancelledError());
        continue;
      }
      const token = Symbol(`${request.runId}:${request.taskId}:${request.role}`);
      active.set(request.agent, token);
      let released = false;
      request.resolve({
        agent: request.agent,
        runId: request.runId,
        taskId: request.taskId,
        role: request.role,
        acquiredAt: now(),
        async release() {
          if (released) return;
          released = true;
          if (active.get(request.agent) === token) active.delete(request.agent);
          drain();
        },
      });
    }
  };

  return {
    acquire(input) {
      if (shuttingDown) return Promise.reject(new Error("Agent lease manager is shutting down"));
      if (input.signal.aborted) return Promise.reject(cancelledError());
      return new Promise<AgentLease>((resolve, reject) => {
        const request: LeaseRequest = {
          ...input,
          resolve,
          reject,
          onAbort() {
            const index = waiting.indexOf(request);
            if (index < 0) return;
            waiting.splice(index, 1);
            input.signal.removeEventListener("abort", request.onAbort);
            reject(cancelledError());
            drain();
          },
        };
        waiting.push(request);
        input.signal.addEventListener("abort", request.onAbort, { once: true });
        drain();
      });
    },
    setGlobalMaxConcurrency(value) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("global Agent concurrency must be a positive safe integer");
      }
      globalMaxConcurrency = value;
      drain();
    },
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      const error = new Error("Agent lease manager is shutting down");
      for (const request of waiting.splice(0)) {
        request.signal.removeEventListener("abort", request.onAbort);
        request.reject(error);
      }
      active.clear();
    },
    snapshot() {
      return { active: active.size, waiting: waiting.length };
    },
  };
}
