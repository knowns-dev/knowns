"use client";
/** @registry part-of="context-window" */

/**
 * The context window as a field of equal cells, each worth `cellTokens`. Used cells take their
 * segment's colour, the reserve is pale, free cells are grey, and free room past the thresholds
 * is outlined in amber, then red. Hover a cell (or a legend row) to light that segment; while compacting the
 * conversation's cells shimmer, and when it shrinks they clear in a sweep.
 */
import { useMemo } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { cellPlan, type ContextSegment } from "./context-utils";

const CSS_TEXT = `
@keyframes kncw-shimmer { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
[data-kncw-cell] { transition: background-color .45s ease-out, opacity .2s; }
[data-kncw-cell][data-busy="true"] { animation: kncw-shimmer 1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  [data-kncw-cell] { transition: none !important; animation: none !important; }
}
`;

export interface ContextCellsProps {
  segments: ContextSegment[];
  /** Tokens the field spans: the limit, or more when over. */
  span: number;
  cellTokens: number;
  colors: Map<string, string>;
  limit: number | null;
  warnAt: number;
  fullAt: number;
  /** The highlighted segment id. */
  hot: string | null;
  onHot: (id: string | null) => void;
  /** Segment ids whose cells shimmer (the conversation, while compacting). */
  busy?: string[];
  fmt: (n: number) => string;
}

export function ContextCells({ segments, span, cellTokens, colors, limit, warnAt, fullAt, hot, onHot, busy, fmt }: ContextCellsProps) {
  const plan = useMemo(() => cellPlan(segments, span, cellTokens), [segments, span, cellTokens]);
  const warnCell = limit ? Math.floor((warnAt * limit) / cellTokens) : Infinity;
  const fullCell = limit ? Math.floor((fullAt * limit) / cellTokens) : Infinity;
  const limitCell = limit ? Math.ceil(limit / cellTokens) : Infinity;
  return (
    <div className="flex flex-col gap-1.5">
      <style href="kncw" precedence="default">
        {CSS_TEXT}
      </style>
      <div
        aria-hidden="true"
        className="grid grid-cols-[repeat(auto-fill,minmax(9px,1fr))] gap-[3px]"
        onMouseOver={(e) => {
          const id = (e.target as HTMLElement).dataset?.seg;
          onHot(id || null);
        }}
        onMouseLeave={() => onHot(null)}
      >
        {plan.map((c, i) => {
          const color = c.id ? colors.get(c.id) : undefined;
          // Free room past the thresholds is outlined (amber, then red), so it never reads as a fill.
          const zone = c.id ? "" : i >= fullCell ? "ring-1 ring-inset ring-red-500/60" : i >= warnCell ? "ring-1 ring-inset ring-amber-500/60" : "bg-muted";
          return (
            <span
              key={i}
              data-kncw-cell=""
              data-seg={c.id ?? undefined}
              data-busy={(c.id && busy?.includes(c.id)) || undefined}
              className={cn("aspect-square rounded-[2px]", zone, i >= limitCell && "ring-1 ring-inset ring-red-500", hot && c.id !== hot && "opacity-25")}
              style={{
                background: color ? (c.reserve ? `color-mix(in srgb, ${color} 35%, transparent)` : color) : undefined,
                transitionDelay: `${(i % 48) * 7}ms`,
                animationDelay: `${(i % 24) * 45}ms`,
              }}
            />
          );
        })}
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        Each cell is {fmt(cellTokens)} tokens
      </p>
    </div>
  );
}
