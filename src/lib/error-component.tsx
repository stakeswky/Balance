import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ink">
      <span className="text-crit" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={1.75} />
      </span>
      <h1 className="text-lg font-medium">出错了</h1>
      <p className="max-w-md text-sm break-words text-mute">
        {error.message || "发生了意外错误，请刷新后重试。"}
      </p>
    </main>
  );
}
