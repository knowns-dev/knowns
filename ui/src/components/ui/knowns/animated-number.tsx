"use client";
/** @registry name="animated-number" type="ui" title="Animated number" description="A number whose changed digits roll up or down to the new value: Intl formatting for currency, percent and decimals, tabular widths, instant with reduced motion." */

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { EASE, MOTION, prefersReducedMotion } from "@/ui/lib/knowns/motion";

export interface AnimatedNumberProps {
  value: number;
  /** Intl.NumberFormat options (currency, percent, decimals, signDisplay), or your own formatter. Default: grouped integers. */
  format?: Intl.NumberFormatOptions | ((n: number) => string);
  locale?: string;
  /** Text before / after the number (not animated), e.g. "$" or " runs". */
  prefix?: string;
  suffix?: string;
  className?: string;
}

/** The text a value shows: Intl options, or a function. */
export function formatValue(n: number, format: AnimatedNumberProps["format"], locale?: string): string {
  if (typeof format === "function") return format(n);
  return new Intl.NumberFormat(locale, format).format(n);
}

export interface NumberSlot {
  /** Stable key: the place counted from the right, so a new leading digit does not reshuffle the others. */
  key: string;
  /** A digit 0 to 9, or null for a fixed character (separator, sign, symbol). */
  digit: number | null;
  char: string;
}

/** The characters of a formatted number: digits roll, everything else stays put. */
export function numberSlots(text: string): NumberSlot[] {
  const chars = Array.from(text);
  return chars.map((char, i) => {
    const fromRight = chars.length - 1 - i;
    const digit = /^[0-9]$/.test(char) ? Number(char) : null;
    return { key: `${digit === null ? "c" : "d"}${fromRight}`, digit, char };
  });
}

/** One digit. A change rolls it: the old one leaves and the new one enters, upward when the value went up, downward when it went down. */
function Digit({ digit, dir }: { digit: number; dir: 1 | -1 }) {
  const last = useRef(digit);
  const col = useRef<HTMLSpanElement>(null);
  const [roll, setRoll] = useState<{ from: number; to: number; dir: 1 | -1; id: number } | null>(null);
  const id = useRef(0);

  // A real change only: the first render and an identical digit play nothing.
  useLayoutEffect(() => {
    if (last.current === digit) return;
    const from = last.current;
    last.current = digit;
    setRoll(prefersReducedMotion() ? null : { from, to: digit, dir, id: ++id.current });
  }, [digit, dir]);

  useLayoutEffect(() => {
    const el = col.current;
    if (!roll || !el) return;
    if (typeof el.animate !== "function") return setRoll(null);
    // Rolling up: [old, new] slides from 0 to -50%. Rolling down: [new, old] slides from -50% to 0. Transform only.
    const frames = roll.dir === 1 ? [{ transform: "translateY(0)" }, { transform: "translateY(-50%)" }] : [{ transform: "translateY(-50%)" }, { transform: "translateY(0)" }];
    const a = el.animate(frames, { duration: MOTION.slow, easing: EASE.out, fill: "both" });
    const done = () => setRoll((r) => (r && r.id === roll.id ? null : r));
    a.onfinish = done;
    a.oncancel = done;
    a.finished?.catch(() => {});
    return () => a.cancel();
  }, [roll]);

  return (
    <span className="relative inline-block h-[1.15em] overflow-hidden align-bottom leading-[1.15]">
      {/* The resting digit holds the width (tabular figures are all one width); while it rolls, a two-high column slides behind it. */}
      <span className={roll ? "invisible" : undefined}>{digit}</span>
      {roll && (
        <span ref={col} className="absolute inset-x-0 top-0 flex flex-col text-center" aria-hidden="true">
          {(roll.dir === 1 ? [roll.from, roll.to] : [roll.to, roll.from]).map((d, i) => (
            <span key={i} className="block h-[1.15em]">
              {d}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * A number whose changed digits roll to the new value, for live metrics: counts, money, rates. Only digits that
 * change move, upward when the value rose and downward when it fell; a new leading digit just appears. Nothing plays
 * on first render, on an identical value or with reduced motion. Screen readers get the final text, never the roll.
 */
export function AnimatedNumber({ value, format, locale, prefix, suffix, className }: AnimatedNumberProps) {
  const text = formatValue(value, format, locale);
  const slots = numberSlots(text);
  // Which way the number moved, held until the next change so a re-render does not flip it.
  const lastValue = useRef(value);
  const dir = useRef<1 | -1>(1);
  if (value !== lastValue.current) {
    dir.current = value > lastValue.current ? 1 : -1;
    lastValue.current = value;
  }
  return (
    <span className={cn("inline-flex items-baseline tabular-nums", className)}>
      <span className="sr-only">{`${prefix ?? ""}${text}${suffix ?? ""}`}</span>
      <span aria-hidden="true" className="inline-flex items-baseline whitespace-pre leading-[1.15]">
        {prefix}
        {slots.map((s) => (s.digit === null ? <span key={s.key} className="leading-[1.15]">{s.char}</span> : <Digit key={s.key} digit={s.digit} dir={dir.current} />))}
        {suffix}
      </span>
    </span>
  );
}

export default AnimatedNumber;
