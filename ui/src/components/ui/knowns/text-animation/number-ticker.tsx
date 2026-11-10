"use client";
/** @registry name="number-ticker" type="ui" title="Number ticker" description="Digits that roll to the new value, for costs, tokens and live metrics." */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { EASE, TextShell, useLive } from "./text-core";

export interface NumberTickerProps {
  value: number;
  /** Rolls up from this the first time it comes into view. Default: no roll on first view. */
  from?: number;
  /** Intl.NumberFormat options, or your own formatter. */
  format?: Intl.NumberFormatOptions | ((n: number) => string);
  locale?: string;
  /** Ms for a digit to roll. Default 900. */
  duration?: number;
  /** Text before / after the number (not animated), e.g. "$" or " tokens". */
  prefix?: string;
  suffix?: string;
  paused?: boolean;
  className?: string;
}

/** Format with Intl options or a function. */
export function formatNumber(n: number, format: NumberTickerProps["format"], locale?: string): string {
  if (typeof format === "function") return format(n);
  return new Intl.NumberFormat(locale, format).format(n);
}

export interface TickerSlot {
  /** Stable key: position counted from the right, so new leading digits do not reshuffle the rest. */
  key: string;
  /** A digit 0–9, or null for a fixed character (comma, dot, sign, letter). */
  digit: number | null;
  char: string;
}

/** Characters of a formatted number as slots: digits roll, everything else stays put. */
export function tickerSlots(text: string): TickerSlot[] {
  const chars = Array.from(text);
  return chars.map((char, i) => {
    const fromRight = chars.length - 1 - i;
    const d = /[0-9]/.test(char) ? Number(char) : null;
    return { key: `${d === null ? "c" : "d"}${fromRight}`, digit: d, char };
  });
}

const DIGITS = "0123456789";

/**
 * A number whose digits roll to the new value, for costs, token counts and other live metrics.
 * Format it with Intl options (currency, compact, decimals) or a function. Screen readers get the
 * formatted value; reduced motion jumps straight to it. Holds still offscreen and rolls on return.
 */
export function NumberTicker({ value, from, format, locale, duration = 900, prefix, suffix, paused, className }: NumberTickerProps) {
  const root = useRef<HTMLSpanElement>(null);
  const { live, reduced } = useLive(root, paused);
  const [shown, setShown] = useState(from ?? value);
  // Follow the value only while live, so it rolls when it comes back into view.
  useEffect(() => {
    if (live) setShown(value);
  }, [live, value]);
  const display = reduced ? value : shown;
  const text = formatNumber(display, format, locale);
  const label = `${prefix ?? ""}${formatNumber(value, format, locale)}${suffix ?? ""}`;
  const slots = tickerSlots(text);

  return (
    <TextShell kind="number-ticker" label={label} live={live} rootRef={root} className={cn("inline-flex tabular-nums", className)}>
      <span className="inline-flex items-end leading-[1.15]">
        {prefix && <span className="whitespace-pre">{prefix}</span>}
        {slots.map((s, i) =>
          s.digit === null ? (
            <span key={s.key} className="whitespace-pre">
              {s.char}
            </span>
          ) : (
            <span key={s.key} className="relative inline-block h-[1.15em] overflow-hidden [mask-image:linear-gradient(transparent,#000_22%,#000_78%,transparent)]">
              {/* Invisible digit holds the width; the column slides behind it. */}
              <span className="invisible">0</span>
              <span
                className="absolute inset-x-0 top-0 flex flex-col text-center"
                style={{
                  transform: `translateY(${-s.digit * 10}%)`,
                  // Higher places settle a touch later, like a mechanical counter.
                  transition: `transform ${duration}ms ${EASE} ${Math.min(slots.length - 1 - i, 6) * 28}ms`,
                }}
              >
                {Array.from(DIGITS).map((d) => (
                  <span key={d} className="h-[1.15em]">
                    {d}
                  </span>
                ))}
              </span>
            </span>
          ),
        )}
        {suffix && <span className="whitespace-pre">{suffix}</span>}
      </span>
    </TextShell>
  );
}

export default NumberTicker;
