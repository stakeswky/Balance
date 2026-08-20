import { Badge } from "@/components/ui/badge";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { formatTokens } from "@/components/synq/format";
import { CLAUDE_PLANS, CODEX_PLANS, GROK_PLANS } from "@/lib/quota/plans";
import type { PlanDef } from "@/lib/quota/types";
import { cn } from "@/lib/utils";

function PlanList({
  title,
  plans,
  selected,
  onSelect,
}: {
  title: string;
  plans: PlanDef[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="grid gap-2">
        {plans.map((p) => {
          const active = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              className={cn(
                "rounded-xl p-4 text-left shadow-[var(--shadow-border)] transition-[box-shadow,background-color] duration-150",
                active ? "bg-raised shadow-[var(--shadow-border-hover)]" : "bg-surface hover:bg-raised",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="font-mono text-xs text-mute">
                  {p.kind === "api" ? "按量" : `$${p.priceUsd}/月`}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-mute">{p.blurb}</p>
              <p className="mt-2 font-mono text-[11px] text-faint">
                窗 {formatTokens(p.windowTokenBudget)}
                {p.windowReasoningMin ? ` · ${p.windowReasoningMin} 分推理` : ""}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PlansPanel({
  claudePlanId,
  grokPlanId,
  codexPlanId,
  weekBoostPct,
  alertWindowPct,
  alertWeekPct,
  onClaude,
  onGrok,
  onCodex,
  onBoost,
  onAlertWindow,
  onAlertWeek,
}: {
  claudePlanId: string;
  grokPlanId: string;
  codexPlanId: string;
  weekBoostPct: number;
  alertWindowPct: number;
  alertWeekPct: number;
  onClaude: (id: string) => void;
  onGrok: (id: string) => void;
  onCodex: (id: string) => void;
  onBoost: (n: number) => void;
  onAlertWindow: (n: number) => void;
  onAlertWeek: (n: number) => void;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <PlanList title="Claude Code 套餐" plans={CLAUDE_PLANS} selected={claudePlanId} onSelect={onClaude} />
      <PlanList title="Grok 套餐" plans={GROK_PLANS} selected={grokPlanId} onSelect={onGrok} />
      <PlanList title="Codex 套餐" plans={CODEX_PLANS} selected={codexPlanId} onSelect={onCodex} />
      <Card className="lg:col-span-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>周额度加成</CardTitle>
            <CardHint className="mt-1">
              Anthropic 目前对 Pro / Max / Team 提供临时周额度上浮。默认按 50% 计算至 8 月底。
            </CardHint>
          </div>
          <Badge tone="mute">{weekBoostPct}%</Badge>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={10}
          value={weekBoostPct}
          onChange={(e) => onBoost(Number(e.target.value))}
          className="mt-5 w-full accent-accent"
          aria-label="周额度加成百分比"
        />
        <div className="mt-2 flex justify-between font-mono text-xs text-faint">
          <span>0%</span>
          <span>50%</span>
          <span>100%</span>
        </div>
      </Card>
      <Card>
        <CardTitle>告警阈值</CardTitle>
        <CardHint className="mt-1">窗口或周额度越过这条线时，底部弹出提醒并记入报告。</CardHint>
        <label className="mt-5 block text-xs text-mute">
          五小时窗 {alertWindowPct}%
          <input
            type="range"
            min={50}
            max={95}
            step={5}
            value={alertWindowPct}
            onChange={(e) => onAlertWindow(Number(e.target.value))}
            className="mt-2 w-full accent-accent"
          />
        </label>
        <label className="mt-4 block text-xs text-mute">
          本周额度 {alertWeekPct}%
          <input
            type="range"
            min={50}
            max={95}
            step={5}
            value={alertWeekPct}
            onChange={(e) => onAlertWeek(Number(e.target.value))}
            className="mt-2 w-full accent-accent"
          />
        </label>
      </Card>
    </div>
  );
}
