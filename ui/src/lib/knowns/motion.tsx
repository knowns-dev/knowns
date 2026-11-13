"use client";
/** @registry name="motion" type="lib" title="Motion" description="Shared motion for state changes: duration and easing tokens, and helpers for a status icon that draws, shakes or pulses, a fold, rows that slide in and collapse out, a number that counts and a value that flashes. Reduced motion is instant." */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./utils";
import { EASE, MOTION, countAt, mergeRows, type MotionRow } from "./motion-utils";

export { EASE, MOTION } from "./motion-utils";

/**
 * Keyframes and classes for every helper below, hoisted into the head once however many components render it.
 * Moves transform and opacity, except a fold, which animates grid rows (no measuring in JavaScript).
 * Reduced motion removes all of it: states change instantly.
 */
const CSS = `
@keyframes kn-m-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes kn-m-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-2.5px); } 45% { transform: translateX(2px); } 70% { transform: translateX(-1px); } }
@keyframes kn-m-pulse { 0% { transform: scale(0.9); opacity: 0.4; } 55% { transform: scale(1.1); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
@keyframes kn-m-pop { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes kn-m-flash { from { background-color: color-mix(in srgb, var(--kn-accent, var(--primary)) 18%, transparent); } to { background-color: transparent; } }
@keyframes kn-m-text { from { transform: translateY(4px); } to { transform: none; } }
@keyframes kn-m-row-in { from { grid-template-rows: 0fr; opacity: 0; } to { grid-template-rows: 1fr; opacity: 1; } }
@keyframes kn-m-row-slide { from { transform: translateY(-6px); } to { transform: none; } }
.kn-m-stroke { stroke-dasharray: 1; stroke-dashoffset: 0; }
[data-kn-m="draw"] .kn-m-stroke { animation: kn-m-draw var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}) 60ms backwards; }
[data-kn-m="draw"] .kn-m-ring, [data-kn-m="pop"] { animation: kn-m-pop var(--kn-dur, ${MOTION.base}ms) ${EASE.spring} backwards; }
[data-kn-m="shake"] { animation: kn-m-shake var(--kn-dur-slow, ${MOTION.slow}ms) var(--kn-ease-out, ${EASE.out}) both; }
[data-kn-m="shake"] .kn-m-stroke { animation: kn-m-draw var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}) 40ms backwards; }
[data-kn-m="pulse"] { animation: kn-m-pulse var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}) backwards; }
.kn-m-flash { animation: kn-m-flash 600ms ease-out both; border-radius: 4px; }
.kn-m-text { display: inline-block; animation: kn-m-text var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}) backwards; }
.kn-m-fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}), opacity var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}); }
.kn-m-fold:not([data-open="true"]) { transition-duration: var(--kn-dur-fast, ${MOTION.fast}ms); }
.kn-m-fold[data-open="true"] { grid-template-rows: 1fr; opacity: 1; }
.kn-m-fold > * { min-height: 0; overflow: hidden; }
.kn-m-row { display: grid; grid-template-rows: 1fr; transition: grid-template-rows var(--kn-dur-fast, ${MOTION.fast}ms) var(--kn-ease-out, ${EASE.out}), opacity var(--kn-dur-fast, ${MOTION.fast}ms) var(--kn-ease-out, ${EASE.out}); }
.kn-m-row > * { min-height: 0; overflow: hidden; }
.kn-m-row[data-entering] { animation: kn-m-row-in var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}) backwards; }
.kn-m-row[data-entering] > * { animation: kn-m-row-slide var(--kn-dur, ${MOTION.base}ms) var(--kn-ease-out, ${EASE.out}) backwards; }
.kn-m-row[data-exiting] { grid-template-rows: 0fr; opacity: 0; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  [data-kn-m], [data-kn-m] *, .kn-m-flash, .kn-m-text, .kn-m-fold, .kn-m-row, .kn-m-row > * { animation: none !important; transition: none !important; }
}
`;

/** The shared style. Render it once near the top of any component that uses these helpers. */
export function MotionStyle() {
  return (
    <style href="kn-motion" precedence="default">
      {CSS}
    </style>
  );
}

/** True when the reader asked for no motion. False on the server. */
export const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The animation to play for `value`, picked once when it changes: `pick(previous, next)` returns "draw", "shake", "pulse",
 * "pop" or nothing. Never on first render. Put the result in `data-kn-m` on an element with `key={value}`, so it plays
 * once for that change and a later re-render does not replay it.
 */
export function usePlay<T>(value: T, pick: (prev: T, next: T) => "draw" | "shake" | "pulse" | "pop" | undefined): "draw" | "shake" | "pulse" | "pop" | undefined {
  const state = useRef<{ value: T; play: ReturnType<typeof pick> }>({ value, play: undefined });
  if (state.current.value !== value) state.current = { value, play: pick(state.current.value, value) };
  return state.current.play;
}

/** How many times `value` has changed since mount (0 on first render). Use as `key` plus a flash class to flash a changed value once. */
export function useChangeCount(value: unknown): number {
  const state = useRef({ value, n: 0 });
  if (state.current.value !== value) state.current = { value, n: state.current.n + 1 };
  return state.current.n;
}

/** A value that flashes its background once each time it changes, and stays still on first render. */
export function Flash({ value, children, className }: { value: unknown; children: ReactNode; className?: string }) {
  const n = useChangeCount(value);
  return (
    <span key={n} className={cn(n > 0 && "kn-m-flash", className)}>
      {children}
    </span>
  );
}

/** Text that settles into place (a 4px rise, full opacity from the first frame so the word is never blank) each time `value` changes, still on first render. */
export function SwapText({ value, children, className }: { value: unknown; children: ReactNode; className?: string }) {
  const n = useChangeCount(value);
  return (
    <span key={n} className={cn(n > 0 && "kn-m-text", className)}>
      {children}
    </span>
  );
}

/**
 * Open and close a region without a layout jump: grid rows 0fr to 1fr, no measuring. On close it stays mounted for the
 * exit, then unmounts. Closed on first render means nothing is mounted; open on first render means no entrance.
 */
export function Fold({ open, children, className, ms = MOTION.base, as: Tag = "div" }: { open: boolean; children: ReactNode; className?: string; ms?: number; as?: "div" | "span" }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      if (prefersReducedMotion()) return setShown(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  if (!mounted) return null;
  return (
    <Tag className={cn("kn-m-fold", className)} data-open={shown || undefined}>
      <Tag>{children}</Tag>
    </Tag>
  );
}

export interface MotionListRow<T> extends MotionRow<T> {
  /** Added after the first render: play the entrance. */
  entering: boolean;
}

/**
 * Rows for a list that animates: a row added after first render is `entering`, a row removed stays on screen as
 * `exiting` for `ms` and then drops. Render each with `<RowShell row>`. With reduced motion rows just appear and go.
 */
export function useMotionList<T>(items: T[], keyOf: (item: T) => string, ms = MOTION.base): MotionListRow<T>[] {
  const kept = useRef<MotionRow<T>[]>(items.map((item) => ({ item, key: keyOf(item), exiting: false })));
  const initial = useRef(new Set(kept.current.map((r) => r.key)));
  const entered = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [, bump] = useState(0);

  const rows = prefersReducedMotion() ? items.map((item) => ({ item, key: keyOf(item), exiting: false })) : mergeRows(kept.current, items, keyOf);
  for (const r of rows) if (!r.exiting && !initial.current.has(r.key)) entered.current.add(r.key);

  useEffect(() => {
    kept.current = rows;
    for (const r of rows) {
      if (!r.exiting || timers.current.has(r.key)) continue;
      timers.current.set(
        r.key,
        setTimeout(() => {
          timers.current.delete(r.key);
          kept.current = kept.current.filter((k) => k.key !== r.key);
          bump((n) => n + 1);
        }, ms),
      );
    }
  });
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return rows.map((r) => ({ ...r, entering: entered.current.has(r.key) }));
}

/** The wrapper a motion-list row sits in: slides in when `entering`, collapses when `exiting`. Put the row's own padding on its child. */
export function RowShell({ row, as: Tag = "li", className, innerClassName, children, ...rest }: { row: Pick<MotionListRow<unknown>, "entering" | "exiting">; as?: "li" | "div"; className?: string; innerClassName?: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <Tag {...rest} className={cn("kn-m-row", className)} data-entering={row.entering && !row.exiting ? "" : undefined} data-exiting={row.exiting ? "" : undefined} aria-hidden={row.exiting || undefined}>
      <div>
        <div className={innerClassName}>{children}</div>
      </div>
    </Tag>
  );
}

/** A number that counts to its new value (ease-out, `ms`), instantly with reduced motion and on first render. */
export function TickNumber({ value, format = (n) => String(Math.round(n)), ms = MOTION.slow, className }: { value: number; format?: (n: number) => string; ms?: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (prefersReducedMotion() || from.current === value) {
      from.current = value;
      return setShown(value);
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = (now - start) / ms;
      from.current = countAt(origin, value, t);
      setShown(t >= 1 ? value : from.current);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <span className={cn("tabular-nums", className)}>{format(shown)}</span>;
}
