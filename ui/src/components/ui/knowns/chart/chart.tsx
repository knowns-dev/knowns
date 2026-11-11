"use client";
/** @registry name="chart" type="ui" title="Chart" description="Line, bar (grouped or stacked), area and sparkline in plain SVG with no dependency: axes, grid, keyboard tooltip, legend toggles, empty state and a screen-reader data table." */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { EASE, MOTION, prefersReducedMotion } from "@/ui/lib/knowns/motion";
import {
  areaPath,
  barFlip,
  bezierOf,
  lerpPoints,
  type BarBox,
  compact,
  linePath,
  linear,
  niceTicks,
  seriesColor,
  stackRows,
  valueAt,
  valueDomain,
  type ChartDatum,
  type ChartSeries,
} from "./chart-utils";

export { Sparkline, type SparklineProps } from "./sparkline";
export type { ChartDatum, ChartSeries } from "./chart-utils";

export interface ChartProps {
  type?: "line" | "bar" | "area";
  data: ChartDatum[];
  /** Key of the category field (x axis): a label or a date string. */
  x: string;
  series: ChartSeries[];
  /** Name for screen readers and the data table caption. */
  label: string;
  /** Bars and areas: stack the series instead of grouping or overlaying them. */
  stacked?: boolean;
  /** Smooth lines and areas. Default false. */
  smooth?: boolean;
  /** Plot height in px. Default 240. */
  height?: number | "fill";
  /** Show the legend, which also toggles series. Default true when there is more than one series. */
  legend?: boolean;
  /** Format a value for the axis and the tooltip. Default: compact numbers. */
  format?: (v: number) => string;
  /** Format a category for the axis and the tooltip header. */
  formatX?: (x: string) => string;
  /** Fixed value range. Default: data range, including zero for bars and areas. */
  domain?: [number, number];
  /** No axes, labels or gridlines, only a baseline: a compact strip for use inside a card. Hover and keyboard still read each point. */
  bare?: boolean;
  /** Shown when there is no data. */
  empty?: ReactNode;
  className?: string;
}

/** A bar with only its far end (top when `up`, else bottom) rounded. */
const endRounded = (x: number, y: number, w: number, h: number, r: number, up: boolean) =>
  up
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;

const M = { top: 10, right: 8, bottom: 26 };
/**
 * Motion (see .claude/skills/kn-motion). No intro: the first render is the final state. A real data change (a new
 * period, a series toggled) shows what changed: bars FLIP from their old box to the new one (transform only, about
 * their base), new bars fade in, removed bars fade out where they were, and lines and areas tween their points. An
 * identical re-render or a resize plays nothing; reduced motion is instant. Hover is opacity only, 120ms.
 */
const STYLE = `
@keyframes knch-in{from{opacity:0}}
@keyframes knch-out{to{opacity:0}}
.knch-tip{animation:knch-in var(--kn-dur-fast, ${MOTION.fast}ms) var(--kn-ease-out, ${EASE.out}) both}
.knch-leave{pointer-events:none;animation:knch-out var(--kn-dur-fast, ${MOTION.fast}ms) var(--kn-ease-out, ${EASE.out}) both}
@media (prefers-reduced-motion: reduce){.knch-tip{animation:none}.knch-leave{display:none}}
`;
const FILL_MIN = 120;
const HOVER = "transition-opacity duration-(--kn-dur-fast) ease-(--kn-ease-out)";
const EASE_INOUT = bezierOf(EASE.inOut);

type Bar = BarBox & { key: string; i: number; fill: string; d: string; stub?: boolean };
type Pt = { x: number; y: number };
type Shape = { pts: Pt[]; base: Pt[] | null };

/** Line, bar and area charts in plain SVG. Arrow keys move the tooltip; the legend toggles series. */
export function Chart({ type = "line", data, x, series, label, stacked = false, smooth = false, height: heightProp = 240, legend, format = compact, formatX = (s) => s, domain, bare = false, empty = "No data yet", className }: ChartProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // height="fill": the plot takes the height its box gets from a flex or grid parent (at least FILL_MIN).
  const [boxH, setBoxH] = useState(0);
  const fill = heightProp === "fill";
  const height = fill ? Math.max(FILL_MIN, boxH) : heightProp;
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setWidth(Math.round(e.contentRect.width));
      setBoxH(Math.round(e.contentRect.height));
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setWidth(Math.round(r.width));
    setBoxH(Math.round(r.height));
    return () => ro.disconnect();
  }, []);

  const shown = series.filter((s) => !off.has(s.key));
  const keys = shown.map((s) => s.key);
  const isBar = type === "bar";
  const stack = stacked && (isBar || type === "area");
  const dom = useMemo(() => domain ?? valueDomain(data, keys, { stacked: stack, zero: type !== "line" }), [data, keys.join("|"), stack, type, domain]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasData = data.length > 0 && series.some((s) => data.some((d) => valueAt(d, s.key) !== null));

  const ticks = dom ? niceTicks(dom[0], dom[1], Math.max(2, Math.round(height / 56))) : [0, 1];
  const lo = bare && dom ? dom[0] : ticks[0];
  const hi = bare && dom ? dom[1] : ticks[ticks.length - 1];
  const left = bare ? 0 : Math.max(...ticks.map((t) => format(t).length)) * 6.4 + 12;
  const m = bare ? { top: 2, right: 0, bottom: 0 } : M;
  const iw = Math.max(0, width - left - m.right);
  const ih = height - m.top - m.bottom;
  const y = linear(lo, hi, m.top + ih, m.top);
  const n = data.length;
  const band = n ? iw / n : 0;
  const px = (i: number) => (isBar ? left + band * (i + 0.5) : left + (n > 1 ? (iw * i) / (n - 1) : iw / 2));
  const stackedRows = useMemo(() => (stack ? stackRows(data, keys) : []), [stack, data, keys.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - r.left - left;
    setActive(Math.max(0, Math.min(n - 1, isBar ? Math.floor(sx / band) : Math.round((sx / (iw || 1)) * (n - 1)))));
  };
  const key = (e: KeyboardEvent) => {
    if (!n) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (active === null ? 0 : active + 1) : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (active === null ? n - 1 : active - 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (e.key === "Escape") return setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };

  const everyX = band || (n > 1 ? iw / (n - 1) : iw) ? Math.max(1, Math.ceil(64 / (isBar ? band : iw / Math.max(1, n - 1)))) : 1;
  const act = active !== null && active < n ? active : null;
  const showLegend = legend ?? series.length > 1;
  const bw = isBar ? (stack ? Math.min(band * 0.62, 44) : Math.min((band * 0.72) / Math.max(1, shown.length), 28)) : 0;
  const gap = stack ? 0 : 3;
  const groupW = stack ? bw : shown.length * bw + (shown.length - 1) * gap;

  // What the marks show, as data: a change of it (not of width or hover) is what animates.
  const sig = JSON.stringify([type, stack, keys, data.map((d) => [d[x] ?? null, ...keys.map((k) => valueAt(d, k))])]);

  const bars: Bar[] = [];
  if (isBar)
    shown.forEach((s, si) =>
      data.forEach((d, i) => {
        const c = stack ? stackedRows[i]?.[si] : undefined;
        const v = valueAt(d, s.key);
        const k = `${s.key}-${i}`;
        const fill = seriesColor(s, series.indexOf(s));
        if (v === null && bare && !stack) return void bars.push({ key: k, i, fill, d: "", stub: true, x: px(i) - bw / 2, top: y(0) - 2, w: bw, h: 2, up: true });
        if (v === null || (stack && (!c || c.to === c.from))) return;
        const y0 = y(stack ? c!.from : 0);
        const y1 = y(stack ? c!.to : v);
        const top = Math.min(y0, y1);
        const h = Math.max(1, Math.abs(y0 - y1) - (stack ? 1 : 0));
        const bx = px(i) - groupW / 2 + (stack ? 0 : si * (bw + gap));
        // Only the outer end of a bar is rounded; inner joins of a stack stay square.
        const outer = stack ? !stackedRows[i].slice(si + 1).some((o) => o.to > o.from) : true;
        const up = stack || v >= 0;
        bars.push({ key: k, i, fill, x: bx, top, w: bw, h, up, d: outer ? endRounded(bx, top, bw, h, Math.min(4, bw / 2, h), up) : `M${bx},${top}h${bw}v${h}h${-bw}Z` });
      }),
    );

  const lines = isBar
    ? []
    : shown.map((s, si) => {
        const pts = data.map((d, i) => {
          const v = valueAt(d, s.key);
          const yy = stack ? (v === null ? null : y(stackedRows[i][si].to)) : v === null ? null : y(v);
          return { x: px(i), y: yy };
        });
        const base = stack && si > 0 ? data.map((_, i) => ({ x: px(i), y: y(stackedRows[i][si].from) })) : null;
        return { s, c: seriesColor(s, series.indexOf(s)), pts, base };
      });
  // Only lines with every point can morph; one with a gap swaps at once.
  const targets = new Map<string, Shape>();
  for (const l of lines) if (l.pts.every((p) => p.y !== null)) targets.set(l.s.key, { pts: l.pts as Pt[], base: l.base });

  const svgRef = useRef<SVGSVGElement>(null);
  const seen = useRef<{ sig: string; bars: Map<string, Bar>; shapes: Map<string, Shape>; lo: number; hi: number; ticks: number[] } | null>(null);
  const [leaving, setLeaving] = useState<Bar[]>([]);
  /** A running tween: the old shapes and the old value axis, and the eased progress. */
  const [tween, setTween] = useState<{ from: Map<string, Shape>; lo: number; hi: number; ticks: number[]; t: number } | null>(null);
  useLayoutEffect(() => {
    if (!width) return;
    const now = new Map(bars.filter((b) => !b.stub).map((b) => [b.key, b]));
    const prev = seen.current;
    seen.current = { sig, bars: now, shapes: targets, lo, hi, ticks };
    if (!prev || prev.sig === sig || prefersReducedMotion()) {
      setTween(null);
      return;
    }
    // Bars: FLIP. Drawn at the new box, started from the old one, transform only.
    for (const b of now.values()) {
      const el = svgRef.current?.querySelector<SVGElement>(`[data-bar="${b.key}"]`);
      if (!el || typeof el.animate !== "function") continue;
      el.getAnimations?.().forEach((a) => a.cancel());
      const o = prev.bars.get(b.key);
      const from = o ? barFlip(o, b) : null;
      if (from) el.animate([{ transform: from }, { transform: "none" }], { duration: MOTION.slow, easing: EASE.inOut });
      else if (!o) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.base, easing: EASE.out });
    }
    const gone = [...prev.bars.values()].filter((o) => !now.has(o.key));
    setLeaving(gone);
    const done = gone.length ? setTimeout(() => setLeaving([]), MOTION.fast) : undefined;
    // Lines and areas tween their points, and the value axis tweens its range, on the same timing (rAF: SVG path d
    // has no reliable CSS transition). The axis is what shows a new scale: gridlines slide to where their value now
    // sits while old labels fade out and new ones fade in.
    let raf = 0;
    if ((prev.shapes.size && targets.size) || prev.lo !== lo || prev.hi !== hi) {
      const start = performance.now();
      const from = { from: prev.shapes, lo: prev.lo, hi: prev.hi, ticks: prev.ticks };
      const step = (t: number) => {
        const p = Math.min(1, (t - start) / MOTION.slow);
        setTween(p >= 1 ? null : { ...from, t: EASE_INOUT(p) });
        if (p < 1) raf = requestAnimationFrame(step);
      };
      setTween({ ...from, t: 0 });
      raf = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [sig, width]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The points to draw now: mid-tween, between the old shape and the new. */
  const drawn = (key: string, pts: (Pt | { x: number; y: number | null })[], base: Pt[] | null) => {
    const from = tween?.from.get(key);
    const to = targets.get(key);
    if (!tween || !from || !to) return { pts, base };
    return { pts: lerpPoints(from.pts, to.pts, tween.t), base: to.base && from.base ? lerpPoints(from.base, to.base, tween.t) : to.base ? lerpPoints(from.pts, to.base, tween.t) : base };
  };

  // The value axis mid-tween: the range eases from the old one, old ticks fade out (twice as fast, so labels never crowd) and new ones in where they sit now.
  const mix = (a: number, b: number) => (tween ? a + (b - a) * tween.t : b);
  const tickY = tween ? linear(mix(tween.lo, lo), mix(tween.hi, hi), m.top + ih, m.top) : y;
  const tickRows = bare
    ? [{ t: lo, o: 1 }]
    : tween
      ? [...ticks.map((t) => ({ t, o: tween.ticks.includes(t) ? 1 : tween.t })), ...tween.ticks.filter((t) => !ticks.includes(t)).map((t) => ({ t, o: Math.max(0, 1 - tween.t * 2) }))]
      : ticks.map((t) => ({ t, o: 1 }));

  // The hover band and crosshair stay mounted at the last point, so leaving fades them instead of cutting them.
  const lastAct = useRef<number | null>(null);
  if (act !== null) lastAct.current = act;
  const bandAt = act ?? (lastAct.current !== null && lastAct.current < n ? lastAct.current : null);

  const tipRows = act === null ? [] : shown.map((s) => ({ s, i: series.indexOf(s), v: valueAt(data[act], s.key) }));
  const total = stack && act !== null ? tipRows.reduce((a, r) => a + (r.v ?? 0), 0) : null;
  const tipLeft = act === null ? 0 : px(act);
  const flip = tipLeft > width * 0.6;

  return (
    <figure className={cn("flex flex-col gap-3", fill && "h-full min-h-0", className)}>
      <style>{STYLE}</style>
      <div ref={box} className={cn("relative w-full", fill && "min-h-0 flex-1")} style={fill ? { minHeight: FILL_MIN } : { height }}>
        {!hasData ? (
          <div role="img" aria-label={`${label}: no data`} className="grid size-full place-items-center rounded-xl border border-dashed border-border text-[13px] text-muted-foreground">
            {empty}
          </div>
        ) : (
          width > 0 && (
            <>
              <svg
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                ref={svgRef}
                role="img"
                aria-label={`${label}. ${type} chart, ${n} points. Arrow keys read each point; the data table follows.`}
                tabIndex={0}
                aria-describedby={`${id}-live`}
                className={cn("block rounded-md text-muted-foreground", focusRing)}
                onPointerMove={move}
                onPointerLeave={() => setActive(null)}
                onKeyDown={key}
                onBlur={() => setActive(null)}
              >
                {tickRows.map(({ t, o }) => (
                  <g key={t} opacity={tickY(t) < m.top - 1 || tickY(t) > m.top + ih + 1 ? 0 : o}>
                    <line x1={left} x2={width - m.right} y1={tickY(t)} y2={tickY(t)} stroke="currentColor" strokeOpacity={t === 0 || bare ? 0.35 : 0.14} />
                    {!bare && <text x={left - 8} y={tickY(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="currentColor" className="tabular-nums">
                      {format(t)}
                    </text>}
                  </g>
                ))}
                {!bare && data.map((d, i) =>
                  (n - 1 - i) % everyX === 0 ? (
                    <text key={i} x={px(i)} y={height - 7} textAnchor={!isBar && i === 0 && n > 1 ? "start" : !isBar && i === n - 1 ? "end" : "middle"} fontSize={11} fill="currentColor">
                      {formatX(String(d[x] ?? ""))}
                    </text>
                  ) : null,
                )}
                {bandAt !== null &&
                  (isBar ? (
                    <rect data-band="" x={left + band * bandAt} y={m.top} width={band} height={ih} rx={6} fill="currentColor" className={HOVER} style={{ opacity: act === null ? 0 : 0.08 }} />
                  ) : (
                    <line data-band="" x1={px(bandAt)} x2={px(bandAt)} y1={m.top} y2={m.top + ih} stroke="currentColor" strokeOpacity={0.4} strokeDasharray="3 3" className={HOVER} style={{ opacity: act === null ? 0 : 1 }} />
                  ))}

                {bars.map((b) =>
                  b.stub ? (
                    <rect key={b.key} x={b.x} y={b.top} width={b.w} height={b.h} rx={1} fill="currentColor" opacity={0.2} />
                  ) : (
                    <path
                      key={b.key}
                      data-bar={b.key}
                      d={b.d}
                      fill={b.fill}
                      className={HOVER}
                      style={{ opacity: act === null || act === b.i ? 1 : 0.55, transformBox: "fill-box", transformOrigin: b.up ? "50% 100%" : "50% 0%" }}
                    />
                  ),
                )}
                {leaving.map((b) => (
                  <path key={`leave-${b.key}`} data-leaving="" d={b.d} fill={b.fill} className="knch-leave" />
                ))}

                {lines.map(({ s, c, pts: target, base: targetBase }) => {
                  const { pts, base } = drawn(s.key, target, targetBase);
                  return (
                    <g key={s.key} style={{ color: c }}>
                      {type === "area" &&
                        (!base ? (
                          <path d={areaPath(pts, y(Math.max(lo, Math.min(0, hi))), smooth)} fill="currentColor" opacity={stack ? 0.5 : 0.14} />
                        ) : (
                          <path d={`${linePath(pts, smooth)}L${[...base].reverse().map((p) => `${p.x},${p.y}`).join("L")}Z`} fill="currentColor" opacity={0.5} />
                        ))}
                      <path data-line={s.key} d={linePath(pts, smooth)} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
                      {act !== null && pts[act]?.y != null && <circle cx={pts[act].x} cy={pts[act].y!} r={4} fill="var(--card, #fff)" stroke="currentColor" strokeWidth={2} />}
                    </g>
                  );
                })}
              </svg>

              {act !== null && (
                <div
                  aria-hidden="true"
                  className={cn("knch-tip pointer-events-none absolute z-10 min-w-36 rounded-xl border border-border bg-popover px-3 py-2 text-[12.5px] text-popover-foreground shadow-md", bare ? "-top-1.5" : "top-1")}
                  style={{ left: tipLeft, transform: bare ? `translate(${flip ? "calc(-100% - 12px)" : "12px"}, -100%)` : `translateX(${flip ? "calc(-100% - 12px)" : "12px"})` }}
                >
                  <div className="mb-1.5 font-medium">{formatX(String(data[act][x] ?? ""))}</div>
                  <ul className="flex flex-col gap-1">
                    {tipRows.map((r) => (
                      <li key={r.s.key} className="flex items-center gap-2">
                        <span className="size-2 flex-none rounded-[3px]" style={{ background: seriesColor(r.s, r.i) }} />
                        <span className="text-muted-foreground">{r.s.label}</span>
                        <span className="ml-auto pl-3 font-medium tabular-nums">{r.v === null ? "-" : format(r.v)}</span>
                      </li>
                    ))}
                    {total !== null && tipRows.length > 1 && (
                      <li className="mt-0.5 flex items-center gap-2 border-t border-border pt-1.5">
                        <span className="text-muted-foreground">Total</span>
                        <span className="ml-auto pl-3 font-medium tabular-nums">{format(total)}</span>
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </>
          )
        )}
      </div>

      <div id={`${id}-live`} className="sr-only" aria-live="polite">
        {act !== null && `${formatX(String(data[act][x] ?? ""))}: ${tipRows.map((r) => `${r.s.label} ${r.v === null ? "no value" : format(r.v)}`).join(", ")}`}
      </div>

      {showLegend && hasData && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]" aria-label="Series">
          {series.map((s, i) => {
            const on = !off.has(s.key);
            return (
              <li key={s.key}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={on && shown.length === 1}
                  onClick={() => setOff((p) => { const nx = new Set(p); if (on) nx.add(s.key); else nx.delete(s.key); return nx; })}
                  className={cn("inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)", on ? "text-foreground" : "text-muted-foreground line-through", "enabled:hover:bg-muted", focusRing)}
                >
                  <span className="size-2 flex-none rounded-[3px]" style={{ background: seriesColor(s, i), opacity: on ? 1 : 0.35 }} />
                  {s.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hasData && (
        <table className="sr-only">
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{x}</th>
              {series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.map((d, i) => (
              <tr key={i}>
                <th scope="row">{formatX(String(d[x] ?? ""))}</th>
                {series.map((s) => { const v = valueAt(d, s.key); return <td key={s.key}>{v === null ? "" : format(v)}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
