import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_STDIN_BYTES = 1024 * 1024;
const EARLIEST_RESET_MS = Date.UTC(2020, 0, 1);
const LATEST_RESET_MS = Date.UTC(2100, 0, 1);

// 空串/纯空白环境变量一律视为未设置；与 Step 4.7b server 端 envPath 语义逐字一致。
export function envPath(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function defaultStatuslinePath(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Balance", "claude-statusline.json");
  }
  if (platform === "win32") {
    return join(
      envPath(env.LOCALAPPDATA) ?? join(home, "AppData", "Local"),
      "Balance",
      "claude-statusline.json",
    );
  }
  return join(
    envPath(env.XDG_STATE_HOME) ?? join(home, ".local", "state"),
    "balance",
    "claude-statusline.json",
  );
}

export function sanitizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usedRaw = value.used_percentage ?? value.utilization;
  if (usedRaw == null || usedRaw === "") return null;
  const used = Number(usedRaw);
  const numericReset = Number(value.resets_at);
  const resetMs = Number.isFinite(numericReset)
    ? numericReset < 10_000_000_000 ? numericReset * 1000 : numericReset
    : typeof value.resets_at === "string"
      ? Date.parse(value.resets_at)
      : Number.NaN;
  if (
    !Number.isFinite(used)
    || used < 0
    || used > 100
    || !Number.isSafeInteger(resetMs)
    || resetMs < EARLIEST_RESET_MS
    || resetMs > LATEST_RESET_MS
  ) return null;
  return { used_percentage: used, resets_at: resetMs };
}

export function sanitizeRateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fiveHour = sanitizeWindow(value.five_hour);
  const sevenDay = sanitizeWindow(value.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_STDIN_BYTES) {
      process.stdout.write("Balance");
      return;
    }
  }
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    process.stdout.write("Balance");
    return;
  }
  const rateLimits = sanitizeRateLimits(payload?.rate_limits);
  if (rateLimits) {
    const path = envPath(process.env.BALANCE_CLAUDE_STATUSLINE_PATH)
      ?? envPath(process.env.SYNQ_CLAUDE_STATUSLINE_PATH)
      ?? defaultStatuslinePath();
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      // 只保存白名单窗口的两个数值字段，绝不透传 rate_limits 的未知嵌套键。
      writeFileSync(temp, `${JSON.stringify({ fetchedAt: Date.now(), rate_limits: rateLimits })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temp, path);
      chmodSync(path, 0o600);
    } catch {
      // statusline 必须 fail-open；采集失败不能影响 Claude Code 提示符。
    } finally {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // 下一次唯一 temp 名不会复用残留文件。
      }
    }
  }
  const five = Number(rateLimits?.five_hour?.used_percentage);
  const week = Number(rateLimits?.seven_day?.used_percentage);
  const bits = [
    Number.isFinite(five) ? `5h ${five}%` : "",
    Number.isFinite(week) ? `7d ${week}%` : "",
  ].filter(Boolean);
  process.stdout.write(bits.length ? `Balance ${bits.join(" · ")}` : "Balance");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
