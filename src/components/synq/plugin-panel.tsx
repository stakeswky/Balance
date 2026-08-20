import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { useQuota } from "@/lib/quota/store";
import type { AgentId } from "@/lib/quota/types";

const SAMPLE = `{
  "agent": "claude",
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

export function PluginPanel() {
  const importText = useQuota((s) => s.importText);
  const loadImported = useQuota((s) => s.loadImported);
  const [blob, setBlob] = useState(SAMPLE);
  const [agent, setAgent] = useState<AgentId>("claude");

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardTitle>适配器</CardTitle>
        <CardHint className="mt-1">Sidecar 只读监听三款 Agent 的会话落盘，订阅百分比走官方接口。</CardHint>
        <ul className="mt-4 space-y-3 text-sm">
          <li className="rounded-lg bg-raised px-3 py-3">
            <p className="font-medium text-claude">Claude Code</p>
            <p className="mt-1 font-mono text-xs text-mute">~/.claude/projects/**/*.jsonl</p>
            <p className="mt-1 text-xs text-mute">
              会话 token 读 jsonl；订阅百分比读桌面 plan-usage-history（5h / 7d）。
            </p>
          </li>
          <li className="rounded-lg bg-raised px-3 py-3">
            <p className="font-medium text-grok">Grok CLI / Grok Build</p>
            <p className="mt-1 font-mono text-xs text-mute">~/.grok/sessions/**/updates.jsonl</p>
            <p className="mt-1 text-xs text-mute">
              会话 token 读 updates.jsonl；周额度读官方账单接口，日志作后备。
            </p>
          </li>
          <li className="rounded-lg bg-raised px-3 py-3">
            <p className="font-medium text-codex">Codex CLI</p>
            <p className="mt-1 font-mono text-xs text-mute">~/.codex/sessions/**/rollout-*.jsonl</p>
            <p className="mt-1 text-xs text-mute">
              会话 token 读 token_count.last_token_usage；订阅百分比读官方 /wham/usage，jsonl rate_limits 作后备。
            </p>
          </li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-mute">
          采集打开时只读轮询本机 jsonl（Claude 按 requestId，Grok 按 prompt_id，Codex 按 token_count 时间戳去重）。无需粘贴；右侧仍可手动并入。
        </p>
      </Card>

      <Card>
        <CardTitle>导入用量</CardTitle>
        <CardHint className="mt-1">支持单条 JSON、数组，或 Claude Code 风格 JSONL。</CardHint>
        <div className="mt-4 flex gap-2">
          <Button
            size="sm"
            variant={agent === "claude" ? "claude" : "secondary"}
            onClick={() => setAgent("claude")}
          >
            默认 Claude
          </Button>
          <Button
            size="sm"
            variant={agent === "grok" ? "grok" : "secondary"}
            onClick={() => setAgent("grok")}
          >
            默认 Grok
          </Button>
          <Button
            size="sm"
            variant={agent === "codex" ? "codex" : "secondary"}
            onClick={() => setAgent("codex")}
          >
            默认 Codex
          </Button>
        </div>
        <Textarea
          className="mt-3"
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          spellCheck={false}
          aria-label="用量 JSON"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              const n = importText(blob, agent);
              if (n) toast.success(`已并入 ${n} 条事件`);
              else toast.error("没有解析到有效用量");
            }}
          >
            并入额度
          </Button>
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
