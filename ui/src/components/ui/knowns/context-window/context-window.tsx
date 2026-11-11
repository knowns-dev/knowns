"use client";
/** @registry name="context-window" type="ui" title="Context window" description="How full a model context is and what fills it: segmented token bar or cell field, thresholds in words, per-part files you can remove, compact action, ring variant and per-turn sparkline." */

import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "../button";
import { Tooltip } from "../tooltip";
import { ContextCells } from "./context-cells";
import {
  autoCellTokens,
  contextState,
  contextTotals,
  drops,
  formatPct,
  formatTokens as defaultFormat,
  isReserve,
  resolveLimit,
  segTokens,
  segmentColors,
  stateSentence,
  thresholdsText,
  type ContextSegment,
  type ContextState,
} from "./context-utils";

export type { ContextKind, ContextPart, ContextSegment, ContextState } from "./context-utils";

export interface ContextWindowProps {
  /** What's in the window, in order: system prompt, tool definitions, history, files… and the output reserve. */
  segments: ContextSegment[];
  /** Window size in tokens. Or leave it out and pass `model` + `limits`. */
  limit?: number;
  /** Model name, looked up in `limits` when `limit` isn't given. */
  model?: string;
  /** Your own model → window size table. The component ships no vendor numbers. */
  limits?: Record<string, number>;
  /** Share (used + reserved) at which it warns; default 0.8. */
  warnAt?: number;
  /** Share at which it counts as full; default 0.95. */
  fullAt?: number;
  /** Tokens in the window after each turn, oldest first: a sparkline with the thresholds. */
  history?: number[];
  /** Shows a Compact button (quiet while ok, primary from warn on). */
  onCompact?: () => void;
  compactLabel?: string;
  /** Compacting now: the button spins and is disabled. */
  compacting?: boolean;
  /** Replaces the Compact button (your own action). */
  action?: ReactNode;
  /** "bar": the full card. "ring": a small donut for headers, breakdown in a tooltip. */
  variant?: "bar" | "ring";
  /** The card's picture: a segmented "bar" (default) or a field of "cells", each worth `cellTokens`. */
  view?: "bar" | "cells";
  /** Tokens per cell (cells view). Default: a round number giving about 240 cells. */
  cellTokens?: number;
  /** Remove one part of a segment (a file): shows an x on each part in the legend. */
  onRemove?: (segmentId: string, partId: string) => void;
  /** Shows a footer with what's left and a New chat button. */
  onNewChat?: () => void;
  newChatLabel?: string;
  /** Ring diameter in px (ring only). */
  size?: number;
  title?: ReactNode;
  formatTokens?: (n: number) => string;
  className?: string;
}

const STATE_TONE: Record<ContextState, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  full: "text-red-600 dark:text-red-400",
  over: "text-red-600 dark:text-red-400",
};
const HATCH = (c: string) => `repeating-linear-gradient(135deg, color-mix(in srgb, ${c} 55%, transparent) 0 3px, color-mix(in srgb, ${c} 18%, transparent) 3px 6px)`;

/**
 * How full a model's context window is: a segmented bar against the limit (output reserve hatched), the
 * share and token count in big type, the state in words, a legend that highlights its segment, a sparkline
 * of usage per turn and a Compact action. `variant="ring"` is the same in a small donut for headers.
 */
export function ContextWindow(props: ContextWindowProps) {
  const {
    segments,
    limit: limitProp,
    model,
    limits,
    warnAt = 0.8,
    fullAt = 0.95,
    history,
    onCompact,
    compactLabel = "Compact",
    compacting,
    action,
    variant = "bar",
    view = "bar",
    cellTokens,
    onRemove,
    onNewChat,
    newChatLabel = "New chat",
    title = "Context window",
    formatTokens: fmt = defaultFormat,
    className,
  } = props;
  const limit = resolveLimit(limitProp, model, limits);
  const totals = contextTotals(segments, limit);
  const state = limit ? contextState(totals.fill, warnAt, fullAt) : "ok";
  const colors = useMemo(() => segmentColors(segments), [segments]);
  const [hot, setHot] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const titleId = useId();

  const valueText = limit
    ? `${formatPct(totals.pct)} used, ${fmt(totals.used)} of ${fmt(limit)} tokens${totals.reserved ? `, ${fmt(totals.reserved)} reserved` : ""}. ${stateSentence(state, totals, fmt)}`
    : `${fmt(totals.used)} tokens used; window size unknown`;
  const meter = {
    role: "meter",
    "aria-valuemin": 0,
    "aria-valuemax": limit ?? undefined,
    "aria-valuenow": Math.min(totals.used, limit ?? totals.used),
    "aria-valuetext": valueText,
  } as const;

  if (variant === "ring") return <Ring {...props} limit={limit} totals={totals} state={state} colors={colors} meter={meter} fmt={fmt} />;

  // The bar spans the limit; past it, it spans what's there and marks the limit.
  const span = Math.max(limit ?? 0, totals.used + totals.reserved, 1);
  const ordered = [...segments.filter((s) => !isReserve(s)), ...segments.filter(isReserve)];
  const compactButton =
    action ??
    (onCompact && (
      <Button size="sm" variant={state === "ok" ? "secondary" : "primary"} loading={compacting} disabled={compacting} onClick={onCompact}>
        {compactLabel}
      </Button>
    ));

  return (
    <section aria-labelledby={titleId} className={cn("@container flex flex-col gap-3 rounded-2xl border bg-card p-4 text-foreground", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id={titleId} className="flex min-h-7 items-center text-[13px] font-medium text-muted-foreground">
            {/* One inline run inside the 28px header row, so the space before the model is kept. */}
            <span>
              {title}
              {model && <span className="text-muted-foreground"> · {model}</span>}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 tabular-nums">
            {limit ? (
              <>
                <span className={cn("text-[28px] font-semibold leading-none tracking-tight", state !== "ok" && STATE_TONE[state])}>{formatPct(totals.pct)}</span>
                <span className="text-[13.5px] text-muted-foreground">
                  · <span className="font-medium text-foreground">{fmt(totals.used)}</span> / {fmt(limit)} tokens
                </span>
              </>
            ) : (
              <span className="text-[28px] font-semibold leading-none tracking-tight">
                {fmt(totals.used)} <span className="text-[13.5px] font-normal text-muted-foreground">tokens · window size unknown</span>
              </span>
            )}
          </div>
        </div>
        {compactButton && <div className="flex-none">{compactButton}</div>}
      </div>

      {view === "cells" ? (
        <div {...meter} aria-labelledby={titleId}>
          <ContextCells
            segments={segments}
            span={span}
            cellTokens={cellTokens ?? autoCellTokens(span)}
            colors={colors}
            limit={limit}
            warnAt={warnAt}
            fullAt={fullAt}
            hot={hot}
            onHot={setHot}
            busy={compacting ? segments.filter((s) => s.kind === "history").map((s) => s.id) : undefined}
            fmt={fmt}
          />
        </div>
      ) : (
      <div {...meter} aria-labelledby={titleId} className="relative">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" onMouseLeave={() => setHot(null)}>
          {ordered.map((s) => {
            const c = colors.get(s.id)!;
            return (
              <div
                key={s.id}
                data-segment={s.id}
                onMouseEnter={() => setHot(s.id)}
                className="h-full transition-opacity duration-(--kn-dur) ease-(--kn-ease-out) first:rounded-l-full motion-reduce:transition-none [&+&]:border-l [&+&]:border-card"
                style={{
                  width: `${(segTokens(s) / span) * 100}%`,
                  background: isReserve(s) ? HATCH(c) : c,
                  opacity: hot && hot !== s.id ? 0.3 : 1,
                }}
              />
            );
          })}
        </div>
        {/* Thresholds (and the limit, when over it) as hairlines on the bar. */}
        {limit &&
          [
            { at: warnAt, label: "warn" },
            { at: fullAt, label: "full" },
            ...(span > limit ? [{ at: 1, label: "limit" }] : []),
          ].map((m) => (
            <span
              key={m.label}
              aria-hidden="true"
              className={cn("absolute -inset-y-1 w-px", m.label === "limit" ? "bg-red-500" : "bg-foreground/35")}
              style={{ left: `${((m.at * limit) / span) * 100}%` }}
            />
          ))}
      </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12.5px]">
        <span className={cn("font-medium", STATE_TONE[state])} aria-live="polite">
          {limit ? stateSentence(state, totals, fmt) : "Pass limit, or model with limits, to see how full it is"}
        </span>
        {limit && <span className="text-muted-foreground">{thresholdsText(warnAt, fullAt)}</span>}
      </div>

      <ul className="grid grid-cols-1 items-start gap-x-4 gap-y-0.5 @lg:grid-cols-2" onMouseLeave={() => setHot(null)}>
        {ordered.map((s) => {
          const c = colors.get(s.id)!;
          const tokens = segTokens(s);
          const share = limit ? tokens / limit : totals.used ? tokens / totals.used : 0;
          const parts = s.parts ?? [];
          const isOpen = !!open[s.id];
          const row = (
            <>
              <span aria-hidden="true" className="size-2.5 flex-none rounded-[3px]" style={{ background: isReserve(s) ? HATCH(c) : c }} />
              <span className="min-w-0 flex-1 truncate">
                {s.label}
                {parts.length > 0 && <span className="text-muted-foreground"> · {parts.length}</span>}
              </span>
              <span className="tabular-nums text-muted-foreground">{fmt(tokens)}</span>
              <span className="w-9 text-right tabular-nums text-muted-foreground">{formatPct(share)}</span>
            </>
          );
          const rowClass = cn(
            "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring/70",
            hot && hot !== s.id && "opacity-45",
            hot === s.id && "bg-muted/60",
          );
          const label = `${s.label}: ${fmt(tokens)} tokens, ${formatPct(share)}${isReserve(s) ? ", reserved" : ""}`;
          if (!parts.length)
            return (
              <li key={s.id} tabIndex={0} onMouseEnter={() => setHot(s.id)} onFocus={() => setHot(s.id)} onBlur={() => setHot(null)} aria-label={label} className={rowClass}>
                {row}
              </li>
            );
          return (
            <li key={s.id} className={cn("flex flex-col", isOpen && "@lg:col-span-2")}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-label={`${label}, ${parts.length} ${parts.length === 1 ? "item" : "items"}`}
                onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                onMouseEnter={() => setHot(s.id)}
                onFocus={() => setHot(s.id)}
                onBlur={() => setHot(null)}
                className={cn(rowClass, "cursor-pointer hover:bg-muted/60")}
              >
                {row}
                <svg aria-hidden="true" viewBox="0 0 16 16" className={cn("-mr-0.5 size-3.5 flex-none text-muted-foreground transition-transform", isOpen && "rotate-90")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m6 4 4 4-4 4" />
                </svg>
              </button>
              {isOpen && (
                <ul className="mt-0.5 mb-1 ml-[11px] flex flex-col border-l pl-3">
                  {parts.map((p) => (
                    <li key={p.id} className="group flex min-h-7 items-center gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate" title={p.detail}>
                        {p.label}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{fmt(p.tokens)}</span>
                      {onRemove && (
                        <button
                          type="button"
                          aria-label={`Remove ${p.label}`}
                          onClick={() => onRemove(s.id, p.id)}
                          className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
                        >
                          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                            <path d="m4.5 4.5 7 7m0-7-7 7" />
                          </svg>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {history && history.length > 1 && <Sparkline history={history} limit={limit} warnAt={warnAt} fullAt={fullAt} fmt={fmt} />}

      {onNewChat && (
        <div className="flex items-center justify-end gap-3 border-t pt-3 text-[12.5px]">
          <Button size="sm" variant={state === "full" || state === "over" ? "primary" : "secondary"} onClick={onNewChat}>
            {newChatLabel}
          </Button>
        </div>
      )}
    </section>
  );
}

/* ── Sparkline: tokens in the window after each turn, with the thresholds ── */

function Sparkline({ history, limit, warnAt, fullAt, fmt }: { history: number[]; limit: number | null; warnAt: number; fullAt: number; fmt: (n: number) => string }) {
  const W = 300;
  const H = 44;
  const top = Math.max(limit ?? 0, ...history) * 1.04;
  const x = (i: number) => (i / (history.length - 1)) * W;
  const y = (v: number) => H - (v / top) * H;
  const line = history.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const cut = drops(history);
  const last = history[history.length - 1];
  const [hover, setHover] = useState<number | null>(null);
  const fillId = useId();
  return (
    // mt-auto: when the card is taller than its content (a grid row), the usage line sits at the bottom.
    <figure className="mt-auto flex flex-col gap-1">
      <figcaption className="flex items-baseline justify-between text-[12px] text-muted-foreground">
        <span>Per turn · {history.length} turns{cut.length ? ` · ${cut.length} ${cut.length === 1 ? "compaction" : "compactions"}` : ""}</span>
        <span className="tabular-nums">{hover !== null ? `Turn ${hover + 1}: ${fmt(history[hover])}` : `Now ${fmt(last)}`}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Tokens per turn over ${history.length} turns, from ${fmt(history[0])} to ${fmt(last)}${cut.length ? `, dropping ${cut.length} ${cut.length === 1 ? "time" : "times"}` : ""}`}
        className="h-11 w-full overflow-visible text-indigo-500"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(history.length - 1, Math.round(((e.clientX - r.left) / r.width) * (history.length - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {limit &&
          [warnAt, fullAt].map((t) => (
            <line key={t} x1={0} x2={W} y1={y(t * limit)} y2={y(t * limit)} className="text-foreground/25" stroke="currentColor" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ))}
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${fillId})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {cut.map((i) => (
          <line key={i} x1={x(i)} x2={x(i)} y1={y(history[i - 1])} y2={y(history[i])} className="text-emerald-600 dark:text-emerald-400" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="text-foreground/30" stroke="currentColor" vectorEffect="non-scaling-stroke" />}
      </svg>
    </figure>
  );
}

/* ── Ring: a small donut for headers; the breakdown lives in its tooltip ── */

function Ring({
  segments,
  size = 32,
  title = "Context window",
  limit,
  totals,
  state,
  colors,
  meter,
  fmt,
  warnAt = 0.8,
  fullAt = 0.95,
  className,
}: Omit<ContextWindowProps, "limit"> & {
  limit: number | null;
  totals: ReturnType<typeof contextTotals>;
  state: ContextState;
  colors: Map<string, string>;
  meter: Record<string, unknown>;
  fmt: (n: number) => string;
}) {
  const stroke = Math.max(3, size / 9);
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const span = Math.max(limit ?? 0, totals.used + totals.reserved, 1);
  let at = 0;
  const arcs = [...segments.filter((s) => !isReserve(s)), ...segments.filter(isReserve)].map((s) => {
    const len = (segTokens(s) / span) * C;
    const arc = { s, len, offset: at };
    at += len;
    return arc;
  });
  const center = limit ? formatPct(totals.pct).replace("%", "") : fmt(totals.used);
  return (
    <Tooltip
      content={limit ? `${title}: ${formatPct(totals.pct)} · ${fmt(totals.used)} / ${fmt(limit)}` : `${title}: ${fmt(totals.used)} tokens`}
      description={
        <span className="flex flex-col gap-0.5">
          {segments.map((s) => (
            <span key={s.id} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: colors.get(s.id) }} />
              {s.label}: {fmt(segTokens(s))}
              {isReserve(s) ? " (reserved)" : ""}
            </span>
          ))}
          {limit && <span className={cn("mt-0.5", STATE_TONE[state])}>{stateSentence(state, totals, fmt)}</span>}
          {limit && <span className="opacity-70">{thresholdsText(warnAt, fullAt)}</span>}
        </span>
      }
    >
      <span {...meter} aria-label={typeof title === "string" ? title : "Context window"} tabIndex={0} className={cn("relative inline-grid flex-none place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/70", className)} style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-muted" />
          {arcs.map(({ s, len, offset }) => (
            <circle
              key={s.id}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={colors.get(s.id)}
              strokeOpacity={isReserve(s) ? 0.45 : 1}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, len - 0.6)} ${C}`}
              strokeDashoffset={-offset}
              className="transition-[stroke-dasharray,stroke-dashoffset] duration-500 motion-reduce:transition-none"
            />
          ))}
        </svg>
        {size >= 28 && (
          <span aria-hidden="true" className={cn("absolute text-[10px] font-semibold tabular-nums", state === "ok" ? "text-foreground" : STATE_TONE[state])} style={{ fontSize: Math.max(9, size * 0.3) }}>
            {center}
          </span>
        )}
        {state !== "ok" && <span aria-hidden="true" className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-card", state === "warn" ? "bg-amber-500" : "bg-red-500")} />}
      </span>
    </Tooltip>
  );
}
