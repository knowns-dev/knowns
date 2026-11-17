"use client";
/** @registry name="progress" type="ui" title="Progress" description="Progress bar and ring, determinate or indeterminate." */

import { useId, type CSSProperties, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/ui/lib/knowns/utils";
import { Tooltip } from "./tooltip";

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
/** The tone as a colour value, for the glow and the band gradient (the fill classes above are utilities, not values). */
const TONE_COLOR: Record<ProgressTone, string> = {
  neutral: "var(--kn-accent,var(--primary))",
  accent: "var(--kn-accent,var(--primary))",
  info: "var(--color-sky-500)",
  success: "var(--color-emerald-500)",
  warning: "var(--color-amber-500)",
  danger: "var(--color-red-500)",
};
/** The fill colours as a cva map: add a tone of your own under `tone`, and pass it as the `tone` prop. */
export const progressVariants = cva("", { variants: { tone: FILL }, defaultVariants: { tone: "neutral" } });
const TRACK = "bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]";
// A fill bar resizes with the slow token and in-out easing (kn-motion); reduced motion makes it jump.
const EASE = "duration-(--kn-dur-slow) ease-(--kn-ease-inout) motion-reduce:transition-none";
// The indeterminate loop: constant, linear, one private period (--knp-dur). Parked mid-rail under reduced motion.
const SWEEP = "animate-[kn-sweep_var(--knp-dur)_linear_infinite] rtl:animate-[kn-sweep-rtl_var(--knp-dur)_linear_infinite] motion-reduce:animate-none motion-reduce:translate-x-[75%] motion-reduce:rtl:-translate-x-[75%]";

/** 0…100 for `value` out of `max`, clamped. NaN, missing or a non-positive max give 0. */
export function progressPercent(value: number | undefined, max = 100): number {
  if (value === undefined || !Number.isFinite(value) || !(max > 0)) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/** Default value text: "42%". */
export function formatPercent(_value: number, pct: number): string {
  return `${Math.round(pct)}%`;
}

/**
 * Value text through Intl: `style: "percent"` formats the share (0…1 of max), anything else (currency, unit, decimal)
 * formats the raw value. `locale` defaults to the runtime's.
 */
export function formatWithOptions(value: number, pct: number, options: Intl.NumberFormatOptions, locale?: string): string {
  const nf = new Intl.NumberFormat(locale, options);
  return nf.format(options.style === "percent" ? pct / 100 : value);
}

/** One part of a segmented bar: done and in progress, say. The parts add up from the start over one `max`. */
export interface ProgressSegment {
  value: number;
  /** A tone of the bar (success for done, info for in progress). Default: the accent. */
  tone?: ProgressTone;
  /** Any CSS colour. Wins over `tone`. */
  color?: string;
  /** Names the segment in its tooltip and in aria-valuetext: "Done". */
  label?: string;
}

/** Where each segment sits: `from` and `to` in percent of the bar, the sum clamped to `max` and negative or NaN values counted as 0. */
export function segmentSpans(segments: ProgressSegment[], max = 100): { from: number; to: number; value: number }[] {
  let sum = 0;
  return segments.map((s) => {
    const v = Number.isFinite(s.value) ? Math.max(0, s.value) : 0;
    const from = progressPercent(sum, max);
    sum += v;
    const to = progressPercent(sum, max);
    return { from, to, value: Math.max(0, Math.min(v, max - (sum - v))) };
  });
}

/** "62%  24 of 39" for the first segment (the finished part), with an optional unit after the total: "24 of 39 issues". */
export function segmentReadout(segments: ProgressSegment[], max = 100, unit?: string): { pct: string; of: string } {
  const first = segmentSpans(segments, max)[0];
  const v = first?.value ?? 0;
  return { pct: `${Math.round(progressPercent(v, max))}%`, of: `${v} of ${max}${unit ? ` ${unit}` : ""}` };
}

/** aria-valuetext of a segmented bar: the readout, then every segment: "62%, 24 of 39 issues. Done 24, In progress 6". */
export function segmentValueText(segments: ProgressSegment[], max = 100, unit?: string): string {
  const r = segmentReadout(segments, max, unit);
  const parts = segmentSpans(segments, max).map((sp, i) => `${segments[i]?.label ?? `Part ${i + 1}`} ${sp.value}`);
  return `${r.pct}, ${r.of}. ${parts.join(", ")}`;
}

/** Label or aria-label is required, so every bar has a name. */
type Named = { label: ReactNode; "aria-label"?: string } | { label?: undefined; "aria-label": string };

export type ProgressProps = Named & {
  value?: number;
  max?: number;
  /** A bar in parts over one `max`, such as done and in progress. `value` is ignored. The readout, the value and aria-valuenow follow the first segment (the finished part); aria-valuetext lists them all. Each segment with a `label` has a tooltip. */
  segments?: ProgressSegment[];
  /** Segments: write "62%  24 of 39" as the value text, the share of the first segment and its count. Default false. */
  readout?: boolean;
  /** Segments with `readout`: the unit after the total, "24 of 39 issues". */
  unit?: string;
  /** Where the value text sits: beside the bar (default), under it, on the label row ("top"), or not at all. */
  valueLabel?: "right" | "bottom" | "top" | "none";
  /** Value text; also used as aria-valuetext. Wins over `formatOptions`. Use it for steps: (v) => `${v} of 5 steps`. */
  format?: (value: number, pct: number) => string;
  /** Format the value with Intl.NumberFormat (percent, currency, unit...). */
  formatOptions?: Intl.NumberFormatOptions;
  /** Locale for `formatOptions`. Default: the runtime's. */
  locale?: string;
  /** A line under the bar: "12.4 MB, about 20 seconds left". */
  helper?: ReactNode;
  /** Unknown amount of work: a band of light crosses the track. */
  indeterminate?: boolean;
  tone?: ProgressTone;
  /** 4, 6 or 8px track. */
  size?: "sm" | "md" | "lg";
  className?: string;
};

const BAR_H = { sm: "h-1", md: "h-1.5", lg: "h-2" } as const;

/** A thin horizontal bar for a known (or unknown) amount of work. Grows from the right inside dir="rtl". */
export function Progress({
  value = 0,
  max = 100,
  segments,
  readout = false,
  unit,
  label,
  valueLabel = "right",
  format,
  formatOptions,
  locale,
  helper,
  indeterminate = false,
  tone = "neutral",
  size = "md",
  className,
  "aria-label": ariaLabel,
}: ProgressProps) {
  const id = useId();
  const spans = segments && !indeterminate ? segmentSpans(segments, max) : null;
  const main = spans ? (spans[0]?.value ?? 0) : value;
  const pct = progressPercent(main, max);
  const fmt = format ?? (formatOptions ? (v: number, p: number) => formatWithOptions(v, p, formatOptions, locale) : formatPercent);
  const segText = spans && segments ? segmentReadout(segments, max, unit) : null;
  const text = indeterminate ? "" : spans && segments ? (format || formatOptions ? fmt(main, pct) : segmentValueText(segments, max, unit)) : fmt(value, pct);
  const showValue = valueLabel !== "none" && !indeterminate;

  const bar = (
    <div
      role="progressbar"
      aria-labelledby={label !== undefined ? `${id}-label` : undefined}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-describedby={helper ? `${id}-helper` : undefined}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.min(max, Math.max(0, main))}
      aria-valuetext={indeterminate ? undefined : text}
      aria-busy={indeterminate || undefined}
      style={{ "--kn-pc": TONE_COLOR[tone], "--knp-dur": "1.6s" } as CSSProperties}
      className={cn("relative w-full min-w-0", valueLabel === "right" && !indeterminate && "flex-1", BAR_H[size])}
    >
      <span aria-hidden className={cn("absolute inset-0 overflow-hidden rounded-full", TRACK)}>
        {indeterminate ? (
          // The band: a crisp core and a rounded head at its leading end. Transform only, so it stays on the compositor.
          <span
            className={cn(
              "absolute inset-y-0 start-0 w-[40%] rounded-full",
              "bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--kn-pc)_45%,transparent)_45%,var(--kn-pc)_90%)] rtl:bg-[linear-gradient(270deg,transparent,color-mix(in_srgb,var(--kn-pc)_45%,transparent)_45%,var(--kn-pc)_90%)]",
              SWEEP,
            )}
          />
        ) : spans && segments ? (
          // Each fill runs from the start to its own end, drawn last to first, so the first sits on top and the next shows only beyond it. Only transform moves.
          [...spans].reverse().map((sp, ri) => {
            const k = spans.length - 1 - ri;
            const seg = segments[k]!;
            return (
              <span
                key={k}
                data-segment={k}
                style={{ "--kn-p": sp.to - 100, ...(seg.color ? { backgroundColor: seg.color } : null) } as CSSProperties}
                className={cn("absolute inset-0 rounded-full transition-[translate] translate-x-[calc(var(--kn-p)*1%)] rtl:translate-x-[calc(var(--kn-p)*-1%)]", !seg.color && FILL[seg.tone ?? "accent"], EASE)}
              />
            );
          })
        ) : (
          <span
            // --kn-p is the offset in percent: the fill slides in from the start edge, and from the right inside rtl.
            style={{ "--kn-p": pct - 100 } as CSSProperties}
            className={cn("absolute inset-0 rounded-full transition-[translate] translate-x-[calc(var(--kn-p)*1%)] rtl:translate-x-[calc(var(--kn-p)*-1%)]", FILL[tone], EASE)}
          />
        )}
      </span>
      {spans &&
        segments?.map((seg, k) =>
          seg.label && spans[k]!.to > spans[k]!.from ? (
            <Tooltip key={k} content={`${seg.label}: ${spans[k]!.value}`} className="absolute inset-y-[-4px]" style={{ insetInlineStart: `${spans[k]!.from}%`, width: `${spans[k]!.to - spans[k]!.from}%` }}>
              <span data-segment-hit={k} className="block size-full" />
            </Tooltip>
          ) : null,
        )}
      {indeterminate && (
        // Dark only: the glow spills a few px above and below the rail but never past its ends (clip-path). On a light page a dark halo reads as a smudge, so light keeps just the crisp gradient band.
        <span aria-hidden className="pointer-events-none absolute inset-0 [clip-path:inset(-10px_0)]">
          <span className={cn("absolute inset-y-[-1px] start-0 w-[40%] rounded-full hidden bg-[color:var(--kn-pc)] opacity-60 blur-[2px] dark:block", SWEEP)} />
          <span className={cn("absolute inset-y-[-5px] start-0 w-[40%] rounded-full hidden bg-[color:var(--kn-pc)] opacity-30 blur-[7px] dark:block", SWEEP)} />
        </span>
      )}
    </div>
  );

  const valueText =
    showValue &&
    (segText && readout && !format && !formatOptions ? (
      <span className="flex-none text-[12px] text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">{segText.pct}</span>
        {"  "}
        {segText.of}
      </span>
    ) : (
      <span className="flex-none text-[12px] text-muted-foreground tabular-nums">{segText && !format && !formatOptions ? segText.pct : text}</span>
    ));
  const labelEl =
    label !== undefined ? (
      <div id={`${id}-label`} className="text-[13px] font-medium text-foreground">
        {label}
      </div>
    ) : null;
  const helperEl = helper ? (
    <div id={`${id}-helper`} className="text-[12px] text-muted-foreground">
      {helper}
    </div>
  ) : null;

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}>
      {valueLabel === "top" ? (
        (labelEl || valueText) && (
          <div className="flex items-baseline justify-between gap-3">
            {labelEl}
            <span className="ms-auto">{valueText}</span>
          </div>
        )
      ) : (
        labelEl
      )}
      {valueLabel === "right" ? (
        <div className="flex items-center gap-3">
          {bar}
          {valueText}
        </div>
      ) : (
        bar
      )}
      {valueLabel === "bottom" ? (
        <div className="flex items-baseline justify-between gap-3">
          {helperEl ?? <span />}
          {valueText}
        </div>
      ) : (
        helperEl
      )}
    </div>
  );
}

/* ── Circle ── */

const RING = {
  sm: { box: 20, stroke: 2.5 },
  md: { box: 36, stroke: 3.5 },
  lg: { box: 56, stroke: 4.5 },
} as const;

/** Presets keep their stroke; a pixel size (16, 24, 32...) gets a stroke that scales with it. */
function ringGeometry(size: ProgressCircleProps["size"]): { box: number; stroke: number } {
  if (typeof size === "number") return { box: size, stroke: Math.max(2, Math.round(size * 0.09 * 2) / 2) };
  return RING[size ?? "md"];
}

export type ProgressCircleProps = {
  value?: number;
  max?: number;
  /** A preset (sm 20, md 36, lg 56) or a size in px; 16, 24 and 32 are the usual small ones. */
  size?: "sm" | "md" | "lg" | number;
  /** Value in the middle (36px and up; smaller is too small to read). */
  showValue?: boolean;
  format?: (value: number, pct: number) => string;
  formatOptions?: Intl.NumberFormatOptions;
  locale?: string;
  indeterminate?: boolean;
  tone?: ProgressTone;
  className?: string;
} & ({ label: string; "aria-label"?: undefined } | { label?: undefined; "aria-label": string });

/** A ring for runs and uploads; fills clockwise from the top (counter-clockwise inside dir="rtl"). */
export function ProgressCircle({
  value = 0,
  max = 100,
  size = "md",
  label,
  showValue = false,
  format,
  formatOptions,
  locale,
  indeterminate = false,
  tone = "neutral",
  className,
  "aria-label": ariaLabel,
}: ProgressCircleProps) {
  const { box, stroke } = ringGeometry(size);
  const r = (box - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = progressPercent(value, max);
  const fmt = format ?? (formatOptions ? (v: number, p: number) => formatWithOptions(v, p, formatOptions, locale) : formatPercent);
  const valueText = fmt(value, pct);
  const textCls = box >= 56 ? "text-[13px]" : box >= 36 ? "text-[9px] tracking-[-0.02em]" : "";
  // Indeterminate: a 28% arc orbiting at Spinner's pace, with a tight halo.
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
      style={{ width: box, height: box, "--kn-pc": TONE_COLOR[tone] } as CSSProperties}
      className={cn("relative inline-grid flex-none place-items-center", className)}
    >
      <svg
        viewBox={`0 0 ${box} ${box}`}
        aria-hidden
        className={cn("absolute inset-0 -rotate-90 rtl:-scale-x-100", indeterminate && "animate-spin motion-reduce:animate-none drop-shadow-[0_0_2px_var(--kn-pc)]")}
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
      {showValue && !indeterminate && textCls && <span className={cn("relative font-medium text-foreground tabular-nums", textCls)}>{valueText}</span>}
    </span>
  );
}

export default Progress;
