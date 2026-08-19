import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/synq/dashboard";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) {
    return (
      <div className="min-h-dvh bg-canvas px-4 py-8 text-ink">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="h-16 rounded-xl bg-surface" />
          <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
            <div className="h-64 rounded-2xl bg-surface" />
            <div className="h-64 rounded-2xl bg-surface" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="h-80 rounded-2xl bg-surface" />
            <div className="h-80 rounded-2xl bg-surface" />
          </div>
        </div>
      </div>
    );
  }
  return <Dashboard />;
}
