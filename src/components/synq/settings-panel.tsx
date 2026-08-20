import { Pause, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PlansPanel } from "@/components/synq/plans-panel";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { useQuota } from "@/lib/quota/store";
import { cn } from "@/lib/utils";

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
    <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-3">
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
  const liveClaude = useQuota((s) => s.liveClaude);
  const liveGrok = useQuota((s) => s.liveGrok);
  const liveCodex = useQuota((s) => s.liveCodex);
  const claudePlanId = useQuota((s) => s.claudePlanId);
  const grokPlanId = useQuota((s) => s.grokPlanId);
  const codexPlanId = useQuota((s) => s.codexPlanId);
  const weekBoostPct = useQuota((s) => s.weekBoostPct);
  const alertWindowPct = useQuota((s) => s.alertWindowPct);
  const alertWeekPct = useQuota((s) => s.alertWeekPct);
  const sampleCount = useQuota((s) => s.quotaSamples.length);

  return (
    <div className="space-y-5">
      <Card>
        <CardTitle>本机监控</CardTitle>
        <CardHint className="mt-1">
          Synq 只读本机 Agent 日志和官方百分比，不需要账号。套餐、阈值和采样都保存在这台浏览器里。
        </CardHint>
        <p className={cn("mt-3 font-mono text-xs", sampleCount ? "text-mute" : "text-faint")}>
          已存校准样本 {sampleCount} 条
        </p>
      </Card>

      <Card>
        <CardTitle>日志采集</CardTitle>
        <CardHint className="mt-1">关掉某一路后，不再读取对应客户端的新回合。</CardHint>
        <div className="mt-4 space-y-2">
          <CaptureToggle
            name="Claude Code"
            adapter="~/.claude"
            live={liveClaude}
            onToggle={() => useQuota.getState().toggleLive("claude")}
          />
          <CaptureToggle
            name="Grok"
            adapter="~/.grok"
            live={liveGrok}
            onToggle={() => useQuota.getState().toggleLive("grok")}
          />
          <CaptureToggle
            name="Codex"
            adapter="~/.codex"
            live={liveCodex}
            onToggle={() => useQuota.getState().toggleLive("codex")}
          />
        </div>
      </Card>

      <PlansPanel
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
        <CardTitle>演示数据</CardTitle>
        <CardHint className="mt-1">用假会话填满时间线。打开任一路采集会回到只读监听本机日志。</CardHint>
        <Button
          variant="secondary"
          className="mt-4"
          onClick={() => {
            useQuota.getState().resetDemo();
            toast.message("已重置为今日演示数据");
          }}
        >
          <RotateCcw />
          重置演示
        </Button>
      </Card>
    </div>
  );
}
