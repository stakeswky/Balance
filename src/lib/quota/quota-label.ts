import type { MeterDataSource } from "./engine.ts";

export type OfficialLoadState = "loading" | "ready" | "error";

export function quotaSourceLabel(label: string, source: MeterDataSource): string {
  if (source === "official") return `${label}（官方）`;
  if (source === "official-stale") return `${label}（官方快照）`;
  if (label === "本周额度") return "本周用量（本地估算）";
  return `${label}用量（本地估算）`;
}

export function quotaSourceMessage(
  loadState: OfficialLoadState,
  hasOfficial: boolean,
  hasLocalEstimate: boolean,
  hasStaleSnapshot: boolean,
): string | null {
  if (hasStaleSnapshot) {
    return "官方接口暂不可用；标为“官方快照”的值来自上次成功读取。";
  }
  if (loadState === "loading" && hasLocalEstimate) {
    return "正在读取官方额度；当前显示本地估算。";
  }
  if (loadState === "error" && hasLocalEstimate) {
    return "官方额度读取失败；当前显示本地估算。";
  }
  if (hasOfficial && hasLocalEstimate) {
    return "部分官方额度暂未返回；缺失项显示本地估算。";
  }
  if (!hasOfficial && hasLocalEstimate) {
    return "官方额度暂不可用；当前显示本地估算。";
  }
  return null;
}

