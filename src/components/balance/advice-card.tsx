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
      className="mt-2 border-t border-line pt-2"
      aria-labelledby="collaboration-plan-title"
    >
      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-3">
        <h3
          id="collaboration-plan-title"
          className="text-xs font-medium tracking-tight text-ink"
          title="按可见 Agent 的窗口松紧，决定下一趟任务走谁"
        >
          协同计划
        </h3>
        <ul className="flex min-w-0 gap-2">
          {tips.map((tip) => (
            <li key={tip.title} className="min-w-0 flex-1 rounded-xl bg-raised px-2.5 py-1.5">
              <p className="truncate text-sm" title={`${tip.title}：${tip.body}`}>
                <span className="font-medium">{tip.title}</span>
                <span className="text-mute"> · {tip.body}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
