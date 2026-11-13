/** @registry part-of="trace-waterfall" */
import type { Actor, Span } from "@/ui/lib/knowns/types";

export interface WaterfallRow {
  span: Span;
  /** Span this one was made inside of (its caller's own incoming call), or null at the top. */
  parent: string | null;
  depth: number;
  children: string[];
}

/** A span's end on the clock: its end, else now (still running). */
export const endOf = (s: Span, now: number) => s.endedAt ?? Math.max(now, s.startedAt);
export const durationOf = (s: Span, now: number) => Math.max(0, endOf(s, now) - s.startedAt);
export const isRunning = (s: Span) => !s.outcome;
export const isFailed = (s: Span) => s.outcome === "failure";

/**
 * Rows in start order, nested by caller: a span made by X sits under the call into X that was open when it
 * started (the latest such). The lead's calls sit under You → lead; a subagent's tools under lead → subagent.
 * Depth-first, children in start order, so every subtree stays together.
 */
export function buildRows(spans: Span[], now = Date.now()): WaterfallRow[] {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const parentOf = new Map<string, string | null>();
  const into = new Map<string, Span[]>(); // actor id → calls into it, in start order
  for (const s of sorted) {
    const candidates = into.get(s.from) ?? [];
    let parent: Span | undefined;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (c.startedAt <= s.startedAt && endOf(c, now) >= s.startedAt) {
        parent = c;
        break;
      }
    }
    // Fallback: the latest call into the caller, even if it already ended (late tool results).
    parent ??= candidates.at(-1);
    parentOf.set(s.id, parent?.id ?? null);
    (into.get(s.to) ?? into.set(s.to, []).get(s.to)!).push(s);
  }
  const kids = new Map<string | null, Span[]>();
  for (const s of sorted) {
    const p = parentOf.get(s.id) ?? null;
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(s);
  }
  const rows: WaterfallRow[] = [];
  const walk = (p: string | null, depth: number) => {
    for (const s of kids.get(p) ?? []) {
      rows.push({ span: s, parent: p, depth, children: (kids.get(s.id) ?? []).map((c) => c.id) });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Rows left after hiding the subtrees of collapsed rows. */
export function visibleRows(rows: WaterfallRow[], collapsed: Set<string>): WaterfallRow[] {
  const out: WaterfallRow[] = [];
  let hideBelow: number | null = null;
  for (const r of rows) {
    if (hideBelow !== null && r.depth > hideBelow) continue;
    hideBelow = null;
    out.push(r);
    if (collapsed.has(r.span.id) && r.children.length) hideBelow = r.depth;
  }
  return out;
}

/**
 * Percentile with linear interpolation (0 when empty). Nearest-rank would make the slowest call of a small
 * run *be* the p90, so nothing would ever count as slow.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, p / 100));
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (pos - lo);
}

export type WaterfallFilter = "all" | "errors" | "slow";

/**
 * Filter and search. Matches keep their ancestors as context (flagged `context`), so the tree still reads.
 * Slow = finished calls longer than the p90 of finished calls.
 */
export function filterRows(
  rows: WaterfallRow[],
  opts: { filter?: WaterfallFilter; query?: string; actors?: Map<string, Actor>; now?: number },
): { rows: WaterfallRow[]; context: Set<string>; p90: number } {
  const { filter = "all", query = "", actors, now = Date.now() } = opts;
  const finished = rows.filter((r) => !isRunning(r.span)).map((r) => durationOf(r.span, now));
  const p90 = percentile(finished, 90);
  const q = query.trim().toLowerCase();
  if (filter === "all" && !q) return { rows, context: new Set(), p90 };
  const match = (r: WaterfallRow) => {
    const s = r.span;
    if (filter === "errors" && !isFailed(s)) return false;
    if (filter === "slow" && (isRunning(s) || durationOf(s, now) <= p90 || finished.length < 2)) return false;
    if (!q) return true;
    const hay = [s.summary, actors?.get(s.to)?.label, actors?.get(s.from)?.label, s.error].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  };
  const byId = new Map(rows.map((r) => [r.span.id, r]));
  const keep = new Set<string>();
  const context = new Set<string>();
  for (const r of rows) {
    if (!match(r)) continue;
    keep.add(r.span.id);
    for (let p = r.parent; p && !keep.has(p); p = byId.get(p)?.parent ?? null) {
      keep.add(p);
      context.add(p);
    }
  }
  return { rows: rows.filter((r) => keep.has(r.span.id)), context, p90 };
}

/**
 * The chain that set the total time: start at the top-level call that ended last, then keep stepping into
 * the child that ended last.
 */
export function criticalPath(rows: WaterfallRow[], now = Date.now()): Set<string> {
  const byId = new Map(rows.map((r) => [r.span.id, r]));
  const latest = (ids: string[]) => ids.map((id) => byId.get(id)!).filter(Boolean).reduce<WaterfallRow | undefined>((m, r) => (!m || endOf(r.span, now) > endOf(m.span, now) ? r : m), undefined);
  const path = new Set<string>();
  let cur = latest(rows.filter((r) => r.parent === null).map((r) => r.span.id));
  while (cur) {
    path.add(cur.span.id);
    cur = latest(cur.children);
  }
  return path;
}

/* ---------- Time axis ---------- */

/** 1, 2 or 5 × 10^k at or above `v`. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * The full time range: first start to the last end, with live runs rounded up to a nice length so the
 * scale only changes now and then instead of every tick.
 */
export function timeDomain(spans: Span[], now = Date.now()): [number, number] {
  if (!spans.length) return [now, now + 1000];
  const t0 = Math.min(...spans.map((s) => s.startedAt));
  const end = Math.max(...spans.map((s) => endOf(s, now)));
  const live = spans.some(isRunning);
  const len = Math.max(1, end - t0);
  return [t0, t0 + (live ? niceCeil(len * 1.15) : len)];
}

/** Tick step for `range` ms across `px` pixels: about one tick per `every` px, on a 1/2/5 step. */
export function tickStep(range: number, px: number, every = 90): number {
  const target = range / Math.max(1, px / every);
  return niceCeil(Math.max(1, target));
}

/** Tick offsets (from the domain start) inside [from, to]. */
export function ticks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to + 1e-6 && out.length < 200; t += step) out.push(t);
  return out;
}

/** "0", "250ms", "1.5s", "12s", "1m 20s". */
export function formatOffset(ms: number, step = 1): string {
  if (ms === 0) return "0";
  const a = Math.abs(ms);
  const sign = ms < 0 ? "−" : "";
  if (a < 1000) return `${sign}${Math.round(a)}ms`;
  if (a < 60_000) {
    const s = a / 1000;
    const dec = step < 1000 ? (step < 100 ? 2 : 1) : 0;
    return `${sign}${s.toFixed(dec).replace(/\.0+$/, "")}s`;
  }
  const m = Math.floor(a / 60_000);
  const s = Math.round((a % 60_000) / 1000);
  return `${sign}${m}m${s ? ` ${s}s` : ""}`;
}

/** "84ms", "1.24s", "12.4s", "1m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Zoom window from a brush between two x fractions of the track; ignores tiny drags. */
export function brushView(view: [number, number], a: number, b: number, minFrac = 0.01): [number, number] | null {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(1, Math.max(a, b));
  if (hi - lo < minFrac) return null;
  const len = view[1] - view[0];
  return [view[0] + lo * len, view[0] + hi * len];
}

/** Bar placement as fractions of the view; clipped bars report which side was cut. */
export function barGeometry(span: Span, view: [number, number], now: number) {
  const len = Math.max(1, view[1] - view[0]);
  const s = (span.startedAt - view[0]) / len;
  const e = (endOf(span, now) - view[0]) / len;
  const left = Math.max(0, s);
  const right = Math.min(1, e);
  return { left, width: Math.max(0, right - left), visible: e >= 0 && s <= 1, cutLeft: s < 0, cutRight: e > 1 };
}

/* ---------- Virtualisation ---------- */

/** Offsets for rows of given heights, and the index range overlapping [top, top + height] (+ overscan). */
export function windowRange(heights: number[], top: number, height: number, overscan = 6) {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) offsets[i + 1] = offsets[i] + heights[i];
  let lo = 0;
  let hi = heights.length;
  // First row whose bottom is below top.
  let a = 0;
  let b = heights.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (offsets[m + 1] <= top) a = m + 1;
    else b = m;
  }
  lo = Math.max(0, a - overscan);
  a = lo;
  while (a < heights.length && offsets[a] < top + height) a++;
  hi = Math.min(heights.length, a + overscan);
  return { offsets, start: lo, end: hi, total: offsets[heights.length] };
}

/** Next row index for a key, or null when the key is not a move. */
export function stepRow(count: number, index: number, key: string): number | null {
  if (!count) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "PageDown") return Math.min(count - 1, index + 10);
  if (key === "PageUp") return Math.max(0, index - 10);
  return null;
}

/* ---------- Live axis (animated) ---------- */

const LIVE_STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10];

/**
 * Axis length for a live run: 15% headroom, rounded up on fine steps (each at most 25% above the last),
 * so the tweened axis rescales often but gently instead of doubling now and then.
 */
export function liveLength(len: number): number {
  const v = Math.max(1, len * 1.15);
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (LIVE_STEPS.find((s) => f <= s + 1e-9) ?? 10) * p;
}

/** Like timeDomain, but live runs use liveLength. Finished runs are exact. */
export function liveDomain(spans: Span[], now = Date.now()): [number, number] {
  if (!spans.length) return [now, now + 1000];
  let t0 = Infinity;
  let end = -Infinity;
  let live = false;
  for (const s of spans) {
    if (s.startedAt < t0) t0 = s.startedAt;
    const e = endOf(s, now);
    if (e > end) end = e;
    if (!s.outcome) live = true;
  }
  const len = Math.max(1, end - t0);
  return [t0, t0 + (live ? liveLength(len) : len)];
}

/**
 * One frame of an exponential ease toward a target (time constant `tau` ms): fast at first, settling softly,
 * frame-rate independent. Snaps when within `eps`.
 */
export function easeToward(current: number, target: number, dt: number, tau = 140, eps = 0.5): number {
  if (Math.abs(target - current) <= eps) return target;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / tau));
}
