import { Card, CardHint, CardTitle } from "@/components/ui/card";
import { routingAdvice } from "@/lib/quota/engine";
import type { MeterSnapshot } from "@/lib/quota/types";

export function AdviceCard({
  claude,
  grok,
  codex,
}: {
  claude: MeterSnapshot;
  grok: MeterSnapshot;
  codex: MeterSnapshot;
}) {
  const tips = routingAdvice(claude, grok, codex);
  return (
    <Card>
      <CardTitle>协同建议</CardTitle>
      <CardHint className="mt-1">按三路窗口松紧，决定下一趟任务走谁</CardHint>
      <ul className="mt-4 space-y-3">
        {tips.map((tip) => (
          <li key={tip.title} className="rounded-md bg-raised px-3 py-3">
            <p className="text-sm font-medium">{tip.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-mute">{tip.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
