import { CircleHelp } from "lucide-react";

export function InlineHelp({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      tabIndex={0}
      className="inline-flex shrink-0 cursor-help items-center text-faint outline-none transition-colors hover:text-mute focus-visible:text-ink"
    >
      <CircleHelp className="size-3.5" aria-hidden="true" />
    </span>
  );
}
