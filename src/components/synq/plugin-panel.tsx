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
  const [blob, setBlob] = useState(SAMPLE);
  const [agent, setAgent] = useState<AgentId>("claude");

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardTitle>适配器</CardTitle>
        <CardHint className="mt-1">Sidecar 并排监听两款 Agent 的会话落盘，统一折成额度。</CardHint>
        <ul className="mt-4 space-y-3 text-sm">
          <li className="rounded-lg bg-raised px-3 py-3">
            <p className="font-medium text-claude">Claude Code</p>
            <p className="mt-1 font-mono text-xs text-mute">~/.claude/projects/**/*.jsonl</p>
            <p className="mt-1 text-xs text-mute">读取 message.usage，含 cache read / write。</p>
          </li>
          <li className="rounded-lg bg-raised px-3 py-3">
            <p className="font-medium text-codex">Codex CLI</p>
            <p className="mt-1 font-mono text-xs text-mute">~/.codex/sessions · /status · /usage</p>
            <p className="mt-1 text-xs text-mute">同时计量 token 与推理分钟，对齐 5 小时窗。</p>
          </li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-mute">
          预览里用实时模拟代替本机文件监听。把 JSON / JSONL 粘贴到右侧即可并入计算。
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
        <Button
          className="mt-3"
          onClick={() => {
            const n = importText(blob, agent);
            if (n) toast.success(`已并入 ${n} 条事件`);
            else toast.error("没有解析到有效用量");
          }}
        >
          并入额度
        </Button>
      </Card>

      <Card className="lg:col-span-2">
        <CardTitle>事件协议</CardTitle>
        <CardHint className="mt-1">本地 sidecar 或 CI 钩子按此形状推送即可。</CardHint>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-raised p-4 font-mono text-xs leading-relaxed text-mute">
{`type UsageEvent = {
  agent: "claude" | "codex"
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
