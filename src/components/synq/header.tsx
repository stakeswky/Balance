import { Link } from "@tanstack/react-router";
import { authEnabled, signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { cn } from "@/lib/utils";

export type ViewId = "monitor" | "plans" | "report" | "plugin";

const NAV: { id: ViewId; label: string }[] = [
  { id: "monitor", label: "监控" },
  { id: "plans", label: "套餐" },
  { id: "report", label: "报告" },
  { id: "plugin", label: "插件" },
];

export function Header({
  view,
  onView,
  live,
}: {
  view: ViewId;
  onView: (id: ViewId) => void;
  live: boolean;
}) {
  const { user, isPending } = useCurrentUserState();
  const label = user?.displayName ?? user?.primaryEmail ?? "账号";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 text-ink no-underline">
          <span className="grid size-8 place-items-center rounded-md bg-raised shadow-[var(--shadow-border)]">
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
              <path
                d="M4 16a8 8 0 0 1 16 0"
                fill="none"
                stroke="currentColor"
                className="text-claude"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M8 16a4 4 0 0 1 8 0"
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
            <span className="hidden text-[11px] text-mute sm:block">双 Agent 额度</span>
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
            <span className={cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint")} />
            {live ? "协同采集中" : "采集已暂停"}
          </span>
          {isPending ? (
            <div className="size-8 animate-pulse rounded-full bg-raised" />
          ) : user ? (
            <div className="flex items-center gap-2">
              {user.profileImageUrl ? (
                <img
                  src={user.profileImageUrl}
                  alt=""
                  className="size-8 rounded-full object-cover outline outline-1 -outline-offset-1 outline-ink/10"
                />
              ) : (
                <span className="grid size-8 place-items-center rounded-full bg-raised text-xs font-medium">
                  {label.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="hidden max-w-28 truncate text-sm sm:inline">{label}</span>
              {authEnabled ? (
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="text-xs text-mute hover:text-ink"
                >
                  退出
                </button>
              ) : null}
            </div>
          ) : (
            <Link
              to="/login"
              className="inline-flex h-11 items-center rounded-md bg-raised px-3 text-sm text-ink no-underline shadow-[var(--shadow-border)] hover:shadow-[var(--shadow-border-hover)]"
            >
              登录
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
