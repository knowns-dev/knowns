export const MOTION = { fast: 120, base: 180, slow: 280 } as const;

/**
 * Three easings, no ease-in. `out` for anything that enters, leaves, opens or closes (enter and exit share it, exit
 * is just shorter); `inOut` (ease-in-out) for something already on screen that moves or resizes; `spring` (a small
 * overshoot) for a rare confirm. See .claude/skills/kn-motion.
 */
export const EASE = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

export interface MotionRow<T> {
  item: T;
  key: string;
  /** Removed from the list but still on screen while it plays its exit. */
  exiting: boolean;
}

/**
 * The rows to render now: the new items in order, plus every previous row that is gone, kept in its old place and marked
 * `exiting` until the caller drops it. Rows already exiting stay as they are.
 */
export function mergeRows<T>(prev: MotionRow<T>[], items: T[], keyOf: (item: T) => string): MotionRow<T>[] {
  const next: MotionRow<T>[] = items.map((item) => ({ item, key: keyOf(item), exiting: false }));
  const live = new Set(next.map((r) => r.key));
  prev.forEach((row, i) => {
    if (live.has(row.key)) return;
    // Keep it after the nearest earlier row that is still there, so it leaves from where it was.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = next.findIndex((r) => r.key === prev[j].key);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    next.splice(at, 0, { ...row, exiting: true });
  });
  return next;
}

/** Ease-out for a number count: 0 to 1 over `t` in 0..1, fast at first and settling (cubic). */
export const countCurve = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** The value `t` of the way from `from` to `to` on the count curve. */
export const countAt = (from: number, to: number, t: number) => from + (to - from) * countCurve(t);
