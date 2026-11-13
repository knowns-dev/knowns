"use client";
/** @registry name="skeleton" type="ui" title="Skeleton" description="Loading placeholder. Every skeleton on a page shares ONE light sweep, like a single light passing over the layout. Content-shaped presets (text, profile card, list, media grid) and a gate that crossfades into the real content without shifting the layout." */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";

/**
 * One sweep for the whole page. The light is a background painted `fixed` to the viewport, so every
 * skeleton shows the part of the same band that passes behind it, and each one starts on the shared
 * document clock (a negative animation delay set on mount), so blocks mounted at different moments still
 * sweep in step. A frame is one background-position change per skeleton: no JavaScript per frame.
 * The band is lighter than the block in both themes. Reduced motion: a still block. (iOS Safari ignores `fixed`: there each block sweeps on its own.)
 */
const SWEEP_MS = 2600;

const CSS = `
@keyframes knsk-sweep { from { background-position: 100% 0 } to { background-position: 0% 0 } }
.knsk {
  background-image: linear-gradient(100deg, transparent 44%, var(--knsk-band) 50%, transparent 56%);
  background-size: 300% 100%;
  background-attachment: fixed;
  background-repeat: no-repeat;
  background-position: 100% 0;
  animation: knsk-sweep ${SWEEP_MS}ms linear infinite;
}
.knsk-fade { transition: opacity 220ms ease; }
@media (prefers-reduced-motion: reduce) {
  .knsk { animation: none; background-image: none; }
  .knsk-fade { transition: none; }
}
`;

/** The page-wide style, hoisted once by React however many skeletons render. */
function SweepStyle() {
  return (
    <style href="kn-skeleton" precedence="default">
      {CSS}
    </style>
  );
}

/** Starts the sweep on the shared clock: every skeleton gets the delay that puts it in the document's phase. */
function useSharedClock<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const t = typeof document !== "undefined" ? document.timeline?.currentTime : null;
    if (ref.current && typeof t === "number") ref.current.style.animationDelay = `${-(t % SWEEP_MS)}ms`;
  }, []);
  return ref;
}

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

/** Placeholder while content loads. Size it with classes: <Skeleton className="h-4 w-32" />. */
export function Skeleton({ className, style }: SkeletonProps) {
  const ref = useSharedClock<HTMLDivElement>();
  return (
    <>
      <SweepStyle />
      <div ref={ref} aria-hidden="true" style={style} className={cn("knsk rounded-md bg-muted [--knsk-band:color-mix(in_oklab,var(--background)_96%,transparent)] dark:[--knsk-band:color-mix(in_oklab,var(--foreground)_9%,transparent)]", className)} />
    </>
  );
}

/* ── Presets: the shape of the content that is loading ── */

interface PresetProps {
  className?: string;
  /** The accessible name of the loading region. Default "Loading". */
  label?: string;
}

const region = (label: string | undefined) => ({ role: "status" as const, "aria-busy": true, "aria-label": label ?? "Loading" });

/** Lines of text; the last one is shorter. */
export function SkeletonText({ lines = 3, className, label }: PresetProps & { lines?: number }) {
  return (
    <div {...region(label)} className={cn("flex w-full flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 && lines > 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}

/** A profile card: avatar, name and handle, then a few lines of bio. */
export function SkeletonProfile({ lines = 3, className, label }: PresetProps & { lines?: number }) {
  return (
    <div {...region(label)} className={cn("flex w-full max-w-sm flex-col gap-4", className)}>
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 flex-none rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-3/5" : "w-full")} />
        ))}
      </div>
    </div>
  );
}

/** A list of rows: a leading tile, two lines and a small trailing pill. */
export function SkeletonList({ rows = 4, className, label }: PresetProps & { rows?: number }) {
  return (
    <div {...region(label)} className={cn("flex w-full flex-col", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b py-3 first:pt-0 last:border-0 last:pb-0">
          <Skeleton className="size-9 flex-none rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className={cn("h-3.5", i % 2 ? "w-1/2" : "w-2/3")} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-12 flex-none rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** A grid of media cards: a 16:9 thumbnail and a caption line under each. */
export function SkeletonMediaGrid({ items = 6, columns = 3, className, label }: PresetProps & { items?: number; columns?: 2 | 3 | 4 }) {
  const cols = columns === 2 ? "grid-cols-2" : columns === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3";
  return (
    <div {...region(label)} className={cn("grid w-full gap-4", cols, className)}>
      {Array.from({ length: items }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}

/* ── The gate: skeleton out, content in, no shift ── */

export interface SkeletonGateProps {
  /** True while loading. When it turns false the skeleton fades out as the content fades in. */
  loading: boolean;
  /** The placeholder, usually a preset sized like the content. */
  skeleton: ReactNode;
  /**
   * The content. Render it while loading too (with empty or placeholder data) so the box is already its final
   * size: it is hidden from sight and from assistive tech until `loading` is false.
   */
  children: ReactNode;
  className?: string;
}

/**
 * Stacks the skeleton and the content in one grid cell, so swapping them never moves anything: the cell is
 * as big as the bigger of the two. The skeleton leaves the layout after its 220 ms fade (instantly under
 * reduced motion).
 */
export function SkeletonGate({ loading, skeleton, children, className }: SkeletonGateProps) {
  const [mounted, setMounted] = useState(loading);
  useEffect(() => {
    if (loading) {
      setMounted(true);
      return;
    }
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setMounted(false), reduced ? 0 : 240);
    return () => clearTimeout(t);
  }, [loading]);
  return (
    <div data-slot="skeleton-gate" data-loading={loading} className={cn("grid", className)}>
      <SweepStyle />
      <div className={cn("knsk-fade [grid-area:1/1] min-w-0", loading ? "opacity-0" : "opacity-100")} aria-hidden={loading || undefined} inert={loading || undefined}>
        {children}
      </div>
      {mounted && (
        <div className={cn("knsk-fade pointer-events-none [grid-area:1/1] min-w-0", loading ? "opacity-100" : "opacity-0")}>{skeleton}</div>
      )}
    </div>
  );
}
