import { ArrowRight, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AGENT_LABEL, agentTextClass } from "@/lib/quota/agent";
import {
  AGENT_IDS,
  detectedAgentIds,
  type AgentAvailability,
} from "@/lib/quota/agent-availability";
import { onboardingState } from "@/lib/quota/onboarding";
import { cn } from "@/lib/utils";

const ADAPTER: Record<(typeof AGENT_IDS)[number], string> = {
  claude: "~/.claude 或 ~/.config/claude",
  grok: "$GROK_HOME 或 ~/.grok",
  codex: "$CODEX_HOME 或 ~/.codex",
  antigravity: "agy · ~/.gemini",
};

export function Onboarding({
  availability,
  checking,
  error,
  onRetry,
  onContinue,
  onDemo,
}: {
  availability: AgentAvailability;
  checking: boolean;
  error: string | null;
  onRetry: () => void;
  onContinue: () => void;
  onDemo: () => void;
}) {
  const state = onboardingState(availability, checking, error);
  const detected = detectedAgentIds(availability);

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10 text-ink sm:px-6">
      <div className="w-full max-w-xl">
        <p className="text-sm font-medium text-mute">余量初始设置</p>
        <h1 className="mt-3 text-balance text-3xl font-medium tracking-tight sm:text-4xl">
          先连接这台机器上的 Agent
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-mute">
          余量只检查本机数据目录。未检测到的 Agent 不会出现在正式工作台，之后可在设置里重新检测。
        </p>

        <Card className="mt-8 p-2 sm:p-2">
          <div className="divide-y divide-line" aria-live="polite" aria-busy={checking}>
            {AGENT_IDS.map((agent) => {
              const found = availability[agent];
              return (
                <div
                  key={agent}
                  className="flex min-h-16 items-center gap-3 rounded-xl px-3 py-3 sm:px-4"
                >
                  <span
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-xl bg-raised",
                      agentTextClass(agent),
                    )}
                  >
                    {checking ? (
                      <LoaderCircle className="animate-spin" aria-hidden="true" />
                    ) : found ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <X className="text-faint" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{AGENT_LABEL[agent]}</span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-mute">
                      {ADAPTER[agent]}
                    </span>
                  </span>
                  <span className={cn("text-xs", found ? "text-ok" : "text-faint")}>
                    {checking ? "检测中" : found ? "已找到" : "未检测到"}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="mt-6 min-h-6" aria-live="polite">
          {state === "checking" ? <p className="text-sm text-mute">正在检查本机数据目录…</p> : null}
          {state === "ready" ? (
            <p className="text-sm text-mute">
              已找到 {detected.length} 个 Agent，可以开始只读监控。
            </p>
          ) : null}
          {state === "empty" ? (
            <p className="text-sm text-mute">
              暂未找到可监控目录。先运行一次 Agent，或直接查看演示。
            </p>
          ) : null}
          {state === "error" ? <p className="text-sm text-crit">{error}</p> : null}
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button onClick={onContinue} disabled={checking} className="sm:min-w-36">
            进入工作台
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button variant="secondary" onClick={onDemo} disabled={checking}>
            查看演示
          </Button>
          <Button variant="ghost" onClick={onRetry} disabled={checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden="true" />
            重新检测
          </Button>
        </div>
      </div>
    </main>
  );
}
