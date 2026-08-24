import { Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PlansPanel } from "@/components/balance/plans-panel";
import { UpdateCard } from "@/components/balance/update-card";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { detectedAgentIds, visibleAgentIds } from "@/lib/quota/agent-availability";
import { useQuota } from "@/lib/quota/store";
import { isUsageAgentId, type UsageAgentId } from "@/lib/quota/types";
import { pullAgentAvailability } from "@/lib/quota/watch";
import { cn } from "@/lib/utils";

const CAPTURE: Record<UsageAgentId, { name: string; adapter: string }> = {
  claude: { name: "Claude Code", adapter: "~/.claude" },
  grok: { name: "Grok", adapter: "~/.grok" },
  codex: { name: "Codex", adapter: "~/.codex" },
};

function CaptureToggle({
  name,
  adapter,
  live,
  onToggle,
}: {
  name: string;
  adapter: string;
  live: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-3">
      <div className="min-w-0">
        <p className="text-sm text-ink">{name}</p>
        <p className="mt-0.5 font-mono text-xs text-mute">{adapter}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onToggle} aria-pressed={live}>
        {live ? <Pause /> : <Play />}
        {live ? "暂停" : "采集"}
      </Button>
    </div>
  );
}

export function SettingsPanel() {
  const [detecting, setDetecting] = useState(false);
  const liveClaude = useQuota((s) => s.liveClaude);
  const liveGrok = useQuota((s) => s.liveGrok);
  const liveCodex = useQuota((s) => s.liveCodex);
  const demoMode = useQuota((s) => s.demoMode);
  const minimalMode = useQuota((s) => s.minimalMode);
  const agentAvailability = useQuota((s) => s.agentAvailability);
  const realEvents = useQuota((s) => s.realEvents);
  const claudePlanId = useQuota((s) => s.claudePlanId);
  const grokPlanId = useQuota((s) => s.grokPlanId);
  const codexPlanId = useQuota((s) => s.codexPlanId);
  const weekBoostPct = useQuota((s) => s.weekBoostPct);
  const alertWindowPct = useQuota((s) => s.alertWindowPct);
  const alertWeekPct = useQuota((s) => s.alertWeekPct);
  const sampleCount = useQuota((s) => s.quotaSamples.length);
  const detectedAgents = detectedAgentIds(agentAvailability);
  const visibleAgents = visibleAgentIds(agentAvailability, demoMode, realEvents);
  const detectedUsageAgents = detectedAgents.filter(isUsageAgentId);
  const visibleUsageAgents = visibleAgents.filter(isUsageAgentId);
  const liveByAgent: Record<UsageAgentId, boolean> = {
    claude: liveClaude,
    grok: liveGrok,
    codex: liveCodex,
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const result = await pullAgentAvailability();
      useQuota.getState().setAgentAvailability(result);
      const count = detectedAgentIds(result).length;
      toast.success(`检测完成，找到 ${count} 个 Agent`);
    } catch {
      toast.error("无法检测本机 Agent，请稍后重试");
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <UpdateCard />
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>本机监控</CardTitle>
            <CardHint className="mt-1">
              余量只读本机 Agent
              日志和官方百分比，不需要账号。套餐、阈值和采样都保存在这台浏览器里。
            </CardHint>
            <p className={cn("mt-3 font-mono text-xs", sampleCount ? "text-mute" : "text-faint")}>
              已检测 {detectedAgents.length} 个 Agent · 已存校准样本 {sampleCount} 条
            </p>
          </div>
          <Button variant="secondary" onClick={() => void detect()} disabled={detecting}>
            <RefreshCw className={detecting ? "animate-spin" : undefined} />
            {detecting ? "检测中" : "重新检测"}
          </Button>
        </div>
      </Card>

      <Card>
        <CardTitle>日志采集</CardTitle>
        <CardHint className="mt-1">关掉某一路后，不再读取对应客户端的新回合。</CardHint>
        <div className="mt-4 space-y-2">
          {detectedUsageAgents.map((agent) => (
            <CaptureToggle
              key={agent}
              name={CAPTURE[agent].name}
              adapter={CAPTURE[agent].adapter}
              live={liveByAgent[agent]}
              onToggle={() => useQuota.getState().toggleLive(agent)}
            />
          ))}
          {detectedUsageAgents.length === 0 ? (
            <p className="rounded-xl bg-raised px-3 py-4 text-sm leading-relaxed text-mute">
              暂未检测到本机 Agent。运行一次 Agent 后，使用上方“重新检测”更新采集入口。
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>极客模式</CardTitle>
            <CardHint className="mt-1">
              打开后主页面显示数据来源提示、5 小时窗口细节、实时流水和诊断信息。
            </CardHint>
          </div>
          <Switch
            checked={!minimalMode}
            aria-label="极客模式"
            onCheckedChange={(on) => {
              useQuota.getState().setMinimalMode(!on);
              toast.message(on ? "已开启极客模式" : "已恢复简约模式");
            }}
          />
        </div>
      </Card>

      <PlansPanel
        agents={visibleUsageAgents}
        claudePlanId={claudePlanId}
        grokPlanId={grokPlanId}
        codexPlanId={codexPlanId}
        weekBoostPct={weekBoostPct}
        alertWindowPct={alertWindowPct}
        alertWeekPct={alertWeekPct}
        onClaude={(id) => useQuota.getState().setPlan("claude", id)}
        onGrok={(id) => useQuota.getState().setPlan("grok", id)}
        onCodex={(id) => useQuota.getState().setPlan("codex", id)}
        onBoost={(n) => useQuota.getState().setBoost(n)}
        onAlertWindow={(n) => useQuota.getState().setAlertWindow(n)}
        onAlertWeek={(n) => useQuota.getState().setAlertWeek(n)}
      />

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>演示数据</CardTitle>
            <CardHint className="mt-1">
              用合成会话展示完整工作台。关闭后会恢复本机数据和采集设置。
            </CardHint>
          </div>
          <Switch
            checked={demoMode}
            aria-label="演示数据"
            onCheckedChange={(on) => {
              useQuota.getState().setDemoMode(on);
              toast.message(on ? "已开启演示数据" : "已恢复本机数据");
            }}
          />
        </div>
        {demoMode ? (
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => {
              useQuota.getState().resetDemo();
              toast.message("已重置为今日演示数据");
            }}
          >
            <RotateCcw />
            重置今日演示
          </Button>
        ) : null}
      </Card>
    </div>
  );
}
