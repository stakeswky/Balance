import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { useQuota } from "@/lib/quota/store";
import type { AgentId } from "@/lib/quota/types";

const SAMPLE = `{
  "model": "sonnet",
  "timestamp": ${Date.now() - 120000},
  "session_id": "cc_demo",
  "task": "导入的一次会话",
  "usage": {
    "input_tokens": 8200,
    "output_tokens": 1100,
    "cache_read_input_tokens": 24000,
    "cache_creation_input_tokens": 1800
  }
}`;

const ADAPTER: Record<
  AgentId,
  { name: string; path: string; detail: string; textClass: string }
> = {
  claude: {
    name: "Claude Code",
    path: "~/.claude/projects/**/*.jsonl",
    detail: "会话 token 读 jsonl；订阅百分比读桌面 plan-usage-history（5h / 7d）。",
    textClass: "text-claude",
  },
  grok: {
    name: "Grok CLI / Grok Build",
    path: "~/.grok/sessions/**/updates.jsonl",
    detail: "会话 token 读 updates.jsonl；周额度读官方账单接口，日志作后备。",
    textClass: "text-grok",
  },
  codex: {
    name: "Codex CLI",
    path: "~/.codex/sessions/**/rollout-*.jsonl",
    detail:
      "会话 token 读 token_count.last_token_usage；订阅百分比读官方 /wham/usage，jsonl rate_limits 作后备。",
    textClass: "text-codex",
  },
};

const DEFAULT_LABEL: Record<AgentId, string> = {
  claude: "默认 Claude",
  grok: "默认 Grok",
  codex: "默认 Codex",
};

export function PluginPanel({ agents }: { agents: readonly AgentId[] }) {
  const importText = useQuota((s) => s.importText);
  const loadImported = useQuota((s) => s.loadImported);
  const [blob, setBlob] = useState(SAMPLE);
  const [agent, setAgent] = useState<AgentId | null>(agents[0] ?? null);
  const selectedAgent = agent && agents.includes(agent) ? agent : (agents[0] ?? null);

  useEffect(() => {
    if (agent && agents.includes(agent)) return;
    setAgent(agents[0] ?? null);
  }, [agent, agents]);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardTitle>适配器</CardTitle>
        <CardHint className="mt-1">
          Sidecar 只读监听已启用 Agent 的会话落盘，订阅百分比走官方接口。
        </CardHint>
        <ul className="mt-4 space-y-3 text-sm">
          {agents.map((id) => (
            <li key={id} className="rounded-lg bg-raised px-3 py-3">
              <p className={`font-medium ${ADAPTER[id].textClass}`}>{ADAPTER[id].name}</p>
              <p className="mt-1 font-mono text-xs text-mute">{ADAPTER[id].path}</p>
              <p className="mt-1 text-xs text-mute">{ADAPTER[id].detail}</p>
            </li>
          ))}
        </ul>
        {agents.length ? (
          <p className="mt-4 text-xs leading-relaxed text-mute">
            采集打开时只读轮询本机 jsonl 并按事件标识去重。无需粘贴；右侧仍可手动并入。
          </p>
        ) : (
          <p className="mt-4 rounded-lg bg-raised px-3 py-4 text-sm leading-relaxed text-mute">
            暂无可用适配器。请到设置重新检测本机 Agent，或开启演示数据。
          </p>
        )}
      </Card>

      <Card>
        <CardTitle>导入用量</CardTitle>
        <CardHint className="mt-1">支持单条 JSON、数组，或 Claude Code 风格 JSONL。</CardHint>
        <div className="mt-4 flex flex-wrap gap-2">
          {agents.map((id) => (
            <Button
              key={id}
              variant={selectedAgent === id ? id : "secondary"}
              onClick={() => setAgent(id)}
            >
              {DEFAULT_LABEL[id]}
            </Button>
          ))}
        </div>
        {agents.length === 0 ? (
          <p className="mt-4 rounded-lg bg-raised px-3 py-4 text-sm leading-relaxed text-mute">
            当前没有导入目标。重新检测或开启演示后即可并入用量。
          </p>
        ) : null}
        <Textarea
          className="mt-3"
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          spellCheck={false}
          aria-label="用量 JSON"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={!selectedAgent}
            onClick={() => {
              if (!selectedAgent) return;
              const n = importText(blob, selectedAgent);
              if (n) toast.success(`已并入 ${n} 条事件`);
              else toast.error("没有解析到有效用量");
            }}
          >
            并入额度
          </Button>
          {agents.includes("claude") ? (
            <Button
              variant="claude"
              onClick={() => {
                const n = loadImported();
                if (n) toast.success(`已载入 ${n} 条 Claude Code 记录`);
                else toast.error("没有解析到有效用量");
              }}
            >
              载入 Claude 导出
            </Button>
          ) : null}
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <CardTitle>事件协议</CardTitle>
        <CardHint className="mt-1">本地 sidecar 或 CI 钩子按此形状推送即可。</CardHint>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-raised p-4 font-mono text-xs leading-relaxed text-mute">
{`type UsageEvent = {
  agent: "claude" | "grok" | "codex"
  model: string
  timestamp: number | ISO8601
  session_id: string
  task?: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_minutes?: number   // Codex
  }
}`}
        </pre>
      </Card>
    </div>
  );
}
