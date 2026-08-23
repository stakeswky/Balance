const DEVELOPMENT_LOOPBACK_CAPABILITY = "development-loopback";

let cachedCapability: string | undefined;

export function getOrchestratorAuthorization(): string {
  if (cachedCapability !== undefined) return cachedCapability;
  if (typeof window === "undefined") return DEVELOPMENT_LOOPBACK_CAPABILITY;

  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const candidate = parameters.get("balance-token");
  cachedCapability =
    candidate && /^[a-f0-9]{64}$/.test(candidate)
      ? candidate
      : DEVELOPMENT_LOOPBACK_CAPABILITY;

  if (parameters.has("balance-token")) {
    parameters.delete("balance-token");
    const remaining = parameters.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`,
    );
  }
  return cachedCapability;
}
