import type { HTMLAttributes } from "react";
import { cn } from "@/ui/lib/knowns/utils";

export type KbdSize = "sm" | "md";
export type KbdTone = "default" | "inverse";

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** md is the standalone key; sm fits inside a 28px button. */
  size?: KbdSize;
  /** "inverse" sits on a primary (solid) button: a translucent key in the button's ink. */
  tone?: KbdTone;
}

const SIZE: Record<KbdSize, string> = {
  sm: "h-4.5 min-w-4.5 text-[10.5px]",
  md: "h-5 min-w-5 text-[11px]",
};
const TONE: Record<KbdTone, Record<KbdSize, string>> = {
  default: { sm: "border border-b bg-card text-muted-foreground", md: "border border-b-2 bg-card text-muted-foreground" },
  inverse: {
    sm: "bg-[color-mix(in_srgb,var(--primary-foreground)_16%,transparent)] text-primary-foreground/80",
    md: "bg-[color-mix(in_srgb,var(--primary-foreground)_16%,transparent)] text-primary-foreground/80",
  },
};

/** Keyboard key, e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ size = "md", tone = "default", className, ...rest }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center rounded-[5px] px-1 font-sans font-medium",
        SIZE[size],
        TONE[tone][size],
        className,
      )}
      {...rest}
    />
  );
}
