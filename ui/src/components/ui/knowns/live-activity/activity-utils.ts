export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Milliseconds as words for a screen reader: "2 minutes 5 seconds". */
export function spokenClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : "");
  return [part(h, "hour"), part(m, "minute"), part(s, "second")].filter(Boolean).join(" ") || "0 seconds";
}

/** Clamp a fraction to 0..1; NaN reads as 0. */
export const unit = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The index of the current stage: a number, or the id of a stage; -1 when it is not there. */
export function stageIndex(stages: readonly { id: string }[], current: number | string | undefined): number {
  if (current === undefined) return -1;
  if (typeof current === "number") return Math.min(stages.length - 1, Math.max(-1, Math.floor(current)));
  return stages.findIndex((s) => s.id === current);
}

/** Where each stage stands next to the current one. */
export type StageState = "done" | "current" | "next";
export const stageState = (i: number, current: number, finished = false): StageState => (finished || i < current ? "done" : i === current ? "current" : "next");

/** How many of `n` ticks are filled for a fraction (rounded, so 0 is none and 1 is all). */
export const filledTicks = (fraction: number, n: number) => Math.round(unit(fraction) * n);

/** The 2px-on 3px-off tick pattern of the share bar, in one colour. */
export const tickPattern = (color: string) => `repeating-linear-gradient(90deg, ${color} 0 2px, transparent 2px 5px)`;
