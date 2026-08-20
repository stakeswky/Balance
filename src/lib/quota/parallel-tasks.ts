import type { AgentLiveInfo } from "./types.ts";

export interface ParallelTaskSummary {
  total: number;
  visible: AgentLiveInfo[];
  overflow: number;
}

export function parallelTaskSummary(tasks: AgentLiveInfo[], live: boolean): ParallelTaskSummary | null {
  if (!live || tasks.length <= 1) return null;
  const visible = tasks.slice(0, 4);
  return { total: tasks.length, visible, overflow: tasks.length - visible.length };
}
