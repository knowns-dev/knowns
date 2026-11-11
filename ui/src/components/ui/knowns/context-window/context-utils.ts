export type ContextKind = "system" | "tools" | "history" | "files" | "output" | "other";

/** One piece of a segment: a file, a turn, a tool result. */
export interface ContextPart {
  id: string;
  label: string;
  tokens: number;
  /** A second line for hover and focus (a path, a time, a tool name). */
  detail?: string;
  /** Ids of the parts this one replaced (a compaction summary). */
  summaryOf?: string[];
}

export interface ContextSegment {
  id: string;
  label: string;
  /** The segment's size. With `parts`, pass their sum (or leave the parts to say it: see `segmentTokens`). */
  tokens: number;
  /** Picks the default colour; "output" is a reserve by default. */
  kind?: ContextKind;
  color?: string;
  /** Space held back (e.g. for the model's answer): drawn hatched after what's used, not counted as used. */
  reserve?: boolean;
  /** What it is made of: files, turns, results. The legend can open them (and remove one); the treemap draws each. */
  parts?: ContextPart[];
  /** A second line for hover and focus. */
  detail?: string;
  /** Ids of the parts or segments this one replaced (a compaction summary): the treemap squeezes them into it. */
  summaryOf?: string[];
}

export type ContextState = "ok" | "warn" | "full" | "over";

export const KIND_COLOR: Record<ContextKind, string> = {
  system: "#64748b",
  tools: "#8b5cf6",
  history: "#6366f1",
  files: "#0ea5e9",
  output: "#f59e0b",
  other: "#14b8a6",
};
/** Colours for segments without a kind, in order. */
const EXTRA = ["#14b8a6", "#ec4899", "#06b6d4", "#84cc16", "#f43f5e"];

export const isReserve = (s: ContextSegment) => s.reserve ?? s.kind === "output";

/** A segment's tokens: its own number, or the sum of its parts when it has parts and tokens is 0. */
export function segTokens(s: ContextSegment): number {
  if (s.tokens > 0) return s.tokens;
  return s.parts?.reduce((n, p) => n + Math.max(0, p.tokens), 0) ?? 0;
}

/** Segment colours: its own, else its kind's, else the next extra colour. */
export function segmentColors(segments: ContextSegment[]): Map<string, string> {
  let k = 0;
  return new Map(segments.map((s) => [s.id, s.color ?? (s.kind ? KIND_COLOR[s.kind] : EXTRA[k++ % EXTRA.length])]));
}

/**
 * The window size: `limit` if given, else the `model`'s entry in `limits` (exact, then ignoring case and
 * spacing). Null when unknown - the bar then shows the breakdown without a percentage.
 */
export function resolveLimit(limit?: number, model?: string, limits?: Record<string, number>): number | null {
  if (limit !== undefined && limit > 0) return limit;
  if (!model || !limits) return null;
  if (limits[model] > 0) return limits[model];
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const hit = Object.entries(limits).find(([k]) => norm(k) === norm(model));
  return hit && hit[1] > 0 ? hit[1] : null;
}

export interface ContextTotals {
  used: number;
  reserved: number;
  /** Room left after what's used and reserved (negative when over). */
  free: number;
  /** used / limit. */
  pct: number;
  /** (used + reserved) / limit: what the thresholds look at. */
  fill: number;
}

export function contextTotals(segments: ContextSegment[], limit: number | null): ContextTotals {
  const used = segments.filter((s) => !isReserve(s)).reduce((n, s) => n + segTokens(s), 0);
  const reserved = segments.filter(isReserve).reduce((n, s) => n + segTokens(s), 0);
  if (!limit) return { used, reserved, free: 0, pct: 0, fill: 0 };
  return { used, reserved, free: limit - used - reserved, pct: used / limit, fill: (used + reserved) / limit };
}

/** ok below `warnAt`; warn up to `fullAt`; full up to 100%; over past the limit. */
export function contextState(fill: number, warnAt = 0.8, fullAt = 0.95): ContextState {
  if (fill > 1) return "over";
  if (fill >= fullAt) return "full";
  if (fill >= warnAt) return "warn";
  return "ok";
}

/** "950", "12.4k", "124k", "1M", "1.05M". */
export function formatTokens(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a < 1000) return `${sign}${Math.round(a)}`;
  if (a < 1_000_000) {
    const k = a / 1000;
    return `${sign}${k < 10 ? +k.toFixed(1) : k < 100 ? +k.toFixed(1) : Math.round(k)}k`;
  }
  const m = a / 1_000_000;
  return `${sign}${m < 10 ? +m.toFixed(2) : +m.toFixed(1)}M`;
}

/** "62%" (whole percent; "<1%" for a sliver, never "0%" when something is there). */
export function formatPct(p: number): string {
  if (p > 0 && p < 0.01) return "<1%";
  return `${Math.round(p * 100)}%`;
}

/** The state in words, with what to do about it. */
export function stateSentence(state: ContextState, t: ContextTotals, fmt: (n: number) => string = formatTokens): string {
  switch (state) {
    case "ok":
      return `${fmt(Math.max(0, t.free))} free`;
    case "warn":
      return `Filling up · ${fmt(Math.max(0, t.free))} left, compact soon`;
    case "full":
      return `Almost full · ${fmt(Math.max(0, t.free))} left, the next turn may not fit`;
    case "over":
      // What's used still fits; the output reserve is what doesn't.
      if (t.pct <= 1) return `Output reserve doesn't fit · ${fmt(-t.free)} short, compact now`;
      return `Over the limit by ${fmt(-t.free)} · compact or drop something`;
  }
}

/** "Warns at 80% · full at 95%". */
export const thresholdsText = (warnAt: number, fullAt: number) => `Warns at ${formatPct(warnAt)} · full at ${formatPct(fullAt)}`;

/** Turns where usage dropped by more than a fifth (a compaction, or history cut): their indexes. */
export function drops(history: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < history.length; i++) if (history[i] < history[i - 1] * 0.8) out.push(i);
  return out;
}

/* ── Cells: the window as a field of equal cells, each worth a fixed number of tokens ── */

/** The smallest 1, 2 or 5 x 10^n at or above `x`: 830 -> 1000, 1200 -> 2000. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/** Tokens per cell so the window is about `target` cells, on a round number. */
export const autoCellTokens = (span: number, target = 240) => niceStep(span / target);

export interface CellSlot {
  /** The segment filling this cell; null for free room. */
  id: string | null;
  reserve: boolean;
}

/**
 * Which segment fills each cell. Segments are laid end to end (what's used, then the reserve) and each
 * takes the cells its running total rounds to, so a segment never loses a cell to rounding next door,
 * and anything above zero gets at least one cell. The rest of `span` is free.
 */
export function cellPlan(segments: ContextSegment[], span: number, cellTokens: number): CellSlot[] {
  const step = Math.max(1, cellTokens);
  const count = Math.max(1, Math.ceil(span / step));
  const out: CellSlot[] = Array.from({ length: count }, () => ({ id: null, reserve: false }));
  const ordered = [...segments.filter((s) => !isReserve(s)), ...segments.filter(isReserve)];
  let at = 0;
  let cell = 0;
  for (const s of ordered) {
    const t = segTokens(s);
    if (!t) continue;
    at += t;
    const end = Math.max(cell + 1, Math.round(at / step));
    for (; cell < end && cell < count; cell++) out[cell] = { id: s.id, reserve: isReserve(s) };
  }
  return out;
}
