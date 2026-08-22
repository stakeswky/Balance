// quota-cache.server.ts —— 仅服务端：hash 与脱敏转换。Step 5.8b 起在此文件追加持久化 I/O。
import { createHash } from "node:crypto";
import { isSafeModelRaw, type CachedQuotaEvent } from "./quota-cache.ts";
import type { AgentId, UsageEvent } from "./types.ts";

export function eventIdHash(agent: AgentId, id: string): string {
  return createHash("sha256").update(`${agent}\0${id}`, "utf8").digest("hex");
}

/** 服务端 identity：有 cacheIdentity 用之，否则对原始 (agent,id) 求 sha256。 */
export function serverQuotaEventIdentity(event: UsageEvent): string {
  return event.cacheIdentity ?? eventIdHash(event.agent, event.id);
}

export function cacheEvent(event: UsageEvent): CachedQuotaEvent {
  const modelRaw = event.modelRaw && isSafeModelRaw(event.modelRaw)
    ? event.modelRaw
    : undefined;
  const reportedUsd = event.reportedCost?.semantics === "api-equivalent"
    && event.reportedCost.schemaVersion === "grok-cli-1.0.0"
    && event.reportedCost.usdValue != null
    && Number.isFinite(event.reportedCost.usdValue)
    && event.reportedCost.usdValue >= 0
    ? event.reportedCost.usdValue
    : undefined;
  return {
    idHash: serverQuotaEventIdentity(event),
    agent: event.agent,
    model: event.pricingDisabled && modelRaw ? modelRaw : event.model,
    modelRaw,
    ts: event.ts,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    cacheWrite1h: event.cacheWrite1h,
    cacheWriteUnsplit: event.cacheWriteUnsplit,
    imageInputTokens: event.imageInputTokens,
    imageOutputTokens: event.imageOutputTokens,
    speed: event.speed,
    anomalyCodes: event.anomalies?.map((anomaly) => anomaly.code),
    reportedUsd,
    reportedCostSchema: reportedUsd == null ? undefined : "grok-cli-1.0.0",
  };
}
