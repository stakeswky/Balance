import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-11 w-14 shrink-0 items-center rounded-full bg-raised p-1.5 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 data-[state=checked]:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-8 rounded-full bg-mute transition-transform duration-150 data-[state=checked]:translate-x-3 data-[state=checked]:bg-accent-fg" />
    </SwitchPrimitive.Root>
  );
}
