// The app's Badge keeps its shadcn API (variant default | secondary | destructive | outline) but
// renders Knowns UI's badge, so labels look the same everywhere.
import type * as React from "react"

import { Badge as KnBadge } from "./knowns/badge"

type Variant = "default" | "secondary" | "destructive" | "outline"

const LOOK: Record<Variant, { tone: "neutral" | "accent" | "danger"; variant: "soft" | "outline" | "solid" }> = {
  default: { tone: "neutral", variant: "solid" },
  secondary: { tone: "neutral", variant: "soft" },
  destructive: { tone: "danger", variant: "soft" },
  outline: { tone: "neutral", variant: "outline" },
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: Variant | null
}

function Badge({ variant, ...props }: BadgeProps) {
  const look = LOOK[variant ?? "default"]
  return <KnBadge tone={look.tone} variant={look.variant} {...props} />
}

/** Class string for the badge look on another element, as the shadcn helper allowed. */
function badgeVariants({ variant }: { variant?: Variant | null } = {}) {
  const v = variant ?? "default"
  return v === "outline"
    ? "inline-flex h-5.5 items-center gap-1.5 rounded-md border border-border px-1.5 text-[11.5px] font-medium text-muted-foreground"
    : v === "destructive"
      ? "inline-flex h-5.5 items-center gap-1.5 rounded-md bg-red-500/12 px-1.5 text-[11.5px] font-medium text-red-700 dark:text-red-300"
      : v === "secondary"
        ? "inline-flex h-5.5 items-center gap-1.5 rounded-md bg-muted px-1.5 text-[11.5px] font-medium text-muted-foreground"
        : "inline-flex h-5.5 items-center gap-1.5 rounded-md bg-foreground px-1.5 text-[11.5px] font-medium text-background"
}

export { Badge, badgeVariants }
