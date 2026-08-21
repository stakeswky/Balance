export type DesktopRuntimeEnv = Readonly<{
  BALANCE_DESKTOP?: string;
  SYNQ_DESKTOP?: string;
}>;

export function isDesktopRuntime(env: DesktopRuntimeEnv = process.env): boolean {
  return env.BALANCE_DESKTOP === "1" || env.SYNQ_DESKTOP === "1";
}
