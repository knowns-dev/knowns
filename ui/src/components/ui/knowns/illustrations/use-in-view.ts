"use client";
/** @registry part-of="illustrations-core" */

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/**
 * Shared motion gate for the illustrations: animate only while on screen, in a visible tab, not paused
 * and without prefers-reduced-motion. Illustrations animate with CSS (transform / opacity / dashoffset)
 * and pause through `animation-play-state`, so nothing runs a frame loop while hidden.
 */

export interface LiveInputs {
  paused?: boolean;
  inView: boolean;
  /** The tab is visible (document.visibilityState). */
  visible: boolean;
  reduced: boolean;
}

/** Whether an illustration should be moving. */
export function isLive({ paused, inView, visible, reduced }: LiveInputs): boolean {
  return !paused && inView && visible && !reduced;
}

/**
 * True while the element is within `rootMargin` of the viewport. Starts true (the first paint is the
 * live frame, no flash) and stays true where IntersectionObserver is missing.
 */
export function useInView(ref: RefObject<Element | null>, rootMargin = "120px"): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};

/** False while the tab is hidden. Always true on the server. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(REDUCE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** prefers-reduced-motion. False on the server (the CSS media query still gives the static frame there). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => typeof matchMedia === "function" && matchMedia(REDUCE).matches,
    () => false,
  );
}

/** `live` for `data-live` on the illustration root, plus `reduced` for anything JS-driven. */
export function useLive(ref: RefObject<Element | null>, paused?: boolean): { live: boolean; reduced: boolean } {
  const inView = useInView(ref);
  const visible = usePageVisible();
  const reduced = useReducedMotion();
  return { live: isLive({ paused, inView, visible, reduced }), reduced };
}

/**
 * CSS every illustration includes once: children pause when the root is not live, and reduced motion
 * removes animation so the base styles (drawn as the composed frame) show.
 */
export const MOTION_GATE = `
[data-kn-ill][data-live="false"] *, [data-kn-ill][data-live="false"] *::before, [data-kn-ill][data-live="false"] *::after { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) { [data-kn-ill] *, [data-kn-ill] *::before, [data-kn-ill] *::after { animation: none !important; } }
`;
