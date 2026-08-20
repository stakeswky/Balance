export function isDesktopRuntime(
  env: Readonly<{ SYNQ_DESKTOP?: string }> = process.env,
): boolean {
  return env.SYNQ_DESKTOP === "1";
}
