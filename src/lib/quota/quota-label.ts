import type { MeterDataSource } from "./engine.ts";
import type {
  CalibrationSource,
  QuotaValue,
} from "./quota-value.ts";

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

export function calibrationSourceLabel(source: CalibrationSource): string {
  if (source === "current-window") return "当前窗口样本";
  if (source === "historical-prior") return "历史窗口先验";
  return "无可用校准";
}

export function quotaValueDiagnostics(value: QuotaValue): string[] {
  const messages: string[] = [];
  if (!value.historyComplete) messages.push("本地校准历史已截断，区间已关闭");
  if (value.pricedTokenCoverage < 0.8) messages.push("可计价 token 覆盖率不足 80%");
  if (value.pricedEventCoverage < 0.8) messages.push("可计价事件覆盖率不足 80%");
  if (value.externalUsageDetected) messages.push("检测到本机日志之外的额度消耗");
  if (value.calibrationSource === "historical-prior") {
    messages.push("当前窗口样本不足，暂用同套餐历史窗口先验");
  }
  return messages;
}

