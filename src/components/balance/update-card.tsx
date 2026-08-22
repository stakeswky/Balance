import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { applyDesktopUpdate, checkDesktopUpdate } from "@/lib/desktop-update/actions";
import { installNativeUpdate } from "@/lib/desktop-update/native-installer";

type UpdateView =
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "hot"; current: string; next: string }
  | { kind: "installer"; current: string; next: string }
  | { kind: "applying"; mode: "hot" | "native"; percent?: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function currentVersion(local: { packVersion?: string } | undefined): string {
  return local?.packVersion || "未知";
}

function DesktopUpdateCard() {
  const [view, setView] = useState<UpdateView>({ kind: "checking" });
  const updaterE2E = import.meta.env.VITE_DESKTOP_UPDATER_E2E === "true";

  const check = async () => {
    setView({ kind: "checking" });
    if (updaterE2E) {
      setView({ kind: "installer", current: "0.3.0", next: "0.3.1" });
      return;
    }
    try {
      const result = await checkDesktopUpdate();
      if (result.kind === "hot") {
        setView({
          kind: "hot",
          current: currentVersion(result.local),
          next: result.packVersion,
        });
        return;
      }
      if (result.kind === "installer") {
        setView({
          kind: "installer",
          current: currentVersion(result.local),
          next: result.packVersion,
        });
        return;
      }
      if (result.kind === "current") {
        setView({ kind: "current", version: currentVersion(result.local) });
        return;
      }
      setView({ kind: "error", message: "无法检查更新" });
      toast.error("无法检查更新");
    } catch {
      setView({ kind: "error", message: "无法检查更新" });
      toast.error("无法检查更新");
    }
  };

  const installNative = async () => {
    setView({ kind: "applying", mode: "native", percent: 0 });
    const installed = await installNativeUpdate({
      onProgress: ({ percent }) => {
        setView({ kind: "applying", mode: "native", percent });
      },
    });
    setView({ kind: "ready", version: installed.version });
  };

  const apply = async () => {
    const candidate = view;
    if (candidate.kind !== "hot" && candidate.kind !== "installer") {
      return;
    }

    try {
      if (candidate.kind === "installer") {
        await installNative();
        return;
      }

      setView({ kind: "applying", mode: "hot" });
      const result = await applyDesktopUpdate();
      if (result.kind === "ready-restart") {
        setView({ kind: "ready", version: result.packVersion });
        return;
      }
      if (result.kind === "installer") {
        await installNative();
        return;
      }
      if (result.kind === "current") {
        setView({ kind: "current", version: "当前" });
        toast.message("已是最新版本");
        return;
      }
      setView({ kind: "error", message: "自动更新失败，请检查网络后重试" });
      toast.error("自动更新失败，请检查网络后重试");
    } catch {
      setView({ kind: "error", message: "自动更新失败，请检查网络后重试" });
      toast.error("自动更新失败，请检查网络后重试");
    }
  };

  useEffect(() => {
    void check();
  }, []);

  const busy = view.kind === "checking" || view.kind === "applying";

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>应用更新</CardTitle>
          <CardHint className="mt-1">
            只改界面和采集逻辑时会直接更新；需要更新桌面组件时，会自动下载并安装完整应用。
          </CardHint>
          <p className="mt-3 text-sm leading-relaxed text-mute">
            {view.kind === "checking" ? "正在检查更新…" : null}
            {view.kind === "current" ? `当前版本 ${view.version}，已是最新。` : null}
            {view.kind === "hot" ? `当前 ${view.current}，可更新到 ${view.next}。` : null}
            {view.kind === "installer"
              ? `当前 ${view.current}。${view.next} 需要更新桌面组件。点击更新后会自动下载并安装完整应用。`
              : null}
            {view.kind === "applying" && view.mode === "hot" ? "正在应用热更新…" : null}
            {view.kind === "applying" && view.mode === "native"
              ? view.percent === undefined
                ? "正在下载并安装完整更新…"
                : `正在下载并安装完整更新（${view.percent}%）…`
              : null}
            {view.kind === "ready"
              ? `更新到 ${view.version} 已完成。请从菜单栏选择「退出余量」，再重新打开即可使用最新版本。`
              : null}
            {view.kind === "error" ? view.message : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {view.kind === "hot" || view.kind === "installer" ? (
            <Button onClick={() => void apply()} disabled={busy}>
              更新
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => void check()} disabled={busy}>
            <RefreshCw className={view.kind === "checking" ? "animate-spin" : undefined} />
            {view.kind === "checking" ? "检查中" : "检查更新"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function UpdateCard() {
  if (import.meta.env.VITE_DESKTOP !== "true") {
    return null;
  }
  return <DesktopUpdateCard />;
}
