import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export type ViewId = "monitor" | "report" | "plugin" | "settings";

const NAV: { id: ViewId; label: string }[] = [
  { id: "monitor", label: "监控" },
  { id: "report", label: "报告" },
  { id: "plugin", label: "插件" },
  { id: "settings", label: "设置" },
];

export function Header({
  view,
  onView,
  live,
  watchText,
}: {
  view: ViewId;
  onView: (id: ViewId) => void;
  live: boolean;
  watchText?: string;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 text-ink no-underline">
          <span className="grid size-8 place-items-center rounded-md bg-raised shadow-[var(--shadow-border)]">
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
              <path
                d="M2 16a10 10 0 0 1 20 0"
                fill="none"
                stroke="currentColor"
                className="text-grok"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M5 16a7 7 0 0 1 14 0"
                fill="none"
                stroke="currentColor"
                className="text-claude"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M8.5 16a3.5 3.5 0 0 1 7 0"
                fill="none"
                stroke="currentColor"
                className="text-codex"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-medium tracking-tight">Synq</span>
            <span className="hidden text-xs text-mute sm:block">三路 Agent 额度</span>
          </span>
        </Link>

        <nav className="ml-1 flex items-center rounded-lg bg-surface p-1 shadow-[var(--shadow-border)] sm:ml-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onView(item.id)}
              className={cn(
                "h-9 rounded-md px-2 text-sm transition-colors duration-150 sm:px-3",
                view === item.id ? "bg-raised text-ink" : "text-mute hover:text-ink",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-xs text-mute md:flex">
            <span className={cn("size-1.5 rounded-full", live || watchText ? "bg-ok" : "bg-faint")} />
            {watchText ?? (live ? "协同采集中" : "采集已暂停")}
          </span>
        </div>
      </div>
    </header>
  );
}
