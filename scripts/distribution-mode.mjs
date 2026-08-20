export function resolveNitroPreset(env = process.env) {
  return env.SYNQ_DISTRIBUTION === "desktop" ? "node-server" : "vercel";
}
