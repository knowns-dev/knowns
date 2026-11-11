"use client";
/** @registry name="context-treemap" type="ui" title="Context treemap" description="What fills an agent context as a living treemap: parts sized by tokens, free space and reserve, tiles that glide as sizes change, and compaction folding old turns into a summary, with a before and after view." */

/**
 * ContextTreemap: what fills an agent's context, as a map. Each part (system prompt, tools, every file,
 * every turn, tool results) is a tile sized by its tokens; free room is a dashed tile. Tiles glide when
 * sizes change, and a compaction squeezes the old turns into their summary tile. One accent for the
 * conversation, neutral tints for the rest.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "../button";
import { SegmentedControl } from "../segmented-control";
import { contextState, contextTotals, formatPct, formatTokens as defaultFormat, resolveLimit, stateSentence, type ContextSegment, type ContextState } from "../context-window/context-utils";
import { compactionTargets, fits, layoutTiles, FREE_ID, MORE_ID, type Rect, type Tile, type TileKind } from "./treemap-utils";

export type { Tile as ContextTile } from "./treemap-utils";

export interface ContextTreemapProps {
  /** What's in the window, in order. A segment's `parts` (files, turns) each get a tile inside it. */
  segments: ContextSegment[];
  /** Window size in tokens. Or pass `model` + `limits`. */
  limit?: number;
  model?: string;
  /** Your own model -> window size table. No vendor numbers are built in. */
  limits?: Record<string, number>;
  warnAt?: number;
  fullAt?: number;
  /** The window before a compaction: adds a Before / After switch that glides between the two. */
  before?: ContextSegment[];
  /** Shows a Compact button. Your handler replaces the old turns with a segment or part whose `summaryOf` lists them. */
  onCompact?: () => void;
  compactLabel?: string;
  /** Compacting now: the conversation tiles pulse and the button spins. */
  compacting?: boolean;
  /** Click (or Enter) on a tile: open that file, turn or result. Without it, tiles are focusable but inert. */
  onOpen?: (tile: Tile) => void;
  /** false: no card (border, background, padding), for a page or panel that already frames it. Default true. */
  frame?: boolean;
  /** Map height in px. Default 300; under 480px wide it grows to 1.2x the width. */
  height?: number;
  title?: ReactNode;
  freeLabel?: string;
  formatTokens?: (n: number) => string;
  className?: string;
}

const CSS_TEXT = `
@keyframes kntm-in { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
@keyframes kntm-busy { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
[data-kntm-tile] { left: 0; top: 0; transition: translate var(--kn-dur-slow) var(--kn-ease-out), opacity var(--kn-dur-fast), box-shadow var(--kn-dur-fast); }
[data-kntm-tile][data-enter="true"] { animation: kntm-in var(--kn-dur-slow) var(--kn-ease-out) both; }
[data-kntm-tile][data-enter="true"][data-kind="summary"] { animation-delay: .3s; }
[data-kntm-tile][data-busy="true"] { animation: kntm-busy 1.1s ease-in-out infinite; }
[data-kntm-ghost] { left: 0; top: 0; transition: translate var(--kn-dur-slow) var(--kn-ease-out), opacity var(--kn-dur-slow) var(--kn-ease-out); }
@media (prefers-reduced-motion: reduce) {
  [data-kntm-tile], [data-kntm-ghost] { transition: none !important; animation: none !important; }
}
`;

/** One accent (the conversation and its summary), neutral tints for everything else. */
const TINT: Record<TileKind, string> = {
  history: "bg-indigo-500/14 ring-1 ring-inset ring-indigo-500/15 dark:bg-indigo-400/16 dark:ring-indigo-400/15",
  summary: "bg-indigo-500/30 ring-1 ring-inset ring-indigo-500/40 dark:bg-indigo-400/30 dark:ring-indigo-400/40",
  system: "bg-foreground/[0.13] dark:bg-foreground/[0.18]",
  tools: "bg-foreground/[0.09] ring-1 ring-inset ring-foreground/15 dark:bg-foreground/[0.12]",
  files: "bg-foreground/[0.055] dark:bg-foreground/[0.075]",
  other: "bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10",
  output: "",
  free: "border border-dashed border-foreground/20",
};
const HATCH = "repeating-linear-gradient(135deg, color-mix(in srgb, currentColor 14%, transparent) 0 2px, transparent 2px 6px)";

const STATE_TONE: Record<ContextState, string> = {
  ok: "",
  warn: "text-amber-700 dark:text-amber-400",
  full: "text-red-600 dark:text-red-400",
  over: "text-red-600 dark:text-red-400",
};

type Ghost = { tile: Tile; to: Rect | null; go: boolean };

export function ContextTreemap({
  segments,
  limit: limitProp,
  model,
  limits,
  warnAt = 0.8,
  fullAt = 0.95,
  before,
  onCompact,
  compactLabel = "Compact",
  compacting,
  onOpen,
  frame = true,
  height = 300,
  title = "Context",
  freeLabel = "Free",
  formatTokens: fmt = defaultFormat,
  className,
}: ContextTreemapProps) {
  const [view, setView] = useState<"before" | "after">("after");
  const shown = before && view === "before" ? before : segments;
  const limit = resolveLimit(limitProp, model, limits);
  const totals = contextTotals(shown, limit);
  const state = limit ? contextState(totals.fill, warnAt, fullAt) : "ok";
  const span = Math.max(limit ?? 0, totals.used + totals.reserved, 1);

  // Width from the box; a guess for the server and the first paint.
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setW(el.clientWidth || 640);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // On a phone the map grows taller, so tiles keep room for their labels.
  const h = w < 480 ? Math.max(height, Math.round(w * 1.2)) : height;
  const tiles = useMemo(() => layoutTiles(shown, span, { w, h }, { freeLabel }), [shown, span, w, h, freeLabel]);

  // Tiles that left fly into the tile that replaced them (or fade); new tiles fade in.
  const prev = useRef<Tile[] | null>(null);
  const prevData = useRef(shown);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [entering, setEntering] = useState<Set<string>>(new Set());
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = tiles;
    // Only a change in the data animates; a new width just reflows (tiles glide, nothing flies or fades).
    const dataChanged = prevData.current !== shown;
    prevData.current = shown;
    if (!before || !dataChanged) return;
    const targets = compactionTargets(before, tiles);
    const fresh = new Set(tiles.filter((t) => t.kind !== "free" && !before.some((b) => b.key === t.key)).map((t) => t.key));
    if (!targets.size && !fresh.size) return;
    const byKey = new Map(tiles.map((t) => [t.key, t]));
    setGhosts(before.filter((t) => targets.has(t.key)).map((t) => ({ tile: t, to: byKey.get(targets.get(t.key) ?? "")?.rect ?? null, go: false })));
    setEntering(fresh);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => (raf2 = requestAnimationFrame(() => setGhosts((g) => g.map((x) => ({ ...x, go: true }))))));
    const done = setTimeout(() => {
      setGhosts([]);
      setEntering(new Set());
    }, 900);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [tiles]);

  const [hot, setHot] = useState<string | null>(null);
  const hotTile = tiles.find((t) => t.key === hot) ?? null;
  const titleId = useId();
  const delta = before ? contextTotals(before, limit).used - contextTotals(segments, limit).used : 0;

  const share = (t: number) => formatPct(t / (limit ?? Math.max(1, totals.used)));
  const describe = (t: Tile) => `${t.label}${t.partId ? `, ${t.segmentLabel}` : ""}: ${fmt(t.tokens)} tokens, ${share(t.tokens)}${t.detail ? `, ${t.detail}` : ""}`;
  // One legend entry per segment, in map order, tinted like its tiles.
  const legend = useMemo(() => {
    const m = new Map<string, { label: string; kind: TileKind; tokens: number }>();
    for (const t of tiles) {
      if (t.kind === "free") continue;
      const e = m.get(t.segmentId);
      if (e) e.tokens += t.tokens;
      else m.set(t.segmentId, { label: t.segmentLabel, kind: t.kind === "summary" ? "history" : t.kind, tokens: t.tokens });
    }
    return [...m.entries()];
  }, [tiles]);

  return (
    <section aria-labelledby={titleId} className={cn("flex flex-col gap-3 text-foreground", frame && "rounded-2xl border bg-card p-4 sm:p-5", className)}>
      <style href="kntm" precedence="default">
        {CSS_TEXT}
      </style>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 id={titleId} className="text-[13px] font-medium text-muted-foreground">
              {title}
            </h3>
            {model && <span className="rounded-full border px-2 py-px text-[11.5px] leading-[18px] text-muted-foreground">{model}</span>}
          </div>
          <div
            role="meter"
            aria-labelledby={titleId}
            aria-valuemin={0}
            aria-valuemax={limit ?? undefined}
            aria-valuenow={Math.min(totals.used, limit ?? totals.used)}
            aria-valuetext={limit ? `${formatPct(totals.pct)} used, ${fmt(totals.used)} of ${fmt(limit)} tokens. ${stateSentence(state, totals, fmt)}` : `${fmt(totals.used)} tokens used`}
            className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums"
          >
            {limit ? (
              <>
                <span className={cn("text-[26px] leading-none font-semibold tracking-tight", STATE_TONE[state])}>{formatPct(totals.pct)}</span>
                <span className="text-[13px] text-muted-foreground">
                  <span className="font-medium text-foreground">{fmt(totals.used)}</span> / {fmt(limit)} tokens
                </span>
              </>
            ) : (
              <span className="text-[26px] leading-none font-semibold tracking-tight">{fmt(totals.used)}</span>
            )}
          </div>
          {/* Only what the map can't say: a warning, or what a compaction freed. Free room is the dashed tile. */}
          {(state !== "ok" || (before && view === "after" && delta > 0)) && (
            <p className={cn("mt-1.5 text-[12.5px] font-medium", state === "ok" ? "text-muted-foreground" : STATE_TONE[state])} aria-live="polite">
              {before && view === "after" && delta > 0 ? `Compaction freed ${fmt(delta)}` : ""}
              {before && view === "after" && delta > 0 && state !== "ok" ? " · " : ""}
              {state !== "ok" && limit ? stateSentence(state, totals, fmt) : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {before && (
            <SegmentedControl
              aria-label="Before or after compaction"
              size="sm"
              value={view}
              onValueChange={(v) => setView(v as "before" | "after")}
              options={[
                { value: "before", label: "Before" },
                { value: "after", label: "After" },
              ]}
            />
          )}
          {onCompact && (
            <Button size="sm" variant={state === "ok" ? "secondary" : "primary"} loading={compacting} disabled={compacting} onClick={onCompact}>
              {compactLabel}
            </Button>
          )}
        </div>
      </header>

      <div ref={box} role="group" aria-label="What fills the context" className="relative w-full" style={{ height: h }} onMouseLeave={() => setHot(null)}>
        {tiles.map((t) => {
          const big = fits(t.rect);
          const dim = hot && hotTile && hotTile.segmentId !== t.segmentId;
          const Tag = onOpen && t.kind !== "free" ? "button" : "div";
          return (
            <Tag
              key={t.key}
              data-kntm-tile=""
              data-kind={t.kind}
              data-enter={entering.has(t.key) || undefined}
              data-busy={(compacting && t.kind === "history") || undefined}
              {...(Tag === "button" ? { type: "button" as const, onClick: () => onOpen?.(t) } : { tabIndex: t.kind === "free" ? -1 : 0, role: "img" })}
              aria-label={describe(t)}
              title={t.label}
              onMouseEnter={() => setHot(t.key)}
              onFocus={() => setHot(t.key)}
              onBlur={() => setHot(null)}
              className={cn(
                "absolute flex flex-col items-start overflow-hidden rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                TINT[t.kind],
                Tag === "button" && "cursor-pointer",
                hot === t.key && "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--foreground)_55%,transparent)]",
                dim && "opacity-45",
                t.kind === "output" && "text-foreground",
              )}
              style={{ translate: `${t.rect.x}px ${t.rect.y}px`, width: t.rect.w, height: t.rect.h, ...(t.reserve ? { backgroundImage: HATCH } : null) } as CSSProperties}
            >
              {big && (
                <>
                  <span className={cn("w-full truncate text-[12px] leading-4 font-medium", t.kind === "free" && "text-muted-foreground")}>{t.label}</span>
                  {fits(t.rect, 50, 48) && <span className="text-[11.5px] leading-4 text-muted-foreground tabular-nums">{fmt(t.tokens)}</span>}
                </>
              )}
            </Tag>
          );
        })}
        {ghosts.map((g) => {
          const r = g.go ? (g.to ?? { x: g.tile.rect.x + g.tile.rect.w / 2, y: g.tile.rect.y + g.tile.rect.h / 2, w: 0, h: 0 }) : g.tile.rect;
          return <div key={`ghost-${g.tile.key}`} aria-hidden="true" data-kntm-ghost="" className={cn("pointer-events-none absolute rounded-md", TINT[g.tile.kind])} style={{ translate: `${r.x}px ${r.y}px`, width: r.w, height: r.h, opacity: g.go ? 0 : 1 }} />;
        })}
      </div>

      {/* The legend; while a tile is hovered or focused, its details take the same row. */}
      <div className={cn("min-h-[30px] pt-2.5 text-[12px]", frame && "border-t")} aria-live="polite">
        {hotTile ? (
          <p className="truncate">
            <span className="font-medium">{hotTile.label}</span>
            <span className="text-muted-foreground">
              {hotTile.partId || hotTile.key.endsWith(MORE_ID) ? ` · ${hotTile.segmentLabel}` : ""} · <span className="tabular-nums">{fmt(hotTile.tokens)}</span> · {share(hotTile.tokens)}
              {hotTile.detail ? ` · ${hotTile.detail}` : ""}
            </span>
          </p>
        ) : (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {legend.map(([id, e]) => (
              <li key={id} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", TINT[e.kind])} style={e.kind === "output" ? { backgroundImage: HATCH, color: "var(--foreground)" } : undefined} />
                {e.label}
                <span className="tabular-nums text-foreground">{fmt(e.tokens)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export { FREE_ID };
