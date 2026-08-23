import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { useOrchestratorController } from "@/lib/orchestrator/client";
import type {
  NativeAgentId,
  OrchestratorEvent,
  QuotaCapacityEvidence,
  RunStatus,
  TaskSize,
} from "@/lib/orchestrator/types";
import { cn } from "@/lib/utils";

const AGENTS: Record<NativeAgentId, { name: string; tone: NativeAgentId }> = {
  claude: { name: "Claude Code", tone: "claude" },
  codex: { name: "Codex", tone: "codex" },
  grok: { name: "Grok", tone: "grok" },
};

const STATUS: Record<RunStatus, string> = {
  draft: "待确认",
  ready: "准备中",
  running: "执行中",
  cancelling: "正在取消",
  integrating: "正在合并",
  verifying: "最终验证",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "意外中断",
  capacity_blocked: "额度不足",
};

const SIZE: Record<TaskSize, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

const ACTIVE_STATUSES = new Set<RunStatus>([
  "ready",
  "running",
  "cancelling",
  "integrating",
  "verifying",
]);

function capacityText(evidence: QuotaCapacityEvidence): string {
  if (
    evidence.remainingLowUsd !== null &&
    evidence.totalHighUsd !== null &&
    ["medium", "high"].includes(evidence.valueConfidence)
  ) {
    return `$${evidence.remainingLowUsd.toFixed(2)}+ / $${evidence.totalHighUsd.toFixed(2)}`;
  }
  if (evidence.officialRemainingPct !== null) {
    return `官方剩余 ${evidence.officialRemainingPct.toFixed(0)}%`;
  }
  return "额度未知";
}

function eventText(event: OrchestratorEvent): string {
  switch (event.type) {
    case "process_started":
      return `进程已启动 · PID ${event.pid}`;
    case "session_started":
      return `会话已建立 · ${event.sessionId}`;
    case "message":
      return event.text;
    case "tool_started":
      return `开始工具 ${event.tool}${event.detail ? ` · ${event.detail}` : ""}`;
    case "tool_completed":
      return `${event.tool} ${event.success ? "完成" : "失败"}`;
    case "usage":
      return `Token：输入 ${event.inputTokens} · 输出 ${event.outputTokens}`;
    case "diagnostic":
      return `${event.stream}: ${event.message}`;
    case "process_completed":
      return `进程结束 · code ${event.exitCode}`;
    case "process_failed":
      return `${event.category}: ${event.message}`;
  }
}

export function OrchestratorPanel({
  quotaEvidence,
}: {
  quotaEvidence: Record<NativeAgentId, QuotaCapacityEvidence>;
}) {
  const controller = useOrchestratorController(quotaEvidence);
  const [trusted, setTrusted] = useState(false);

  useEffect(() => {
    setTrusted(false);
  }, [controller.draft?.runId]);

  const validation = controller.repositoryValidation;
  const canAnalyze = Boolean(
    validation?.valid &&
    validation.canonicalPath &&
    validation.dirty === false &&
    controller.prompt.trim() &&
    !controller.loading,
  );
  const canStart = Boolean(
    trusted && controller.draft && controller.run?.status === "draft" && !controller.loading,
  );

  return (
    <div className="space-y-5" data-testid="orchestrator-panel">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>总调度</CardTitle>
            <CardHint className="mt-1 max-w-3xl leading-relaxed">
              输入目标后，Balance 按任务规模与保守额度把工作分给设备上的原生 Agent。
              每项任务使用独立 Git worktree，验证通过后才合并到单独结果分支。
            </CardHint>
          </div>
          <Badge tone={controller.developmentProtection ? "watch" : "ok"}>
            {controller.developmentProtection ? "开发模式本机保护" : "桌面能力令牌已启用"}
          </Badge>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-5">
          <Card>
            <CardTitle>仓库与计划</CardTitle>
            <CardHint className="mt-1">
              先校验仓库身份和干净状态，再让协调 Agent 生成结构化计划。
            </CardHint>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Input
                data-testid="orchestrator-repository-input"
                aria-label="仓库绝对路径"
                placeholder="/absolute/path/to/repository"
                value={controller.repositoryPath}
                onChange={(event) => controller.setRepositoryPath(event.target.value)}
                disabled={
                  Boolean(controller.loading) ||
                  Boolean(controller.run && ACTIVE_STATUSES.has(controller.run.status))
                }
              />
              <Button
                data-testid="orchestrator-validate"
                variant="secondary"
                onClick={() => void controller.validate()}
                disabled={Boolean(controller.loading) || !controller.repositoryPath.trim()}
              >
                {controller.loading === "validate" ? "校验中" : "校验仓库"}
              </Button>
            </div>

            {validation ? (
              <div
                className={cn(
                  "mt-3 rounded-xl px-3 py-3 text-xs leading-relaxed",
                  validation.valid && !validation.dirty
                    ? "bg-ok/10 text-ok"
                    : "bg-crit/10 text-crit",
                )}
              >
                {validation.valid ? (
                  <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[6rem_1fr]">
                    <dt>规范路径</dt>
                    <dd className="break-all font-mono">{validation.canonicalPath}</dd>
                    <dt>分支</dt>
                    <dd className="font-mono">{validation.branch}</dd>
                    <dt>基准 SHA</dt>
                    <dd className="break-all font-mono">{validation.baseSha}</dd>
                    <dt>工作区</dt>
                    <dd>{validation.dirty ? "有未提交改动，不能开始" : "干净，可分析"}</dd>
                  </dl>
                ) : (
                  <ul>
                    {validation.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            <label className="mt-4 block text-xs text-mute">
              计划目标
              <Textarea
                data-testid="orchestrator-prompt"
                className="mt-1 min-h-28 text-sm"
                aria-label="计划目标"
                placeholder="例如：为这个项目增加离线导出，并补齐测试和文档"
                value={controller.prompt}
                onChange={(event) => controller.setPrompt(event.target.value)}
                disabled={
                  Boolean(controller.loading) ||
                  Boolean(controller.run && ACTIVE_STATUSES.has(controller.run.status))
                }
              />
            </label>

            <label className="mt-4 block max-w-xs text-xs text-mute">
              调度负责人
              <select
                data-testid="orchestrator-coordinator"
                aria-label="调度负责人"
                className="mt-1 h-11 w-full rounded-xl bg-raised px-3 text-sm text-ink shadow-[var(--shadow-border)]"
                value={controller.coordinatorChoice}
                onChange={(event) =>
                  controller.setCoordinatorChoice(event.target.value as "auto" | NativeAgentId)
                }
                disabled={Boolean(controller.loading)}
              >
                <option value="auto">自动选择额度最多的 Agent</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="grok">Grok</option>
              </select>
            </label>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {(Object.keys(AGENTS) as NativeAgentId[]).map((agent) => (
                <div
                  key={agent}
                  className="rounded-xl bg-raised px-3 py-3"
                  data-testid={`orchestrator-capacity-${agent}`}
                >
                  <p className={`text-sm font-medium text-${agent}`}>{AGENTS[agent].name}</p>
                  <p className="mt-1 font-mono text-xs text-ink">
                    {capacityText(quotaEvidence[agent])}
                  </p>
                  <p className="mt-1 text-xs text-mute">
                    可信度 {quotaEvidence[agent].valueConfidence} · 单任务并发
                  </p>
                </div>
              ))}
            </div>

            <Button
              className="mt-4"
              data-testid="orchestrator-analyze"
              onClick={() => void controller.analyze()}
              disabled={!canAnalyze}
            >
              {controller.loading === "analyze" ? "正在拆解计划" : "分析并自动分配"}
            </Button>
          </Card>

          {controller.draft ? (
            <Card data-testid="orchestrator-plan">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{controller.draft.plan.title}</CardTitle>
                  <CardHint className="mt-1">{controller.draft.plan.summary}</CardHint>
                </div>
                <Badge tone={AGENTS[controller.draft.coordinator].tone}>
                  负责人：{AGENTS[controller.draft.coordinator].name}
                </Badge>
              </div>

              {controller.run?.status === "capacity_blocked" ? (
                <p className="mt-4 rounded-xl bg-warn/10 px-3 py-3 text-sm text-warn">
                  capacity_blocked：当前可信额度不足，计划已保留，但不会启动原生 Agent。
                </p>
              ) : null}

              <div className="mt-4 space-y-3">
                {controller.draft.assignedTasks.map((task) => (
                  <article
                    key={task.id}
                    className="rounded-xl bg-raised p-3"
                    data-testid={`orchestrator-task-${task.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-ink">{task.title}</p>
                      <Badge tone={AGENTS[task.assignedAgent].tone}>
                        {AGENTS[task.assignedAgent].name}
                      </Badge>
                      <Badge>规模：{SIZE[task.size]}</Badge>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-mute">{task.description}</p>
                    <dl className="mt-3 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[5rem_1fr]">
                      <dt className="text-faint">依赖</dt>
                      <dd>{task.dependsOn.length ? task.dependsOn.join("、") : "无"}</dd>
                      <dt className="text-faint">预计文件</dt>
                      <dd className="break-all font-mono">{task.expectedFiles.join("、")}</dd>
                      <dt className="text-faint">验收标准</dt>
                      <dd>
                        <ul className="list-disc space-y-1 pl-4">
                          {task.acceptanceCriteria.map((criterion) => (
                            <li key={criterion}>{criterion}</li>
                          ))}
                        </ul>
                      </dd>
                      <dt className="text-faint">验收命令</dt>
                      <dd className="space-y-1">
                        {task.verificationCommands.map((command) => (
                          <code
                            key={JSON.stringify(command)}
                            className="block break-all rounded-lg bg-canvas px-2 py-1"
                          >
                            {JSON.stringify([command.executable, ...command.args])}
                          </code>
                        ))}
                      </dd>
                    </dl>
                    <p className="mt-3 text-xs text-faint">
                      工作目录：独立任务 worktree · 最小环境：隔离 HOME/TMP、固定
                      PATH、无交互凭据提示
                    </p>
                  </article>
                ))}
              </div>

              {controller.run?.status === "draft" ? (
                <div className="mt-4 rounded-xl border border-line p-3">
                  <label className="flex items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      data-testid="orchestrator-trust"
                      checked={trusted}
                      onChange={(event) => setTrusted(event.target.checked)}
                    />
                    <span>
                      我信任仓库{" "}
                      <code className="font-mono text-xs">{controller.draft.repositoryPath}</code>，
                      并允许原生 Agent 在隔离 worktree 中读取和修改代码、运行上列验收命令。
                    </span>
                  </label>
                  <Button
                    className="mt-3"
                    data-testid="orchestrator-start"
                    onClick={() => void controller.start()}
                    disabled={!canStart}
                  >
                    {controller.loading === "start" ? "正在启动" : "确认并开始执行"}
                  </Button>
                </div>
              ) : null}
            </Card>
          ) : null}

          {controller.run ? (
            <Card data-testid="orchestrator-run">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>运行状态 · {STATUS[controller.run.status]}</CardTitle>
                  <CardHint className="mt-1 font-mono">{controller.run.id}</CardHint>
                </div>
                {ACTIVE_STATUSES.has(controller.run.status) ? (
                  <Button
                    variant="secondary"
                    data-testid="orchestrator-cancel"
                    onClick={() => void controller.cancel()}
                    disabled={Boolean(controller.loading)}
                  >
                    {controller.loading === "cancel" ? "正在取消" : "取消运行"}
                  </Button>
                ) : null}
              </div>

              {controller.run.status === "interrupted" ? (
                <p className="mt-3 rounded-xl bg-warn/10 px-3 py-3 text-sm text-warn">
                  此运行在 sidecar 退出时中断，仅可查看，不能自动续跑。请重新分析后开始新运行。
                </p>
              ) : null}
              {controller.run.error ? (
                <p className="mt-3 rounded-xl bg-crit/10 px-3 py-3 text-sm text-crit" role="alert">
                  {controller.run.error}
                </p>
              ) : null}
              {controller.run.status === "completed" ? (
                <dl className="mt-3 grid gap-x-4 gap-y-1 rounded-xl bg-ok/10 px-3 py-3 text-xs text-ok sm:grid-cols-[6rem_1fr]">
                  <dt>结果分支</dt>
                  <dd className="break-all font-mono">{controller.run.resultBranch}</dd>
                  <dt>整合目录</dt>
                  <dd className="break-all font-mono">
                    {controller.run.integrationWorktree?.path}
                  </dd>
                </dl>
              ) : null}

              <div className="mt-4" data-testid="orchestrator-events">
                <p className="text-xs text-faint">归一化事件 · seq {controller.afterSeq}</p>
                <ol className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                  {controller.events.map((record) => (
                    <li
                      key={record.seq}
                      className="rounded-xl bg-raised px-3 py-2 text-xs text-mute"
                    >
                      <span className="mr-2 font-mono text-faint">#{record.seq}</span>
                      {record.agent ? (
                        <span className={`mr-2 text-${record.agent}`}>
                          {AGENTS[record.agent].name}
                        </span>
                      ) : null}
                      <span className="whitespace-pre-wrap break-words">
                        {eventText(record.event)}
                      </span>
                    </li>
                  ))}
                  {controller.events.length === 0 ? (
                    <li className="text-xs text-faint">尚无事件</li>
                  ) : null}
                </ol>
              </div>
            </Card>
          ) : null}

          {controller.error ? (
            <p className="rounded-xl bg-crit/10 px-3 py-3 text-sm text-crit" role="alert">
              {controller.error}
            </p>
          ) : null}
        </div>

        <Card className="h-fit" data-testid="orchestrator-history">
          <CardTitle>最近运行</CardTitle>
          <CardHint className="mt-1">历史只恢复查看；中断任务不会自动继续。</CardHint>
          <div className="mt-3 space-y-2">
            {controller.history.map((summary) => (
              <button
                key={summary.id}
                type="button"
                className={cn(
                  "w-full rounded-xl bg-raised px-3 py-3 text-left text-xs transition-colors hover:text-ink",
                  controller.run?.id === summary.id
                    ? "text-ink shadow-[var(--shadow-border)]"
                    : "text-mute",
                )}
                onClick={() => void controller.selectRun(summary.id)}
                disabled={Boolean(controller.loading)}
              >
                <span className="block font-mono">{summary.id}</span>
                <span className="mt-1 flex justify-between gap-2">
                  <span>{STATUS[summary.status]}</span>
                  <span>{AGENTS[summary.coordinator].name}</span>
                </span>
              </button>
            ))}
            {controller.history.length === 0 ? (
              <p className="text-xs text-faint">还没有调度记录</p>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
