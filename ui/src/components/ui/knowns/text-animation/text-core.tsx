"use client";
/** @registry name="text-animation-core" type="ui" title="Text animation core" description="Shared pieces for text animations: accessible shell, motion gate, caret." */

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { useLive } from "@/ui/components/ui/knowns/illustrations/use-in-view";

/**
 * Shared pieces for the text animations: the motion gate (live only on screen, in a visible tab, not
 * paused, no reduced motion), an accessible shell (full text for screen readers, animated layer hidden),
 * a caret, and a timer that only ticks while live.
 */

export { useLive };

/** Pauses CSS motion when the root is not live; reduced motion drops it, leaving the final text. */
export const TEXT_GATE = `
[data-kn-text][data-live="false"] *, [data-kn-text][data-live="false"] *::before, [data-kn-text][data-live="false"] *::after { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) { [data-kn-text] *, [data-kn-text] *::before, [data-kn-text] *::after { animation: none !important; transition: none !important; } }
@keyframes kntx-caret { 0%, 45% { opacity: 1 } 55%, 100% { opacity: 0 } }
@keyframes kntx-in { from { opacity: 0; transform: translateY(.12em) } to { opacity: 1; transform: none } }
`;

export const EASE = "cubic-bezier(.22,1,.36,1)";

export interface TextShellProps {
  /** Which effect, for data-kn-text and the style key. */
  kind: string;
  /** The whole text, read by screen readers. */
  label: string;
  live: boolean;
  /** CSS for this effect (TEXT_GATE is added once for all). */
  css?: string;
  rootRef: RefObject<HTMLSpanElement | null>;
  className?: string;
  children: ReactNode;
}

/** Inline root: sr-only full text + an aria-hidden animated layer. Sits in headings and paragraphs. */
export function TextShell({ kind, label, live, css, rootRef, className, children }: TextShellProps) {
  return (
    <span ref={rootRef} data-kn-text={kind} data-live={live} className={cn("relative", className)}>
      <style href="kn-text-core" precedence="default">
        {TEXT_GATE}
      </style>
      {css && (
        <style href={`kn-text-${kind}`} precedence="default">
          {css}
        </style>
      )}
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{children}</span>
    </span>
  );
}

/** A thin blinking caret, sized to the text. */
export function Caret({ blink = true, className }: { blink?: boolean; className?: string }) {
  return (
    <span
      className={cn("ml-[.06em] inline-block h-[1.05em] w-[.08em] min-w-[2px] translate-y-[.16em] rounded-full bg-current align-baseline", className)}
      style={blink ? { animation: "kntx-caret 1s steps(1) infinite" } : undefined}
    />
  );
}

/**
 * One timeout: calls `step` after `delay` ms while `live`. Pass null to wait for nothing. Components
 * keep their position in state and return the next delay from it, so a paused scene simply stops.
 */
export function useStep(live: boolean, delay: number | null, step: () => void, key: unknown) {
  const ref = useRef(step);
  ref.current = step;
  useEffect(() => {
    if (!live || delay === null) return;
    const t = setTimeout(() => ref.current(), delay);
    return () => clearTimeout(t);
  }, [live, delay, key]);
}

/** A small deterministic 0–1 hash, for jitter that is the same on every render and in tests. */
export function hash01(n: number, seed = 0): number {
  let x = (Math.imul(n + 1, 374761393) + Math.imul(seed, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return ((x >>> 0) % 10000) / 10000;
}
