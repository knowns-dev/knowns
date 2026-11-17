import { cva } from "class-variance-authority";
import { cn } from "@/ui/lib/knowns/utils";

export type StatusDotState = "idle" | "busy" | "blocked" | "failed" | "finished";
export type StatusDotTone = "neutral" | "accent" | "success" | "warning" | "danger";

const COLOR: Record<StatusDotState, string> = {
  idle: "bg-muted-foreground/50",
  busy: "bg-indigo-500",
  blocked: "bg-amber-500",
  failed: "bg-red-500",
  finished: "bg-emerald-500",
};

const TONE_COLOR: Record<StatusDotTone, string> = {
  neutral: "bg-muted-foreground/50",
  accent: "bg-[color:var(--kn-accent,var(--primary))]",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

/** The dot colour as a cva map: by `state`, or by `tone` (which wins). Add your own under either. */
export const statusDotVariants = cva("", { variants: { state: COLOR, tone: TONE_COLOR }, defaultVariants: { state: "idle" } });

const LABEL: Record<StatusDotState, string> = { idle: "Idle", busy: "Working", blocked: "Needs you", failed: "Failed", finished: "Done" };

/** Small coloured dot for a state; busy and blocked pulse. Pass `label` to announce it. */
export function StatusDot({ state = "idle", tone, label, className, pulse = true }: { state?: StatusDotState; /** Busy and blocked ping. Pass false to keep the colour and drop the ping, e.g. when several dots share a screen. */ pulse?: boolean; /** A colour role in place of the state's colour; the pulse still follows `state`. */ tone?: StatusDotTone; label?: string | false; className?: string }) {
  const live = (state === "busy" || state === "blocked") && pulse;
  return (
    <span
      role={label === false ? undefined : "img"}
      aria-label={label === false ? undefined : label ?? LABEL[state]}
      aria-hidden={label === false || undefined}
      className={cn("relative inline-flex size-2 flex-none", className)}
    >
      {live && <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", statusDotVariants({ state, tone }))} />}
      <span className={cn("relative size-full rounded-full", statusDotVariants({ state, tone }))} />
    </span>
  );
}
