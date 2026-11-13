"use client";
/** @registry name="progress" type="ui" title="Progress" description="Progress bar and ring, determinate or indeterminate." */

import { useId, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/ui/lib/knowns/utils";

export type ProgressTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

const FILL: Record<ProgressTone, string> = {
  // neutral and accent are the bar's own highlight: --kn-accent, which defaults to --primary.
  neutral: "bg-[color:var(--kn-accent,var(--primary))]",
  accent: "bg-[color:var(--kn-accent,var(--primary))]",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};
const STROKE: Record<ProgressTone, string> = {
  neutral: "stroke-[color:var(--kn-accent,var(--primary))]",
  accent: "stroke-[color:var(--kn-accent,var(--primary))]",
  info: "stroke-sky-500",
  success: "stroke-emerald-500",
  warning: "stroke-amber-500",
  danger: "stroke-red-500",
};
/** The fill colours as a cva map: add a tone of your own under `tone`, and pass it as the `tone` prop. */
export const progressVariants = cva("", { variants: { tone: FILL }, defaultVariants: { tone: "neutral" } });
const TRACK = "bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]";
const EASE = "duration-500 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none";

/** 0…100 for `value` out of `max`, clamped. NaN, missing or a non-positive max give 0. */
export function progressPercent(value: number | undefined, max = 100): number {
  if (value === undefined || !Number.isFinite(value) || !(max > 0)) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/** Default value text: "42%". */
export function formatPercent(_value: number, pct: number): string {
  return `${Math.round(pct)}%`;
}

/** Label or aria-label is required, so every bar has a name. */
type Named = { label: ReactNode; "aria-label"?: string } | { label?: undefined; "aria-label": string };

export type ProgressProps = Named & {
  value?: number;
  max?: number;
  /** Where the value text sits. Default "right". */
  valueLabel?: "right" | "bottom" | "none";
  /** Value text; also used as aria-valuetext. */
  format?: (value: number, pct: number) => string;
  /** Unknown amount of work: a band glides along the track. */
  indeterminate?: boolean;
  tone?: ProgressTone;
  size?: "sm" | "md";
  className?: string;
};

/** A thin horizontal bar for a known (or unknown) amount of work. */
export function Progress({
  value = 0,
  max = 100,
  label,
  valueLabel = "right",
  format = formatPercent,
  indeterminate = false,
  tone = "neutral",
  size = "md",
  className,
  "aria-label": ariaLabel,
}: ProgressProps) {
  const id = useId();
  const pct = progressPercent(value, max);
  const text = indeterminate ? "" : format(value, pct);
  const showValue = valueLabel !== "none" && !indeterminate;

  const bar = (
    <div
      role="progressbar"
      aria-labelledby={label !== undefined ? `${id}-label` : undefined}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.min(max, Math.max(0, value))}
      aria-valuetext={indeterminate ? undefined : text}
      aria-busy={indeterminate || undefined}
      className={cn("relative w-full min-w-0 overflow-hidden rounded-full", valueLabel === "right" && !indeterminate && "flex-1", TRACK, size === "sm" ? "h-1" : "h-1.5")}
    >
      {indeterminate ? (
        // A half-width band sliding across: transform only, so it stays on the compositor. Parked mid-track under reduced motion.
        <span
          className={cn(
            "absolute inset-y-0 -left-1/2 w-1/2 rounded-full",
            FILL[tone],
            "animate-[kn-shimmer_1.5s_ease-in-out_infinite] motion-reduce:translate-x-[150%] motion-reduce:animate-none motion-reduce:opacity-60",
          )}
        />
      ) : (
        <span
          style={{ transform: `translateX(${pct - 100}%)` }}
          className={cn("absolute inset-0 rounded-full transition-transform", FILL[tone], EASE)}
        />
      )}
    </div>
  );

  const valueText = showValue && <span className="flex-none text-[12px] text-muted-foreground tabular-nums">{text}</span>;

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}>
      {label !== undefined && (
        <div id={`${id}-label`} className="text-[13px] font-medium text-foreground">
          {label}
        </div>
      )}
      {valueLabel === "right" ? (
        <div className="flex items-center gap-3">
          {bar}
          {valueText}
        </div>
      ) : (
        <>
          {bar}
          {valueLabel === "bottom" && <div className="flex justify-end">{valueText}</div>}
        </>
      )}
    </div>
  );
}

/* ── Circle ── */

const RING = {
  sm: { box: 20, stroke: 2.5, text: "" },
  md: { box: 36, stroke: 3.5, text: "text-[9px] tracking-[-0.02em]" },
  lg: { box: 56, stroke: 4.5, text: "text-[13px]" },
} as const;

export type ProgressCircleProps = {
  value?: number;
  max?: number;
  size?: "sm" | "md" | "lg";
  /** Value in the middle (md and lg; sm is too small to read). */
  showValue?: boolean;
  format?: (value: number, pct: number) => string;
  indeterminate?: boolean;
  tone?: ProgressTone;
  className?: string;
} & ({ label: string; "aria-label"?: undefined } | { label?: undefined; "aria-label": string });

/** A ring for runs and uploads; fills clockwise from the top. */
export function ProgressCircle({
  value = 0,
  max = 100,
  size = "md",
  label,
  showValue = false,
  format = formatPercent,
  indeterminate = false,
  tone = "neutral",
  className,
  "aria-label": ariaLabel,
}: ProgressCircleProps) {
  const { box, stroke, text } = RING[size];
  const r = (box - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = progressPercent(value, max);
  const valueText = format(value, pct);
  // Indeterminate: a quarter arc spinning.
  const offset = indeterminate ? c * 0.72 : c * (1 - pct / 100);

  return (
    <span
      role="progressbar"
      aria-label={label ?? ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.min(max, Math.max(0, value))}
      aria-valuetext={indeterminate ? undefined : valueText}
      aria-busy={indeterminate || undefined}
      style={{ width: box, height: box }}
      className={cn("relative inline-grid flex-none place-items-center", className)}
    >
      <svg
        viewBox={`0 0 ${box} ${box}`}
        aria-hidden
        className={cn("absolute inset-0 -rotate-90", indeterminate && "animate-[spin_1.1s_linear_infinite] motion-reduce:animate-none")}
      >
        <circle cx={box / 2} cy={box / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-[color-mix(in_srgb,var(--foreground)_9%,transparent)]" />
        <circle
          cx={box / 2}
          cy={box / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={pct === 0 && !indeterminate ? c : offset}
          className={cn(STROKE[tone], "transition-[stroke-dashoffset]", EASE, pct === 0 && !indeterminate && "opacity-0")}
        />
      </svg>
      {showValue && !indeterminate && text && <span className={cn("relative font-medium text-foreground tabular-nums", text)}>{valueText}</span>}
    </span>
  );
}

export default Progress;
