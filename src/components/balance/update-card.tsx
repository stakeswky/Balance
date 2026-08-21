import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { applyDesktopUpdate, checkDesktopUpdate } from "@/lib/desktop-update/actions";

type UpdateView =
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "hot"; current: string; next: string }
  | { kind: "installer"; current: string; next: string; url: string }
  | { kind: "applying" }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function currentVersion(local: { packVersion?: string } | undefined): string {
  return local?.packVersion || "未知";
}

async function copyInstallerUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("已复制安装包链接");
  } catch {
    toast.message(`请复制链接：${url}`);
  }
}

function DesktopUpdateCard() {
  const [view, setView] = useState<UpdateView>({ kind: "checking" });

  const check = async () => {
    setView({ kind: "checking" });
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
          url: result.url,
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

  const apply = async () => {
    setView({ kind: "applying" });
    try {
      const result = await applyDesktopUpdate();
      if (result.kind === "ready-restart") {
        setView({ kind: "ready", version: result.packVersion });
        return;
      }
      if (result.kind === "installer") {
        setView({
          kind: "installer",
          current: "当前",
          next: result.packVersion,
          url: result.url,
        });
        return;
      }
      if (result.kind === "current") {
        setView({ kind: "current", version: "当前" });
        toast.message("已是最新版本");
        return;
      }
      setView({ kind: "error", message: "更新失败" });
      toast.error("更新失败");
    } catch {
      setView({ kind: "error", message: "更新失败" });
      toast.error("更新失败");
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
            仓库发布后，若只改了界面和采集逻辑，可以直接更新，不用重新下载安装包。改了桌面壳则仍需安装包。
          </CardHint>
          <p className="mt-3 text-sm leading-relaxed text-mute">
            {view.kind === "checking" ? "正在检查更新…" : null}
            {view.kind === "current" ? `当前版本 ${view.version}，已是最新。` : null}
            {view.kind === "hot" ? `当前 ${view.current}，可更新到 ${view.next}。` : null}
            {view.kind === "installer"
              ? `当前 ${view.current}。${view.next} 改了桌面壳，需要重新下载安装包。`
              : null}
            {view.kind === "applying" ? "正在更新…" : null}
            {view.kind === "ready"
              ? `更新完成。请从菜单栏选择「退出余量」，再重新打开。关闭窗口不够。`
              : null}
            {view.kind === "error" ? view.message : null}
          </p>
          {view.kind === "installer" ? (
            <p className="mt-2 break-all font-mono text-xs text-faint">{view.url}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {view.kind === "hot" ? (
            <Button onClick={() => void apply()} disabled={busy}>
              更新
            </Button>
          ) : null}
          {view.kind === "installer" ? (
            <Button
              onClick={() => void copyInstallerUrl(view.url)}
              disabled={busy}
              aria-label="下载安装包"
            >
              复制链接
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => void check()} disabled={busy}>
            <RefreshCw className={view.kind === "checking" ? "animate-spin" : undefined} />
            {view.kind === "checking" ? "检查中" : "检查更新"}
          </Button>
        </div>
      </div>
      {view.kind === "installer" ? (
        <p className="sr-only">下载安装包</p>
      ) : null}
    </Card>
  );
}

export function UpdateCard() {
  if (import.meta.env.VITE_DESKTOP !== "true") {
    return null;
  }
  return <DesktopUpdateCard />;
}
