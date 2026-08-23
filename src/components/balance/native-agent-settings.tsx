import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  detectNativeAgentRuntimes,
  getNativeAgentSettings,
  saveNativeAgentSettings,
} from "@/lib/orchestrator/actions";
import { getOrchestratorAuthorization } from "@/lib/orchestrator/capability";
import type {
  AgentRuntimeProbe,
  NativeAgentId,
  OrchestratorSettings,
} from "@/lib/orchestrator/types";
import { cn } from "@/lib/utils";

const AGENTS: Record<NativeAgentId, { name: string; defaultCommand: string }> = {
  claude: { name: "Claude Code", defaultCommand: "claude" },
  codex: { name: "Codex CLI", defaultCommand: "codex" },
  grok: { name: "Grok CLI", defaultCommand: "grok" },
};

const EMPTY_SETTINGS: OrchestratorSettings = {
  globalMaxConcurrency: 3,
  agents: {
    claude: { agent: "claude", enabled: true, binaryPath: null, allowUnknownQuota: false },
    codex: { agent: "codex", enabled: true, binaryPath: null, allowUnknownQuota: false },
    grok: { agent: "grok", enabled: true, binaryPath: null, allowUnknownQuota: false },
  },
};

const EMPTY_RUNTIMES: Record<NativeAgentId, AgentRuntimeProbe | null> = {
  claude: null,
  codex: null,
  grok: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NativeAgentSettings() {
  const [settings, setSettings] = useState<OrchestratorSettings>(EMPTY_SETTINGS);
  const [runtimes, setRuntimes] = useState(EMPTY_RUNTIMES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const authorization = getOrchestratorAuthorization();
    void Promise.all([
      getNativeAgentSettings({ data: { authorization } }),
      detectNativeAgentRuntimes({ data: { authorization } }),
    ])
      .then(([loadedSettings, detected]) => {
        if (cancelled) return;
        setSettings(loadedSettings);
        setRuntimes(detected);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateAgent = (
    agent: NativeAgentId,
    patch: Partial<OrchestratorSettings["agents"][NativeAgentId]>,
  ) => {
    setSettings((current) => ({
      ...current,
      agents: {
        ...current.agents,
        [agent]: { ...current.agents[agent], ...patch },
      },
    }));
  };

  const saveAndDetect = async () => {
    setSaving(true);
    setLoadError(null);
    const authorization = getOrchestratorAuthorization();
    try {
      const saved = await saveNativeAgentSettings({ data: { authorization, settings } });
      const detected = await detectNativeAgentRuntimes({ data: { authorization } });
      setSettings(saved);
      setRuntimes(detected);
      const unavailable = (Object.keys(AGENTS) as NativeAgentId[]).filter(
        (agent) => saved.agents[agent].enabled && !detected[agent].ok,
      );
      if (unavailable.length > 0) {
        toast.error(
          `已保存，但 ${unavailable.map((agent) => AGENTS[agent].name).join("、")} 不可用`,
        );
      } else {
        toast.success("原生 Agent 设置已保存并检测通过");
      }
    } catch (error) {
      const message = errorMessage(error);
      for (const agent of Object.keys(AGENTS) as NativeAgentId[]) {
        if (!message.toLowerCase().startsWith(agent)) continue;
        setRuntimes((current) => ({
          ...current,
          [agent]: { agent, ok: false, path: null, version: null, error: message },
        }));
      }
      setLoadError(message);
      toast.error("保存或检测失败，请检查路径");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="native-agent-settings">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Agent 与 CLI</CardTitle>
          <CardHint className="mt-1 leading-relaxed">
            Balance 直接调用设备上已经登录的原生 CLI，不安装客户端，也不复制认证文件。 每个 Agent
            同时只运行 1 个任务。
          </CardHint>
        </div>
        <Button
          variant="secondary"
          onClick={() => void saveAndDetect()}
          disabled={saving || loading}
        >
          <RefreshCw className={saving ? "animate-spin" : undefined} />
          {saving ? "检测中" : "保存并检测"}
        </Button>
      </div>

      <label className="mt-4 block max-w-xs text-xs text-mute">
        全局并发任务数
        <select
          className="mt-1 h-11 w-full rounded-xl bg-raised px-3 text-sm text-ink shadow-[var(--shadow-border)]"
          value={settings.globalMaxConcurrency}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              globalMaxConcurrency: Number(event.target.value) as 1 | 2 | 3,
            }))
          }
          disabled={loading || saving}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </label>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {(Object.keys(AGENTS) as NativeAgentId[]).map((agent) => {
          const runtime = runtimes[agent];
          const configured = settings.agents[agent];
          return (
            <div
              key={agent}
              className="rounded-xl bg-raised p-3"
              data-testid={`native-agent-${agent}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">{AGENTS[agent].name}</p>
                  <p className={cn("mt-0.5 text-xs", runtime?.ok ? "text-ok" : "text-mute")}>
                    {runtime?.ok
                      ? `${runtime.version ?? "已检测"} · 单任务并发`
                      : (runtime?.error ?? (loading ? "正在检测" : "尚未检测"))}
                  </p>
                </div>
                <Switch
                  checked={configured.enabled}
                  aria-label={`启用 ${AGENTS[agent].name}`}
                  onCheckedChange={(enabled) => updateAgent(agent, { enabled })}
                  disabled={loading || saving}
                />
              </div>
              <label className="mt-3 block text-xs text-mute">
                可执行文件路径
                <Input
                  className="mt-1 font-mono text-xs"
                  aria-label={`${AGENTS[agent].name} 可执行文件路径`}
                  value={configured.binaryPath ?? ""}
                  placeholder={`自动查找 ${AGENTS[agent].defaultCommand}`}
                  onChange={(event) =>
                    updateAgent(agent, {
                      binaryPath: event.target.value.trim() ? event.target.value : null,
                    })
                  }
                  disabled={loading || saving}
                  spellCheck={false}
                />
              </label>
              <label className="mt-3 flex items-center justify-between gap-3 text-xs text-mute">
                额度未知时允许分配
                <Switch
                  checked={configured.allowUnknownQuota}
                  aria-label={`${AGENTS[agent].name} 额度未知时允许分配`}
                  onCheckedChange={(allowUnknownQuota) => updateAgent(agent, { allowUnknownQuota })}
                  disabled={loading || saving}
                />
              </label>
            </div>
          );
        })}
      </div>

      {loadError ? (
        <p className="mt-3 rounded-xl bg-crit/10 px-3 py-2 text-xs text-crit" role="alert">
          {loadError}
        </p>
      ) : null}
    </Card>
  );
}
