"use client";
/** @registry name="live-activity" type="ui" title="Live activity" description="A glanceable capsule for work that runs elsewhere: a pill with an icon or avatar, a title and one value, that opens into a card with details and actions as one size change. Comes with three basics: status with elapsed time, stage progress with a sliding marker, and a countdown with draining ticks." */

import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Fold, MotionStyle, SwapText } from "@/ui/lib/knowns/motion";
import { StatusDot, type StatusDotState } from "../status-dot";
import { formatClock, spokenClock, stageIndex, stageState, tickPattern, unit } from "./activity-utils";

export { formatClock, spokenClock, stageIndex, stageState, filledTicks, tickPattern, unit } from "./activity-utils";
export type ActivityState = StatusDotState;

export interface LiveActivityProps {
  /** An icon or an avatar, 32px wide. */
  leading?: ReactNode;
  title: ReactNode;
  /** A short line under the title. */
  subtitle?: ReactNode;
  /** The one value on the right: a time, a count, a percentage. */
  trailing?: ReactNode;
  /** Drives the dot at the right edge. Omit it to show no dot. */
  state?: ActivityState;
  /** Controlled: the card is open. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** The card's body, shown when expanded. Without it (or without `actions`) the capsule is a plain pill. */
  children?: ReactNode;
  /** Buttons under the body. */
  actions?: ReactNode;
  /** Names the capsule for screen readers. Default: the title when it is text. */
  label?: string;
  /**
   * The surface. "inverse" is always the opposite of the page: a dark capsule in light mode, a light one in dark mode (the high-contrast
   * look). "surface" is the page's own card colour, lifted with a hairline border and a soft shadow, and in dark mode one step lighter than
   * the page. "auto" (default) is inverse for the compact pill and surface for the card.
   */
  tone?: "auto" | "inverse" | "surface";
  /** One accent colour for this capsule's track, ring, ticks and value. Any CSS colour. */
  accent?: string;
  /** Show the trailing value large (26px) so it reads at a glance. Pair it with `valueLabel`. */
  bigValue?: boolean;
  /** A small muted word beside the trailing value: "min", "used", "left". */
  valueLabel?: ReactNode;
  /** The compact pill: one short row, no subtitle. For a stack of many or a corner of the screen. */
  compact?: boolean;
  /** The leading slot's size. "lg" is 44px, for a ring or a larger avatar. */
  leadingSize?: "md" | "lg";
  /** Whether the status dot pings while busy or blocked. Default true; a stack turns it off for all but one. */
  pulse?: boolean;
  /** Finished and fading out: the content dims to 60% (180ms), the capsule keeps its own surface. */
  dimmed?: boolean;
  className?: string;
}

/** Light scope for an inverse capsule on a dark page: the page's tokens, swapped for the palette's, so buttons, muted text and borders follow. */
const CSS = `
.knla-light { --card: var(--color-neutral-50); --card-foreground: var(--color-neutral-950); --foreground: var(--color-neutral-950); --background: var(--color-neutral-50); --muted: var(--color-neutral-200); --muted-foreground: var(--color-neutral-600); --border: rgb(0 0 0 / 0.1); --input: rgb(0 0 0 / 0.14); --primary: var(--color-neutral-950); --primary-foreground: var(--color-neutral-50); --secondary: var(--color-neutral-200); --secondary-foreground: var(--color-neutral-950); --accent: var(--color-neutral-200); --accent-foreground: var(--color-neutral-950); color-scheme: light; }
`;

const subscribeTheme = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
};
/** Whether the page is in dark mode (the .dark class on the root, as the kit's tokens use). False on the server. */
export function usePageDark() {
  return useSyncExternalStore(subscribeTheme, () => document.documentElement.classList.contains("dark"), () => false);
}

/**
 * A capsule that is a pill (one row) and opens into a card (the row, a body and actions). The row never changes size: the
 * body folds open under it on the base token, so there is exactly one size change and no bounce.
 */
export function LiveActivity({ leading, title, subtitle, trailing, state, expanded: expandedProp, defaultExpanded = false, onExpandedChange, children, actions, label, tone = "auto", accent, bigValue, valueLabel, compact, leadingSize = "md", dimmed, pulse = true, className }: LiveActivityProps) {
  const id = useId();
  const [kept, setKept] = useState(defaultExpanded);
  const expandable = children !== undefined || actions !== undefined;
  const expanded = expandable && (expandedProp ?? kept);
  const toggle = () => {
    if (expandedProp === undefined) setKept(!expanded);
    onExpandedChange?.(!expanded);
  };
  const pageDark = usePageDark();
  const resolved = tone === "auto" ? (compact ? "inverse" : "surface") : tone;
  const onDark = resolved === "inverse" ? !pageDark : pageDark;
  const name = label ?? (typeof title === "string" ? title : undefined);
  const head = (
    <>
      {leading && <span className={cn("grid flex-none place-items-center text-foreground [&>svg]:size-[18px]", compact ? "size-6" : leadingSize === "lg" ? "size-11 [&_svg]:size-11" : "size-8")}>{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate leading-tight font-medium", compact ? "text-[13px]" : "text-[14px]")}>{title}</span>
        {subtitle && !compact && <span className="mt-0.5 block truncate text-[12.5px] leading-tight text-muted-foreground">{subtitle}</span>}
      </span>
      {trailing !== undefined && (
        <span className="flex flex-none items-baseline gap-1.5">
          <span className={cn("font-medium tabular-nums", compact ? "text-[13px] text-muted-foreground" : bigValue ? "text-[26px] leading-none font-semibold tracking-tight" : "text-[14px]")} style={bigValue && !compact ? { color: `color-mix(in srgb, var(--kn-accent, var(--primary)) ${onDark ? 80 : 60}%, var(--foreground))` } : undefined}>
            {trailing}
          </span>
          {valueLabel && !compact && <span className="text-[12.5px] text-muted-foreground">{valueLabel}</span>}
        </span>
      )}
      {state && <StatusDot state={state} pulse={pulse} label={false} className="flex-none" />}
    </>
  );
  const inner = <span className={cn("flex w-full items-center gap-3 transition-opacity duration-(--kn-dur) ease-(--kn-ease-out) motion-reduce:transition-none", dimmed && "opacity-60")}>{head}</span>;
  return (
    <section aria-label={name} data-state={state} data-expanded={expanded || undefined} style={accent ? ({ "--kn-accent": accent } as CSSProperties) : undefined} className={cn("w-full max-w-sm overflow-hidden border text-card-foreground", compact ? "w-auto rounded-full" : "rounded-[26px]", resolved === "inverse" ? (pageDark ? "knla-light border-black/10 bg-card text-card-foreground shadow-[0_8px_24px_-10px_rgb(0_0_0/.25)]" : "dark border-white/10 bg-card text-card-foreground") : "border-border bg-card shadow-[0_6px_20px_-8px_rgb(0_0_0/.18)] dark:border-white/8 dark:bg-[color-mix(in_srgb,var(--card),white_5%)] dark:shadow-[0_10px_28px_-10px_rgb(0_0_0/.7)]", className)}>
      <style href="knla" precedence="default">
        {CSS}
      </style>
      <MotionStyle />
      {expandable ? (
        <button type="button" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={toggle} className={cn("flex w-full cursor-pointer items-center gap-3 text-left", compact ? "min-h-10 px-3 py-1.5" : "min-h-13 px-3 py-2", "transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted/40", focusRing)}>
          {inner}
        </button>
      ) : (
        <div className={cn("flex w-full items-center gap-3", compact ? "min-h-10 px-3 py-1.5" : "min-h-13 px-3 py-2")}>{inner}</div>
      )}
      {expandable && (
        <Fold open={expanded}>
          <div id={`${id}-body`} className={cn("flex flex-col gap-3 px-3 pt-1 pb-3 transition-opacity duration-(--kn-dur) ease-(--kn-ease-out) motion-reduce:transition-none", dimmed && "opacity-60")}>
            {children}
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
          </div>
        </Fold>
      )}
    </section>
  );
}

/* ── Ticks: the share bar's thin ticks, filled left to right ── */

/**
 * A bar of thin ticks filled to `value` (0 to 1). The fill is a window that slides and a pattern that slides back, so it
 * is transform only and the ticks never stretch: 280ms on the slow token, ease in and out. Nothing plays on first render.
 */
export function ActivityTicks({ value, color = "var(--kn-accent, var(--primary))", track = "color-mix(in srgb, var(--muted-foreground) 28%, transparent)", className, label, clock }: { value: number; color?: string; track?: string; className?: string; label?: string; /** The bar follows a clock that ticks once a second (a countdown): it moves linearly and takes as long as the tick, so it drains steadily. */ clock?: boolean }) {
  const v = unit(value);
  const move = clock ? "transition-transform duration-1000 ease-linear motion-reduce:transition-none" : "transition-transform duration-(--kn-dur-slow) ease-(--kn-ease-inout) motion-reduce:transition-none";
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} className={cn("relative h-3 w-full overflow-hidden", className)}>
      <div className="absolute inset-0" style={{ background: tickPattern(track) }} />
      <div className={cn("absolute inset-0 overflow-hidden", move)} style={{ transform: `translateX(${(v - 1) * 100}%)` }}>
        <div className={cn("absolute inset-0", move)} style={{ transform: `translateX(${(1 - v) * 100}%)`, background: tickPattern(color) }} />
      </div>
    </div>
  );
}

/* ── Basic 1: status and elapsed time ── */

const tickNow = (now?: Date) => (now ? now.getTime() : Date.now());

/** The elapsed time since `startedAt`, once a second while `running`; fixed at `endedAt` when it has one. Pass `now` to pin the clock. */
export function useElapsed(startedAt: Date, running: boolean, endedAt?: Date, now?: Date) {
  const [tick, setTick] = useState(() => tickNow(now));
  useEffect(() => {
    if (!running || endedAt || now) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, endedAt, now]);
  const at = endedAt ? endedAt.getTime() : now ? now.getTime() : tick;
  return Math.max(0, at - startedAt.getTime());
}

export interface ActivityStatusProps extends Omit<LiveActivityProps, "trailing" | "state"> {
  state: ActivityState;
  startedAt: Date;
  /** When it ended: the clock stops here. */
  endedAt?: Date;
  /** Pin "now" (tests, demos). Default the clock. */
  now?: Date;
  /** Words next to the state in the subtitle, e.g. "Reading 14 files". */
  detail?: ReactNode;
}

const STATE_WORD: Record<ActivityState, string> = { idle: "Idle", busy: "Running", blocked: "Needs you", failed: "Failed", finished: "Done" };

/** Status and time: the state in words, with the time it has been running as the one value. */
export function ActivityStatus({ state, startedAt, endedAt, now, detail, subtitle, ...rest }: ActivityStatusProps) {
  const ms = useElapsed(startedAt, state === "busy" || state === "blocked", endedAt, now);
  return <LiveActivity {...rest} state={state} subtitle={subtitle ?? <SwapText value={`${state}${detail ?? ""}`}>{detail ? `${STATE_WORD[state]} · ${detail}` : STATE_WORD[state]}</SwapText>} trailing={<time aria-label={spokenClock(ms)}>{formatClock(ms)}</time>} />;
}

/* ── Basic 2: stage progress with a sliding marker ── */

export interface ActivityStage {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface ActivityProgressProps extends Omit<LiveActivityProps, "trailing" | "state" | "children"> {
  stages: readonly ActivityStage[];
  /** The current stage: its index, or its id. */
  current: number | string;
  /** Every stage is done. */
  finished?: boolean;
  state?: ActivityState;
  children?: ReactNode;
}

const Check = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 8.5 2.5 2.5L12 5.5" />
  </svg>
);

/** Stages in a row with a marker that slides to the current one (280ms, in and out). The label swaps in place. */
export function ActivityProgress({ stages, current, finished = false, state, children, actions, ...rest }: ActivityProgressProps) {
  const i = stageIndex(stages, current);
  const stage = stages[Math.max(0, i)];
  const n = Math.max(1, stages.length);
  const word = finished ? "Done" : stage?.label ?? "";
  return (
    <LiveActivity
      {...rest}
      state={state ?? (finished ? "finished" : "busy")}
      trailing={<SwapText value={word}>{word}</SwapText>}
      actions={actions}
      defaultExpanded={rest.defaultExpanded ?? true}
    >
      <div role="list" aria-label="Stages" className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {!finished && i >= 0 && (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-[14px] bg-[color-mix(in_srgb,var(--kn-accent,var(--primary))_10%,transparent)] transition-transform duration-(--kn-dur-slow) ease-(--kn-ease-inout) motion-reduce:transition-none" style={{ width: `${100 / n}%`, transform: `translateX(${i * 100}%)` }} />
        )}
        {stages.map((s, k) => {
          const st = stageState(k, i, finished);
          return (
            <span key={s.id} role="listitem" aria-current={st === "current" ? "step" : undefined} className={cn("relative flex flex-col items-center gap-1 px-1 py-2 text-[12px] transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)", st === "next" ? "text-muted-foreground" : "text-foreground")}>
              <span className={cn("grid size-7 place-items-center rounded-full border [&_svg]:size-3.5 transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)", st === "done" ? "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : st === "current" ? "border-[color:var(--kn-accent,var(--primary))] text-[color:var(--kn-accent,var(--primary))]" : "border-border")}>{st === "done" ? <Check /> : s.icon ?? <span className="size-1.5 rounded-full bg-current" />}</span>
              <span className="truncate font-medium">{s.label}</span>
              <span className="sr-only">{st === "done" ? ", done" : st === "current" ? ", in progress" : ", not started"}</span>
            </span>
          );
        })}
      </div>
      {children}
    </LiveActivity>
  );
}

/* ── Basic 3: a countdown with draining ticks ── */

export interface ActivityCountdownProps extends Omit<LiveActivityProps, "trailing" | "state" | "children"> {
  /** When it ends. */
  endsAt: Date;
  /** How long the whole wait is, in ms, so the ticks know how full they are. */
  totalMs: number;
  /** Pin "now" (tests, demos). Default the clock. */
  now?: Date;
  /** Called once when it reaches zero. */
  onDone?: () => void;
  children?: ReactNode;
}

/** The time left to `endsAt` as a clock, with a bar of ticks that drains. Once a second the text changes; nothing moves but the ticks. */
export function ActivityCountdown({ endsAt, totalMs, now, onDone, children, actions, ...rest }: ActivityCountdownProps) {
  const [tick, setTick] = useState(() => tickNow(now));
  const left = Math.max(0, endsAt.getTime() - (now ? now.getTime() : tick));
  useEffect(() => {
    if (now || left <= 0) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [now, left <= 0]);
  const done = left <= 0;
  useEffect(() => {
    if (done) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  return (
    <LiveActivity {...rest} state={done ? "finished" : "busy"} trailing={<time aria-label={spokenClock(left)}>{formatClock(left)}</time>} actions={actions}>
      <ActivityTicks clock value={totalMs > 0 ? left / totalMs : 0} label="Time left" />
      {children}
    </LiveActivity>
  );
}

export default LiveActivity;
