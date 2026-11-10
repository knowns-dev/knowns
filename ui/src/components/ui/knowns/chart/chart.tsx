"use client";
/** @registry name="chart" type="ui" title="Chart" description="Line, bar (grouped or stacked), area and sparkline in plain SVG with no dependency: axes, grid, keyboard tooltip, legend toggles, empty state and a screen-reader data table." */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import {
  areaPath,
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
  height?: number;
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
const CSS = `
@media (prefers-reduced-motion: no-preference){
  .knch-line{stroke-dasharray:1;stroke-dashoffset:1;animation:knch-draw .7s var(--kn-ease-out,cubic-bezier(.22,1,.36,1)) forwards}
  .knch-fade{opacity:0;animation:knch-in .5s .15s var(--kn-ease-out,cubic-bezier(.22,1,.36,1)) forwards}
  .knch-bar{transform-box:fill-box;transform-origin:50% 100%;animation:knch-grow .5s var(--kn-ease-out,cubic-bezier(.22,1,.36,1)) both}
}
@keyframes knch-draw{to{stroke-dashoffset:0}}
@keyframes knch-in{to{opacity:1}}
@keyframes knch-grow{from{transform:scaleY(0)}}
`;

/** Line, bar and area charts in plain SVG. Arrow keys move the tooltip; the legend toggles series. */
export function Chart({ type = "line", data, x, series, label, stacked = false, smooth = false, height = 240, legend, format = compact, formatX = (s) => s, domain, bare = false, empty = "No data yet", className }: ChartProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
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

  const tipRows = act === null ? [] : shown.map((s) => ({ s, i: series.indexOf(s), v: valueAt(data[act], s.key) }));
  const total = stack && act !== null ? tipRows.reduce((a, r) => a + (r.v ?? 0), 0) : null;
  const tipLeft = act === null ? 0 : px(act);
  const flip = tipLeft > width * 0.6;

  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      <style>{CSS}</style>
      <div ref={box} className="relative w-full" style={{ height }}>
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
                {(bare ? [lo] : ticks).map((t) => (
                  <g key={t}>
                    <line x1={left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 || bare ? 0.35 : 0.14} />
                    {!bare && <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="currentColor" className="tabular-nums">
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
                {act !== null && (isBar ? <rect x={left + band * act} y={m.top} width={band} height={ih} rx={6} fill="currentColor" opacity={0.08} /> : <line x1={px(act)} x2={px(act)} y1={m.top} y2={m.top + ih} stroke="currentColor" strokeOpacity={0.4} strokeDasharray="3 3" />)}

                {isBar &&
                  shown.map((s, si) =>
                    data.map((d, i) => {
                      const c = stack ? stackedRows[i]?.[si] : undefined;
                      const v = valueAt(d, s.key);
                      if (v === null && bare && !stack) return <rect key={`${s.key}-${i}`} x={px(i) - bw / 2} y={y(0) - 2} width={bw} height={2} rx={1} fill="currentColor" opacity={0.2} />;
                      if (v === null || (stack && (!c || c.to === c.from))) return null;
                      const y0 = y(stack ? c!.from : 0);
                      const y1 = y(stack ? c!.to : v);
                      const top = Math.min(y0, y1);
                      const h = Math.max(1, Math.abs(y0 - y1) - (stack ? 1 : 0));
                      const bx = px(i) - groupW / 2 + (stack ? 0 : si * (bw + gap));
                      // Only the outer end of a bar is rounded; inner joins of a stack stay square.
                      const outer = stack ? !stackedRows[i].slice(si + 1).some((o) => o.to > o.from) : true;
                      const up = stack || v >= 0;
                      const common = { className: "knch-bar", fill: seriesColor(s, series.indexOf(s)), opacity: act === null || act === i ? 1 : 0.55, style: { animationDelay: `${i * 18}ms` } };
                      if (!outer) return <rect key={`${s.key}-${i}`} x={bx} y={top} width={bw} height={h} {...common} />;
                      return <path key={`${s.key}-${i}`} d={endRounded(bx, top, bw, h, Math.min(4, bw / 2, h), up)} {...common} />;
                    }),
                  )}

                {!isBar &&
                  shown.map((s, si) => {
                    const c = seriesColor(s, series.indexOf(s));
                    const pts = data.map((d, i) => {
                      const v = valueAt(d, s.key);
                      const yy = stack ? (v === null ? null : y(stackedRows[i][si].to)) : v === null ? null : y(v);
                      return { x: px(i), y: yy };
                    });
                    const base = stack && si > 0 ? data.map((_, i) => ({ x: px(i), y: y(stackedRows[i][si].from) })) : null;
                    return (
                      <g key={s.key} style={{ color: c }}>
                        {type === "area" && (
                          <g className="knch-fade">
                            {!base ? <path d={areaPath(pts, y(Math.max(lo, Math.min(0, hi))), smooth)} fill="currentColor" opacity={stack ? 0.5 : 0.14} /> : <path d={`${linePath(pts, smooth)}L${[...base].reverse().map((p) => `${p.x},${p.y}`).join("L")}Z`} fill="currentColor" opacity={0.5} />}
                          </g>
                        )}
                        <path className="knch-line" pathLength={1} d={linePath(pts, smooth)} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
                        {act !== null && pts[act]?.y != null && <circle cx={pts[act].x} cy={pts[act].y!} r={4} fill="var(--card, #fff)" stroke="currentColor" strokeWidth={2} />}
                      </g>
                    );
                  })}
              </svg>

              {act !== null && (
                <div
                  aria-hidden="true"
                  className={cn("pointer-events-none absolute z-10 min-w-36 rounded-xl border border-border bg-popover px-3 py-2 text-[12.5px] text-popover-foreground shadow-md", bare ? "-top-1.5" : "top-1")}
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
                  className={cn("inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors", on ? "text-foreground" : "text-muted-foreground line-through", "enabled:hover:bg-muted", focusRing)}
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
