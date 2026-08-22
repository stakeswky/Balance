import { CardHint } from "@/components/ui/card";
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
    <section className="mt-5 border-t border-line pt-5" aria-labelledby="collaboration-plan-title">
      <h3 id="collaboration-plan-title" className="text-sm font-medium tracking-tight text-ink">
        协同计划
      </h3>
      <CardHint className="mt-1">按可见 Agent 的窗口松紧，决定下一趟任务走谁</CardHint>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {tips.map((tip) => (
          <li key={tip.title} className="rounded-md bg-raised px-3 py-3">
            <p className="text-sm font-medium">{tip.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-mute">{tip.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
