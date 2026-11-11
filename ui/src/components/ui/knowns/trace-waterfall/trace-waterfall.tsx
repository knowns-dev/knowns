"use client";
/** @registry name="trace-waterfall" type="ui" title="Trace waterfall" description="Every call of a run on one time axis: nested by caller, live bars, inline input/output/error, filters, search, brush zoom, critical path and virtualised rows." */

import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { actorColors, formatUsd, readableInk, rootAgent, spanColor } from "@/ui/lib/knowns/status";
import { useAgentSnapshot, type AgentRun } from "@/ui/lib/knowns/run";
import { CodeBlock } from "../code-block/code-block";
import { actorIcon } from "@/ui/lib/knowns/icons/actor-icon";
import type { Actor, Span } from "@/ui/lib/knowns/types";
import { Button } from "../button";
import { Input } from "../input";
import { SegmentedControl } from "../segmented-control";
import { Tooltip } from "../tooltip";
import {
  barGeometry,
  brushView,
  buildRows,
  criticalPath,
  durationOf,
  easeToward,
  filterRows,
  formatDuration,
  formatOffset,
  isFailed,
  isRunning,
  liveDomain,
  stepRow,
  tickStep,
  ticks,
  visibleRows,
  windowRange,
  type WaterfallFilter,
  type WaterfallRow,
} from "./waterfall-utils";

export type { WaterfallFilter } from "./waterfall-utils";

export interface TraceWaterfallProps {
  /** Read spans and actors live from a run. Takes precedence over `spans` / `actors`. */
  run?: AgentRun;
  spans?: Span[];
  actors?: Actor[];
  title?: ReactNode;
  /** Initial filter. Default "all". */
  defaultFilter?: WaterfallFilter;
  /** Highlight the chain that set the total time, on first render. */
  defaultCriticalPath?: boolean;
  /** Body height in px before it scrolls. Default 460. */
  maxHeight?: number;
  /** Rows above this count are virtualised. Default 200. */
  virtualizeAbove?: number;
  /** Clock override for tests and stills. */
  now?: number;
  className?: string;
}

const EASE = "ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]";
/** Rows gliding to a new place, the body growing, a new row settling in. */
const GLIDE = `duration-[380ms] ${EASE} motion-reduce:transition-none`;

/* Bars, labels and ticks are placed in CSS from times (ms after `anchor`) and three variables on the root:
   --kn-v0 / --kn-vlen (the view, tweened every frame) and --kn-now (the live clock). One rAF loop writes
   them; React only re-renders when the data changes. Transforms and clip-path only: no layout per frame. */
const X = (t: string) => `calc((${t} - var(--kn-v0)) / var(--kn-vlen) * 100%)`;
const LEN = (from: string, to: string) => `max(2px, (${to} - ${from}) / var(--kn-vlen) * 100%)`;
type Vars = CSSProperties & Record<`--${string}`, string | number>;

function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}
const ROW_H = 32;
const EMPTY_SPANS: Span[] = [];
const EMPTY_ACTORS: Actor[] = [];
const DETAIL_GUESS = 190;
const INDENT = 14;

const SURFACE = cn(
  "@container relative flex flex-col overflow-x-clip rounded-2xl border bg-card text-[13px] text-card-foreground",
  "[border-color:color-mix(in_srgb,var(--foreground)_8%,transparent)]",
  "shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_5%,transparent),0_1px_2px_rgb(0_0_0/0.04)]",
  "dark:[background:color-mix(in_srgb,var(--card)_70%,#000)] dark:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_7%,transparent),0_10px_24px_-16px_rgb(0_0_0/0.55)]",
);
const HAIR = "[border-color:color-mix(in_srgb,var(--foreground)_7%,transparent)]";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "errors", label: "Errors" },
  { value: "slow", label: "Slow" },
];

function Block({ label, value, tone }: { label: string; value: unknown; tone?: "error" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={cn("text-[11px] font-medium tracking-wide uppercase", tone === "error" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>{label}</span>
      <div className={cn("overflow-hidden rounded-[8px]", tone === "error" ? "bg-red-500/[0.06] text-red-700 dark:text-red-300" : "bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]")}>
        <CodeBlock flush code={typeof value === "string" ? value : JSON.stringify(value, null, 2)} language={typeof value === "string" ? undefined : "json"} label={false} copy={false} wrapToggle={false} defaultWrap maxHeight={160} aria-label={`${label}`} className="[&_pre]:py-2! [&_pre]:text-[11.5px]! [&_pre]:leading-relaxed! [&_[data-line]]:px-2.5!" />
      </div>
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3 transition-transform duration-200 motion-reduce:transition-none", EASE, open && "rotate-90")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4l4 4-4 4" />
  </svg>
);
const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.5 10.5l3 3" />
  </svg>
);

/**
 * Every call of a run on one time axis: rows nested by caller (lead → subagent → its tools), bars coloured
 * by agent, running bars growing live, failures in red. Rows open inline into input / output / error.
 * Filter by errors or slow calls (> p90), search, collapse subtrees, brush the axis to zoom. Long runs are
 * virtualised.
 */
export function TraceWaterfall({
  run,
  spans: spansProp,
  actors: actorsProp,
  title = "Trace",
  defaultFilter = "all",
  defaultCriticalPath = false,
  maxHeight = 460,
  virtualizeAbove = 200,
  now: fixedNow,
  className,
}: TraceWaterfallProps) {
  const snap = useAgentSnapshot(run);
  // Deferred: a busy run emits many events a second; React may skip renders in between (the bars move
  // every frame anyway, see the motion loop), so typing, scrolling and the clock stay smooth.
  const spans = useDeferredValue(snap?.spans ?? spansProp ?? EMPTY_SPANS);
  const actors = useDeferredValue(snap?.actors ?? actorsProp ?? EMPTY_ACTORS);
  const id = useId();

  /* Clock for React (labels, filters, aria): once a second while something runs. The bars themselves move
     every frame through --kn-now (see the loop below). */
  const live = spans.some(isRunning);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNow !== undefined || !live) return;
    setTick(Date.now());
    const iv = window.setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [live, fixedNow]);
  const now = fixedNow ?? (live ? tick : Math.max(tick, ...spans.map((s) => s.endedAt ?? 0)));

  const actorById = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors]);
  const colors = useMemo(() => actorColors(actors), [actors]);
  const rootId = useMemo(() => rootAgent(actors)?.id, [actors]);
  const rows = useMemo(() => buildRows(spans, now), [spans, now]);
  const domain = useMemo(() => liveDomain(spans, now), [spans, now]);

  /* Controls. */
  const [filter, setFilter] = useState<WaterfallFilter>(defaultFilter);
  const [query, setQuery] = useState("");
  const [showCritical, setShowCritical] = useState(defaultCriticalPath);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const view: [number, number] = zoom ?? domain;

  /* Motion. Times are relative to a fixed anchor, so dropping old spans never moves anything.
     React renders bars with CSS variables (right for SSR and the first paint). After every commit and on
     every animation frame, place() writes px transforms straight onto the few moving elements: changing a
     variable on the root would restyle every element below it, each frame. Settled: only running bars move. */
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [anchor] = useState(() => (spans.length ? Math.min(...spans.map((s) => s.startedAt)) : Date.now()));
  const [initialVars] = useState<Vars>(() => ({ "--kn-v0": view[0] - anchor, "--kn-vlen": Math.max(1, view[1] - view[0]), "--kn-now": now - anchor }));
  const shownView = useRef<{ v0: number; v1: number } | null>(null);
  const trackW = useRef(0);
  const latest = useRef({ spans, zoom, fixedNow, reduce });
  latest.current = { spans, zoom, fixedNow, reduce };

  /** Target view now: the zoom, else the (live) domain. */
  const targetView = (wall: number): [number, number] => latest.current.zoom ?? liveDomain(latest.current.spans, wall);
  const place = (onlyLive: boolean, wall: number) => {
    const root = rootRef.current;
    const W = trackW.current;
    const cur = shownView.current;
    if (!root || !W || !cur) return;
    const v0 = cur.v0 - anchor;
    const k = W / Math.max(1, cur.v1 - cur.v0);
    const nowRel = wall - anchor;
    for (const el of root.querySelectorAll<HTMLElement>(onlyLive ? "[data-kn-live]" : "[data-kn]")) {
      const st = Number(el.dataset.knS);
      const en = el.dataset.knE !== undefined ? Number(el.dataset.knE) : nowRel;
      const x = (st - v0) * k;
      const w = Math.max(2, (en - st) * k);
      switch (el.dataset.kn) {
        case "at":
          el.style.transform = `translateX(${x}px)`;
          break;
        case "end":
          el.style.transform = `translateX(${x + w}px)`;
          break;
        case "fill":
          el.style.clipPath = `inset(0 calc(100% - ${w}px) 0 0 round 3px)`;
          break;
        case "edge":
          el.style.transform = `translateX(${w}px) translateX(-100%)`;
          break;
        case "ring":
          el.style.width = `${w + 6}px`;
          break;
      }
    }
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // After every commit, before paint: new and re-rendered elements get their px placement.
  useLayoutEffect(() => {
    const wall = fixedNow ?? Date.now();
    if (!shownView.current) {
      const [t0, t1] = targetView(wall);
      shownView.current = { v0: t0, v1: t1 };
    }
    place(false, wall);
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    let last = performance.now();
    let lastText = 0;
    let lastPaint = 0;
    const frame = (ts: number) => {
      const { spans: ss, fixedNow: fixed, reduce: still } = latest.current;
      const wall = fixed ?? Date.now();
      const running = ss.some(isRunning);
      const [t0, t1] = targetView(wall);
      const cur = (shownView.current ??= { v0: t0, v1: t1 });
      const dt = Math.min(64, ts - last);
      last = ts;
      const before = cur.v0 + cur.v1;
      if (still) {
        cur.v0 = t0;
        cur.v1 = t1;
      } else {
        const eps = Math.max(0.5, (t1 - t0) * 1e-4);
        cur.v0 = easeToward(cur.v0, t0, dt, 140, eps);
        cur.v1 = easeToward(cur.v1, t1, dt, 140, eps);
      }
      const moved = cur.v0 + cur.v1 !== before;
      const settled = cur.v0 === t0 && cur.v1 === t1;
      // Reduced motion: no tweening, and running bars step twice a second instead of gliding.
      if (moved || !still || ts - lastPaint >= 500) {
        lastPaint = ts;
        placeRef.current(!moved, wall);
      }
      // Running durations, about ten times a second (React would re-render every row).
      if (running && ts - lastText >= 100) {
        lastText = ts;
        root.querySelectorAll<HTMLElement>("[data-live-start]").forEach((n) => {
          n.textContent = `${formatDuration(Math.max(0, wall - Number(n.dataset.liveStart)))}…`;
        });
      }
      raf = running || !settled ? requestAnimationFrame(frame) : 0;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spans, zoom, fixedNow, reduce, anchor]);

  const filtered = useMemo(() => filterRows(rows, { filter, query, actors: actorById, now }), [rows, filter, query, actorById, now]);
  const shown = useMemo(() => visibleRows(filtered.rows, collapsed), [filtered.rows, collapsed]);
  const critical = useMemo(() => (showCritical ? criticalPath(rows, now) : new Set<string>()), [showCritical, rows, now]);
  const errors = spans.filter(isFailed).length;

  /* Rows that just appeared (new spans, an expanded subtree, a filter change) settle in; spans that just
     finished fade their duration in. Not on first render, not under reduced motion, not on virtual scroll. */
  const seen = useRef<{ shown: Set<string>; running: Set<string> } | null>(null);
  const prevSeen = seen.current;
  const entering = (sid: string) => !reduce && !!prevSeen && !prevSeen.shown.has(sid);
  const justFinished = (sid: string) => !reduce && !!prevSeen && prevSeen.running.has(sid);
  useEffect(() => {
    seen.current = { shown: new Set(shown.map((r) => r.span.id)), running: new Set(spans.filter(isRunning).map((s) => s.id)) };
  });

  /* Focus: roving tabindex over the visible rows. */
  const [active, setActive] = useState<string | null>(null);
  const activeIndex = Math.max(0, shown.findIndex((r) => r.span.id === active));
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const focusRow = (i: number) => {
    const r = shown[i];
    if (!r) return;
    setActive(r.span.id);
    // Scroll into range first (virtualised rows may not be mounted yet), then focus.
    const body = bodyRef.current;
    const top = layout.offsets[i];
    if (body && (top < body.scrollTop || top + ROW_H > body.scrollTop + body.clientHeight)) body.scrollTop = Math.max(0, top - body.clientHeight / 3);
    requestAnimationFrame(() => rowEls.current.get(r.span.id)?.focus({ preventScroll: true }));
  };

  /* Heights: 32px rows; open rows are measured. */
  const [measured, setMeasured] = useState<Map<string, number>>(() => new Map());
  const heights = shown.map((r) => (open.has(r.span.id) ? (measured.get(r.span.id) ?? ROW_H + DETAIL_GUESS) : ROW_H));
  const [scrollTop, setScrollTop] = useState(0);
  const [bodyH, setBodyH] = useState(maxHeight);
  const virtual = shown.length > virtualizeAbove;
  const layout = windowRange(heights, virtual ? scrollTop : 0, virtual ? bodyH : Number.MAX_SAFE_INTEGER, 8);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight || maxHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxHeight]);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      setMeasured((prev) => {
        let next: Map<string, number> | null = null;
        for (const e of entries) {
          const sid = (e.target as HTMLElement).dataset.span!;
          const h = Math.round((e.target as HTMLElement).offsetHeight);
          if (prev.get(sid) !== h) (next ??= new Map(prev)).set(sid, h);
        }
        return next ?? prev;
      });
    });
    return () => observer.current?.disconnect();
  }, []);

  const toggleOpen = (sid: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(sid)) n.delete(sid);
      else n.add(sid);
      return n;
    });
  const setSubtree = (sid: string, collapse: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (collapse) n.add(sid);
      else n.delete(sid);
      return n;
    });

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = shown[activeIndex];
    if (!r) return;
    const step = stepRow(shown.length, activeIndex, e.key);
    if (step !== null) {
      e.preventDefault();
      return focusRow(step);
    }
    const hasKids = r.children.length > 0;
    const isCollapsed = collapsed.has(r.span.id);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleOpen(r.span.id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (hasKids && !isCollapsed) setSubtree(r.span.id, true);
      else if (r.parent) {
        const pi = shown.findIndex((x) => x.span.id === r.parent);
        if (pi >= 0) focusRow(pi);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (hasKids && isCollapsed) setSubtree(r.span.id, false);
      else if (hasKids) focusRow(activeIndex + 1);
    }
  };

  /* Axis: brush to zoom, double-click to reset; a time cursor follows the pointer. */
  const axisRef = useRef<HTMLDivElement>(null);
  const [axisW, setAxisW] = useState(600);
  useLayoutEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setAxisW(el.clientWidth || 600);
      trackW.current = el.clientWidth;
      placeRef.current(false, latest.current.fixedNow ?? Date.now());
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frac = (clientX: number) => {
    const r = axisRef.current?.getBoundingClientRect();
    return r ? (clientX - r.left) / Math.max(1, r.width) : 0;
  };
  const [brush, setBrush] = useState<[number, number] | null>(null);
  // The drag's start lives in a ref: a fast drag can end before React re-renders with the new state.
  const brushStart = useRef<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const clamp01 = (f: number) => Math.min(1, Math.max(0, f));
  const onAxisDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = clamp01(frac(e.clientX));
    brushStart.current = f;
    setBrush([f, f]);
  };
  const onAxisMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = frac(e.clientX);
    setCursor(f >= 0 && f <= 1 ? f : null);
    if (brushStart.current !== null) setBrush([brushStart.current, clamp01(f)]);
  };
  const onAxisUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = brushStart.current;
    brushStart.current = null;
    setBrush(null);
    if (start === null) return;
    const next = brushView(view, start, clamp01(frac(e.clientX)));
    if (next) setZoom(next);
  };
  const viewLen = view[1] - view[0];
  const step = tickStep(viewLen, axisW);
  const tickList = ticks(view[0] - domain[0], view[1] - domain[0], step);
  const cursorTime = cursor !== null ? view[0] + cursor * viewLen - domain[0] : null;

  const total = spans.length ? Math.max(...spans.map((s) => s.endedAt ?? now)) - domain[0] : 0;

  const renderRow = (r: WaterfallRow, i: number) => {
    const s = r.span;
    const callee = actorById.get(s.to);
    const caller = actorById.get(s.from);
    const color = spanColor(colors, rootId, s.from, s.to);
    const g = barGeometry(s, view, now);
    const dur = durationOf(s, now);
    const failed = isFailed(s);
    const running = isRunning(s);
    const isOpen = open.has(s.id);
    const hasKids = r.children.length > 0;
    const isCollapsed = collapsed.has(s.id);
    const onCrit = critical.has(s.id);
    const dim = filtered.context.has(s.id) || (showCritical && !onCrit);
    const slow = !running && filtered.p90 > 0 && dur > filtered.p90 && rows.length > 2;
    const offset = s.startedAt - domain[0];
    const label = callee?.label ?? s.to;
    const status = running ? "running" : failed ? "failed" : "done";
    const detailId = `${id}-d-${s.id}`;
    const spend = callee?.type === "agent" ? callee.spend : undefined;
    const durText = running ? `${formatDuration(dur)}…` : formatDuration(dur);
    // Duration label: after the bar, else before it, else (a bar filling the view) inside its right end.
    const textPos = g.left + g.width < 0.78 ? "after" : g.left > 0.12 ? "before" : "inside";
    // A label inside the bar sits on its colour: pick an ink (and, for mid tones, a slightly darker fill) that reaches 4.5:1.
    const inside = textPos === "inside" ? readableInk(failed ? "#ef4444" : color) : null;
    const enter = entering(s.id);
    const settle = !running && justFinished(s.id);
    // Times for CSS, relative to the anchor. A running bar's end is the live clock.
    const startVar = s.startedAt - anchor;
    const endVar = running ? "var(--kn-now)" : (s.endedAt ?? now) - anchor;
    const barVars: Vars = { "--s": startVar, "--e": endVar };
    // Hooks for place(): what an element follows (its start, its end, its length) and whether it moves with the clock.
    const kn = (kind: "at" | "end" | "fill" | "edge" | "ring") => ({
      "data-kn": kind,
      "data-kn-s": startVar,
      "data-kn-e": running ? undefined : (s.endedAt ?? now) - anchor,
      "data-kn-live": running && kind !== "at" ? "" : undefined,
    });

    return (
      <div
        key={s.id}
        data-span={s.id}
        ref={(el) => {
          if (el && isOpen) observer.current?.observe(el);
        }}
        style={{ transform: `translateY(${layout.offsets[i]}px)` }}
        className={cn("absolute inset-x-0 top-0 transition-transform", GLIDE)}
      >
        <div
          ref={(el) => {
            if (el) rowEls.current.set(s.id, el);
            else rowEls.current.delete(s.id);
          }}
          role="treeitem"
          aria-level={r.depth + 1}
          aria-expanded={hasKids ? !isCollapsed : undefined}
          aria-selected={active === s.id}
          aria-describedby={isOpen ? detailId : undefined}
          aria-label={`${caller?.label ?? s.from} → ${label}${s.summary ? `: ${s.summary}` : ""}, ${status}, ${formatDuration(dur)}, starts at ${formatOffset(offset, 1)}`}
          tabIndex={i === activeIndex ? 0 : -1}
          onFocus={() => setActive(s.id)}
          onClick={() => {
            setActive(s.id);
            toggleOpen(s.id);
          }}
          className={cn(
            "group flex h-8 cursor-pointer items-center outline-none",
            enter && "transition-[opacity,translate] duration-[420ms] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] starting:-translate-y-1.5 starting:opacity-0",
            "hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] focus-visible:shadow-[inset_2px_0_0_var(--ring)]",
            isOpen && "bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
            dim && "opacity-45",
          )}
        >
          {/* Label column */}
          <div className="flex h-full w-(--label-w) flex-none items-center gap-1.5 pr-2 pl-2" style={{ paddingLeft: 8 + r.depth * INDENT }}>
            {hasKids ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={(e) => {
                  e.stopPropagation();
                  setSubtree(s.id, !isCollapsed);
                }}
                className="grid size-4 flex-none place-items-center rounded-[4px] text-muted-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] hover:text-foreground"
              >
                <Chevron open={!isCollapsed} />
              </button>
            ) : (
              <span className="size-4 flex-none" />
            )}
            <span aria-hidden className={cn("grid size-4 flex-none place-items-center [&>*]:size-full [&_svg]:size-full", !callee?.icon && callee?.type !== "tool" && "text-[10px] font-semibold")}>
              {callee ? actorIcon(callee, callee.id === rootId) : null}
            </span>
            <span className={cn("flex-none truncate font-medium", failed && "text-red-700 dark:text-red-300")} style={{ maxWidth: "45%" }}>
              {label}
            </span>
            {s.summary && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{s.summary}</span>}
            {isCollapsed && <span className="flex-none rounded-[4px] bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] px-1 text-[10.5px] text-muted-foreground tabular-nums">+{r.children.length}</span>}
          </div>

          {/* Track */}
          <div className="relative h-full flex-1 overflow-hidden border-l [border-color:color-mix(in_srgb,var(--foreground)_6%,transparent)]" style={barVars}>
            {/* The bar: a full-width layer moved to the start, its fill clipped to the length (hit testing follows the clip). */}
            <div {...kn("at")} className="pointer-events-none absolute inset-0" style={{ transform: `translateX(${X("var(--s)")})` }}>
              <Tooltip
                content={`${label}${s.summary ? ` · ${s.summary}` : ""}`}
                description={`${status === "running" ? "Running" : status === "failed" ? "Failed" : "Took"} ${formatDuration(dur)} · starts at ${formatOffset(offset, 1)}`}
                delay={60}
                align="start"
                className="size-full items-center"
              >
                <span
                  {...kn("fill")}
                  className={cn(
                    "pointer-events-auto relative block w-full",
                    textPos === "inside" ? "h-4" : "h-3",
                    "transition-[background-color,opacity] duration-500 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none",
                    failed && "!bg-red-500/90 dark:!bg-red-400/90",
                  )}
                  style={{
                    backgroundColor: failed ? undefined : (inside?.fill ?? color),
                    opacity: running ? 0.72 : 1,
                    clipPath: `inset(0 calc(100% - ${LEN("var(--s)", "var(--e)")}) 0 0 round 3px)`,
                  }}
                >
                  {running && (
                    // A soft light at the growing edge.
                    <span
                      {...kn("edge")}
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-7 bg-linear-to-r from-transparent to-white/55 motion-safe:animate-pulse motion-reduce:hidden dark:to-white/45"
                      style={{ transform: "translateX(-100%)" }}
                    />
                  )}
                </span>
              </Tooltip>
            </div>
            {/* Critical path: a ring around the bar (few rows, so its width may follow the clock). */}
            {onCrit && (
              <div {...kn("at")} aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: `translateX(${X("var(--s)")})` }}>
                <span
                  {...kn("ring")}
                  className="absolute top-1/2 -left-[3px] h-[18px] -translate-y-1/2 rounded-[5px] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--foreground)_55%,transparent)]"
                  style={{ width: `calc(${LEN("var(--s)", "var(--e)")} + 6px)` }}
                />
              </div>
            )}
            {/* Duration: anchored to the bar's end (or start), so it rides along without layout. */}
            <div {...kn(textPos === "before" ? "at" : "end")} aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: `translateX(${X(textPos === "before" ? "var(--s)" : "var(--e)")})` }}>
              <span
                key={running ? "live" : "done"}
                style={inside ? { color: inside.ink } : undefined}
                data-live-start={running ? s.startedAt : undefined}
                ref={running ? (el) => void (el && !el.textContent && (el.textContent = durText)) : undefined}
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 text-[11px] whitespace-nowrap tabular-nums",
                  textPos === "after" ? "left-0 pl-1.5" : "right-full pr-1.5",
                  textPos === "inside" ? "font-medium" : failed ? "text-red-600 dark:text-red-400" : slow ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                  settle && "transition-opacity duration-500 starting:opacity-0",
                )}
              >
                {running ? null : durText}
              </span>
            </div>
          </div>
        </div>

        {isOpen && (
          <div id={detailId} className={cn("flex flex-col gap-2.5 border-y py-2.5 pr-3 bg-[color-mix(in_srgb,var(--foreground)_2.5%,transparent)]", HAIR)} style={{ paddingLeft: 30 + r.depth * INDENT }}>
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
              {[
                ["Duration", running ? `${formatDuration(dur)} so far` : formatDuration(dur)],
                ["Starts at", formatOffset(offset, 1)],
                ["Call", `${caller?.label ?? s.from} → ${label}`],
                ...(spend !== undefined ? [["Cost", formatUsd(spend)]] : []),
                ["Status", running ? "Running" : failed ? "Failed" : "Done"],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-1.5">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className={cn("tabular-nums", k === "Status" && failed && "text-red-600 dark:text-red-400")}>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="grid gap-2.5 @[640px]:grid-cols-2">
              {s.input !== undefined && <Block label="Input" value={s.input} />}
              {s.error ? <Block label="Error" value={s.error} tone="error" /> : s.output !== undefined && <Block label="Output" value={s.output} />}
              {s.input === undefined && s.output === undefined && !s.error && <span className="text-[12px] text-muted-foreground">{running ? "Still running…" : "No input or output recorded."}</span>}
            </div>
          </div>
        )}
      </div>
    );
  };

  const titleId = `${id}-title`;
  return (
    <div ref={rootRef} role="region" aria-labelledby={titleId} className={cn(SURFACE, className)} style={initialVars}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h3 id={titleId} className="truncate text-[14px] font-semibold tracking-tight">
            {title}
          </h3>
          <span className="text-[12px] whitespace-nowrap text-muted-foreground tabular-nums">
            {spans.length} {spans.length === 1 ? "call" : "calls"}
            {errors > 0 && <span className="text-red-600 dark:text-red-400"> · {errors} failed</span>}
            {spans.length > 0 && ` · ${formatDuration(total)}${live ? "…" : ""}`}
          </span>
        </div>
        <SegmentedControl size="sm" aria-label="Filter calls" options={FILTERS} value={filter} onValueChange={(v) => setFilter(v as WaterfallFilter)} />
        <span className="w-40 flex-none">
          <Input size="sm" type="search" aria-label="Search calls" placeholder="Search" icon={<SearchGlyph />} value={query} onChange={(e) => setQuery(e.target.value)} />
        </span>
        <Button size="sm" variant={showCritical ? "primary" : "secondary"} aria-pressed={showCritical} onClick={() => setShowCritical((v) => !v)}>
          Critical path
        </Button>
        {zoom && (
          <Button size="sm" variant="ghost" onClick={() => setZoom(null)}>
            Reset zoom
          </Button>
        )}
      </div>

      {/* Axis */}
      <div className={cn("flex h-7 border-y select-none [--label-w:11rem] @[640px]:[--label-w:19rem]", HAIR)}>
        <div className="flex w-(--label-w) flex-none items-center px-3 text-[11px] text-muted-foreground">{zoom ? `Zoomed · ${formatOffset(viewLen, step)}` : "Drag the axis to zoom"}</div>
        <div
          ref={axisRef}
          role="slider"
          aria-label="Time axis: drag to zoom, double-click to reset"
          aria-valuemin={0}
          aria-valuemax={Math.round(domain[1] - domain[0])}
          aria-valuenow={Math.round(view[0] - domain[0])}
          aria-valuetext={`Showing ${formatOffset(view[0] - domain[0], step)} to ${formatOffset(view[1] - domain[0], step)}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "0") setZoom(null);
          }}
          onPointerDown={onAxisDown}
          onPointerMove={onAxisMove}
          onPointerUp={onAxisUp}
          onPointerLeave={() => !brush && setCursor(null)}
          onDoubleClick={() => setZoom(null)}
          className={cn("relative flex-1 cursor-col-resize overflow-x-clip border-l [border-color:color-mix(in_srgb,var(--foreground)_6%,transparent)]", focusRing)}
        >
          {tickList.map((t) => {
            const x = (t - (view[0] - domain[0])) / viewLen;
            const at = t + domain[0] - anchor;
            return (
              <span key={at} data-kn="at" data-kn-s={at} className="pointer-events-none absolute inset-0 overflow-visible" style={{ transform: `translateX(${X(String(at))})` }}>
                <span className={cn("absolute top-0 left-0 flex h-full items-center transition-opacity duration-300 starting:opacity-0 motion-reduce:transition-none", x > 0.95 && "-translate-x-full")}>
                  <span className={cn("absolute top-0 h-1.5 w-px bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]", x > 0.95 ? "right-0" : "left-0")} />
                  <span className={cn("text-[10.5px] text-muted-foreground tabular-nums", x > 0.95 ? "pr-1" : "pl-1")}>{formatOffset(t, step)}</span>
                </span>
              </span>
            );
          })}
          {brush && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 bg-[color-mix(in_srgb,var(--ring)_18%,transparent)] shadow-[inset_1px_0_0_var(--ring),inset_-1px_0_0_var(--ring)]"
              style={{ left: `${Math.min(...brush) * 100}%`, width: `${Math.abs(brush[1] - brush[0]) * 100}%` }}
            />
          )}
          {cursorTime !== null && !brush && (
            <span aria-hidden className="pointer-events-none absolute top-0.5 z-10 -translate-x-1/2 rounded-[4px] bg-foreground px-1 text-[10px] leading-4 font-medium text-background tabular-nums" style={{ left: `${cursor! * 100}%` }}>
              {formatOffset(cursorTime, step / 10)}
            </span>
          )}
        </div>
      </div>

      {/* Rows */}
      <div
        ref={bodyRef}
        onScroll={(e) => virtual && setScrollTop(e.currentTarget.scrollTop)}
        onPointerMove={(e) => {
          const f = frac(e.clientX);
          setCursor(f >= 0 && f <= 1 ? f : null);
        }}
        onPointerLeave={() => setCursor(null)}
        className="kn-scroll kn-scroll-fade-x relative overflow-y-auto overscroll-contain rounded-b-2xl [--label-w:11rem] @[640px]:[--label-w:19rem]"
        style={{ maxHeight }}
      >
        {shown.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">{spans.length ? "No calls match." : "No calls yet."}</div>
        ) : (
          <div role="tree" aria-label="Calls" aria-multiselectable={false} onKeyDown={onTreeKey} className="relative" style={{ height: layout.total }}>
            {/* Tick lines + time cursor over the track column */}
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-(--label-w)">
              {tickList.map((t) => {
                const at = t + domain[0] - anchor;
                return (
                  <span key={at} data-kn="at" data-kn-s={at} className="absolute inset-0" style={{ transform: `translateX(${X(String(at))})` }}>
                    <span className="absolute inset-y-0 left-0 w-px bg-[color-mix(in_srgb,var(--foreground)_4.5%,transparent)] transition-opacity duration-300 starting:opacity-0 motion-reduce:transition-none" />
                  </span>
                );
              })}
              {cursor !== null && <span className="absolute inset-y-0 z-10 w-px bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)]" style={{ left: `${cursor * 100}%` }} />}
            </div>
            {shown.slice(layout.start, layout.end).map((r, k) => renderRow(r, layout.start + k))}
          </div>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {filter !== "all" || query ? `${filtered.rows.length - filtered.context.size} matching calls` : ""}
      </span>
    </div>
  );
}

export default TraceWaterfall;
