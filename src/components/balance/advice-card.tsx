import { routingAdvice } from "@/lib/quota/engine";
import type { MeterSnapshot } from "@/lib/quota/types";

export function AdvicePlan({
  meters,
}: {
  meters: readonly MeterSnapshot[];
}) {
  const tips = routingAdvice(meters);
  if (!tips.length) return null;

  return (
    <section
      className="mt-3 flex min-w-0 items-center gap-3 border-t border-line pt-3"
      aria-labelledby="collaboration-plan-title"
    >
      <h3
        id="collaboration-plan-title"
        className="shrink-0 text-sm font-medium tracking-tight text-ink"
        title="按可见 Agent 的窗口松紧，决定下一趟任务走谁"
      >
        协同计划
      </h3>
      <ul className="flex min-w-0 flex-1 gap-2">
        {tips.map((tip) => (
          <li key={tip.title} className="min-w-0 flex-1 rounded-md bg-raised px-3 py-2">
            <p className="truncate text-sm" title={`${tip.title}：${tip.body}`}>
              <span className="font-medium">{tip.title}</span>
              <span className="text-mute"> · {tip.body}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
