import { Link, createFileRoute } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 text-ink">
      <div className="w-full max-w-sm">
        <Link to="/" className="text-xs text-mute no-underline hover:text-ink">
          返回监控
        </Link>
        <div className="mt-8 grid size-12 place-items-center rounded-lg bg-raised shadow-[var(--shadow-border)]">
          <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
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
        </div>
        <h1 className="mt-5 text-2xl font-medium tracking-tight">登录 Synq</h1>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          套餐选择会同步到你的账号。未登录也能在预览里完整使用监控。
        </p>
        <div className="mt-6 space-y-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
              >
                使用 {p.label} 继续
              </Button>
            ))
          ) : (
            <p className="text-sm text-mute">登录已关闭。</p>
          )}
        </div>
      </div>
    </main>
  );
}
