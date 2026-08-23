import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-xl bg-raised px-3 text-sm text-ink shadow-[var(--shadow-border)] placeholder:text-faint",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-36 w-full rounded-xl bg-raised p-3 font-mono text-xs leading-relaxed text-ink shadow-[var(--shadow-border)] placeholder:text-faint",
        className,
      )}
      {...props}
    />
  );
}
