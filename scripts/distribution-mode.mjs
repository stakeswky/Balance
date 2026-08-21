export function resolveNitroPreset(env = process.env) {
  return env.BALANCE_DISTRIBUTION === "desktop" || env.SYNQ_DISTRIBUTION === "desktop"
    ? "node-server"
    : "vercel";
}
