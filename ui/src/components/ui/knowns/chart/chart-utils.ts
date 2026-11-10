export type ChartValue = number | null | undefined;
export type ChartDatum = Record<string, string | number | null | undefined>;

export interface ChartSeries {
  /** Key of the field in each datum. */
  key: string;
  /** Name in the legend, tooltip and data table. */
  label: string;
  /** Any CSS colour. Defaults to the restrained palette. */
  color?: string;
}

/** Colour for series `i`: one accent first, then quiet neutrals and two meaning colours. Override with `--chart-1..5`. */
export const SERIES_COLORS = [
  "var(--chart-1, oklch(0.585 0.2 277))",
  "var(--chart-2, oklch(0.62 0 0))",
  "var(--chart-3, oklch(0.66 0.14 160))",
  "var(--chart-4, oklch(0.74 0.15 75))",
  "var(--chart-5, oklch(0.62 0.19 20))",
];

export const seriesColor = (s: ChartSeries, i: number) => s.color ?? SERIES_COLORS[i % SERIES_COLORS.length];

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const valueAt = (d: ChartDatum, key: string): number | null => {
  const v = d[key];
  return isNum(v) ? v : null;
};

/** Round `step` up to 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** Evenly spaced round ticks that cover [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!isNum(min) || !isNum(max)) return [0, 1];
  if (min === max) {
    if (min === 0) return [0, 1];
    max = min > 0 ? min * 2 : 0;
    min = min > 0 ? 0 : min * 2;
  }
  const step = niceStep((max - min) / Math.max(1, count));
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** 1200 -> 1.2k, 3_400_000 -> 3.4M. Keeps small numbers as they are. */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${trim(v / 1e9)}B`;
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e4) return `${trim(v / 1e3)}k`;
  return trim(v);
}
const trim = (v: number) => String(Number(v.toFixed(Math.abs(v) < 10 && v % 1 ? 1 : 0)));

export interface Point {
  x: number;
  y: number | null;
}

/** Straight segments. A null y breaks the line, so gaps stay gaps. */
export function linePath(points: Point[], smooth = false): string {
  let d = "";
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) d += `M${f(run[0].x)},${f(run[0].y)}h0`;
    else if (run.length > 1) d += smooth ? monotone(run) : `M${run.map((p) => `${f(p.x)},${f(p.y)}`).join("L")}`;
    run = [];
  };
  for (const p of points) {
    if (p.y === null) flush();
    else run.push({ x: p.x, y: p.y });
  }
  flush();
  return d;
}

/** The area under a line to `base`, one closed shape per unbroken run. */
export function areaPath(points: Point[], base: number, smooth = false): string {
  const runs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.y === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push({ x: p.x, y: p.y });
  }
  if (cur.length) runs.push(cur);
  return runs
    .filter((r) => r.length > 1)
    .map((r) => `${smooth ? monotone(r) : `M${r.map((p) => `${f(p.x)},${f(p.y)}`).join("L")}`}L${f(r[r.length - 1].x)},${f(base)}L${f(r[0].x)},${f(base)}Z`)
    .join("");
}

const f = (n: number) => Number(n.toFixed(2));

/** Monotone cubic through the points: smooth, and never overshoots a peak. */
function monotone(p: { x: number; y: number }[]): string {
  const n = p.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1].x - p[i].x);
    m.push((p[i + 1].y - p[i].y) / (dx[i] || 1));
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) t[i] = t[i + 1] = 0;
    else {
      const a = t[i] / m[i];
      const b = t[i + 1] / m[i];
      const s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        t[i] = k * a * m[i];
        t[i + 1] = k * b * m[i];
      }
    }
  }
  let d = `M${f(p[0].x)},${f(p[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(p[i].x + h)},${f(p[i].y + t[i] * h)},${f(p[i + 1].x - h)},${f(p[i + 1].y - t[i + 1] * h)},${f(p[i + 1].x)},${f(p[i + 1].y)}`;
  }
  return d;
}

/** Per category, the [from, to] of each series when stacked in order (missing values count as 0). */
export function stackRows(data: ChartDatum[], keys: string[]): { from: number; to: number; value: number | null }[][] {
  return data.map((d) => {
    let acc = 0;
    return keys.map((k) => {
      const v = valueAt(d, k);
      const from = acc;
      acc += v && v > 0 ? v : 0;
      return { from, to: acc, value: v };
    });
  });
}

/** Value domain for the visible series. Bars and areas always include zero. */
export function valueDomain(data: ChartDatum[], keys: string[], opts: { stacked: boolean; zero: boolean }): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  if (opts.stacked) {
    for (const row of stackRows(data, keys)) {
      for (const c of row) {
        if (c.value === null) continue;
        max = Math.max(max, c.to);
        min = Math.min(min, 0);
      }
    }
  } else {
    for (const d of data) {
      for (const k of keys) {
        const v = valueAt(d, k);
        if (v === null) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  }
  if (min === Infinity) return null;
  if (opts.zero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  return [min, max];
}

/** Points for a sparkline in a w x h box with `pad` px around. Returns [] for fewer than 2 numbers. */
export function sparkPoints(values: ChartValue[], w: number, h: number, pad = 2): Point[] {
  const nums = values.filter(isNum);
  if (nums.length < 2) return [];
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const x = linear(0, values.length - 1, pad, w - pad);
  const y = linear(lo === hi ? lo - 1 : lo, lo === hi ? hi + 1 : hi, h - pad, pad);
  return values.map((v, i) => ({ x: x(i), y: isNum(v) ? y(v) : null }));
}
