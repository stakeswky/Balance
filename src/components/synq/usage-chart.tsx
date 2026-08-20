import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { hourlySeries } from "@/lib/quota/engine";
import type { UsageEvent } from "@/lib/quota/types";
import { formatTokens } from "./format";

export function UsageChart({ events, now }: { events: UsageEvent[]; now: number }) {
  const data = hourlySeries(events, now, 24);
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="gClaude" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-claude)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="var(--color-claude)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gGrok" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-grok)" stopOpacity={0.42} />
              <stop offset="100%" stopColor="var(--color-grok)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gCodex" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-codex)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--color-codex)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-faint)", fontSize: 10, fontFamily: "IBM Plex Mono" }}
            tickLine={false}
            axisLine={false}
            interval={3}
          />
          <YAxis
            tickFormatter={(v) => formatTokens(Number(v))}
            tick={{ fill: "var(--color-faint)", fontSize: 10, fontFamily: "IBM Plex Mono" }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-line)",
              borderRadius: 12,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--color-mute)" }}
            formatter={(value, name) => [
              formatTokens(Number(value ?? 0)),
              name === "claude" ? "Claude" : name === "grok" ? "Grok" : "Codex",
            ]}
          />
          <Area
            type="monotone"
            dataKey="claude"
            stroke="var(--color-claude)"
            fill="url(#gClaude)"
            strokeWidth={1.5}
          />
          <Area
            type="monotone"
            dataKey="grok"
            stroke="var(--color-grok)"
            fill="url(#gGrok)"
            strokeWidth={1.5}
          />
          <Area
            type="monotone"
            dataKey="codex"
            stroke="var(--color-codex)"
            fill="url(#gCodex)"
            strokeWidth={1.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
