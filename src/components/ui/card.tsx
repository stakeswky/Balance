import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-w-0 rounded-2xl bg-surface p-3 shadow-[var(--shadow-border)] sm:p-4", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3 flex items-start justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-medium tracking-tight text-ink", className)} {...props} />;
}

export function CardHint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-mute", className)} {...props} />;
}
