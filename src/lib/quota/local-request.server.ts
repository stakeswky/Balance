import {
  getRequest,
  getRequestIP,
  setResponseStatus,
} from "@tanstack/react-start/server";
import { CrossSiteRequestError } from "../auth/isolation.server.ts";
import { BlockList, isIP } from "node:net";

const ALLOWED_QUOTA_HOSTS = new Set([
  "127.0.0.1:4780",
  "localhost:4780",
  "[::1]:4780",
  "127.0.0.1:8080",
  "localhost:8080",
  "[::1]:8080",
]);

const LOOPBACK_PEERS = new BlockList();
LOOPBACK_PEERS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_PEERS.addAddress("::1", "ipv6");
LOOPBACK_PEERS.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

export function isAllowedQuotaHost(host: string | null): boolean {
  return host !== null && ALLOWED_QUOTA_HOSTS.has(host.toLowerCase());
}

export function isLoopbackPeerAddress(peer: string | undefined): boolean {
  if (!peer) return false;
  const withoutZone = peer.toLowerCase().split("%", 1)[0]!;
  const family = isIP(withoutZone);
  if (family === 4) return LOOPBACK_PEERS.check(withoutZone, "ipv4");
  if (family === 6) return LOOPBACK_PEERS.check(withoutZone, "ipv6");
  return false;
}

export function isAllowedQuotaFetchSite(site: string | null): boolean {
  return site === null || site === "same-origin" || site === "none";
}

interface QuotaRequestRuntime {
  peerAddress(): string | undefined;
}

const defaultQuotaRequestRuntime: QuotaRequestRuntime = {
  // 不传 { xForwardedFor: true }：Host/X-Forwarded-For 均不可信。
  peerAddress: () => getRequestIP(),
};

function markForbidden(): void {
  setResponseStatus(403, "Forbidden");
}

export function assertQuotaRequestAllowed(
  runtime: QuotaRequestRuntime = defaultQuotaRequestRuntime,
): void {
  const request = getRequest();
  const site = request.headers.get("sec-fetch-site");
  if (!isAllowedQuotaFetchSite(site)) {
    markForbidden();
    throw new CrossSiteRequestError();
  }
  const host = request.headers.get("host");
  const peer = runtime.peerAddress();
  if (isAllowedQuotaHost(host) && isLoopbackPeerAddress(peer)) return;
  markForbidden();
  throw new CrossSiteRequestError();
}
