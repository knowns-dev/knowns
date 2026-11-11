"use client";
/** @registry name="prose-diff" type="ui" title="Prose diff" description="AI edits to text shown inline, removed words struck and new words underlined: accept or reject each suggestion from a popover or with Y and N, move between them, accept or reject all, undo, and a status line." */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "../button";
import { Kbd } from "../kbd";
import { useFloating } from "../use-floating";
import { applyDecisions, describeEdit, editsOf, nextPending, proseParts, type ProseDecision } from "./prose-diff-utils";

export type { ProseDecision, ProsePart } from "./prose-diff-utils";

export interface ProseDiffProps {
  /** The text before the AI edit. */
  before: string;
  /** The text the AI suggests. */
  after: string;
  /** Called with the resulting text (undecided suggestions keep the old words) after every decision. */
  onChange?: (text: string, decisions: Record<string, ProseDecision>) => void;
  /** Called once every suggestion has a decision. */
  onDone?: (text: string) => void;
  /** Show the toolbar with counts, Previous / Next, Accept all, Reject all and Undo. Default true. */
  toolbar?: boolean;
  className?: string;
}

type Step = { ids: string[]; decision: ProseDecision };

/** The Accept / Reject popover under one suggestion (below, so it never covers the toolbar). Keyed by suggestion, so it measures its own anchor. */
function SuggestionPopover({ anchor, onAccept, onReject, onEnter, onLeave }: { anchor: HTMLElement; onAccept: () => void; onReject: () => void; onEnter: () => void; onLeave: () => void }) {
  const { triggerRef, floatingRef, style, placement, portalHost } = useFloating<HTMLElement, HTMLDivElement>({ open: true, side: "bottom", align: "start", offset: 8 });
  triggerRef.current = anchor;
  if (!portalHost) return null;
  return createPortal(
    <div
      ref={floatingRef}
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      role="group"
      aria-label="Decide this suggestion"
      data-side={placement}
      className={cn(
        "relative z-[80] flex items-center gap-1 rounded-[8px] bg-popover p-1 text-popover-foreground",
        "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_14%,transparent),0_10px_28px_-10px_rgb(0_0_0/0.45),0_2px_6px_-2px_rgb(0_0_0/0.2)]",
        "motion-safe:transition-[opacity,translate] motion-safe:duration-150 starting:opacity-0 data-[side=bottom]:starting:-translate-y-0.5 data-[side=top]:starting:translate-y-0.5",
      )}
    >
      {/* A small arrow pointing at the suggestion, on whichever side it opened. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-4 size-2 rotate-45 bg-popover",
          placement === "top" ? "-bottom-1 shadow-[1px_1px_0_color-mix(in_srgb,var(--foreground)_14%,transparent)]" : "-top-1 shadow-[-1px_-1px_0_color-mix(in_srgb,var(--foreground)_14%,transparent)]",
        )}
      />
      <Button size="xs" variant="ghost" tabIndex={-1} onClick={onAccept} className="gap-1.5">
        Accept <Kbd size="sm">Y</Kbd>
      </Button>
      <Button size="xs" variant="ghost" tabIndex={-1} onClick={onReject} className="gap-1.5">
        Reject <Kbd size="sm">N</Kbd>
      </Button>
    </div>,
    portalHost,
  );
}

/**
 * An AI edit to text, shown inline: removed words struck through, new words underlined. Accept or reject
 * each suggestion from a small popover or with Y and N, move between them with the arrow keys, accept or
 * reject everything at once, and undo. A status line says what just happened.
 */
export function ProseDiff({ before, after, onChange, onDone, toolbar = true, className }: ProseDiffProps) {
  const parts = useMemo(() => proseParts(before, after), [before, after]);
  const edits = useMemo(() => editsOf(parts), [parts]);
  const ids = useMemo(() => edits.map((e) => e.id), [edits]);
  const [decisions, setDecisions] = useState<Record<string, ProseDecision>>({});
  const [history, setHistory] = useState<Step[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const refs = useRef(new Map<string, HTMLElement>());
  const left = ids.filter((id) => !decisions[id]).length;
  const shown = hovered ?? active;
  const shownEdit = shown && !decisions[shown] ? edits.find((e) => e.id === shown) : undefined;

  // Start with nothing decided whenever the texts change.
  useEffect(() => {
    setDecisions({});
    setHistory([]);
    setStatus("");
  }, [before, after]);

  const commit = (next: Record<string, ProseDecision>, step: Step | null, message: string) => {
    setDecisions(next);
    if (step) setHistory((h) => [...h, step]);
    setStatus(message);
    const text = applyDecisions(parts, next);
    onChange?.(text, next);
    if (ids.every((id) => next[id])) onDone?.(text);
  };

  const decide = (id: string, decision: ProseDecision) => {
    const e = edits.find((x) => x.id === id);
    if (!e || decisions[id]) return;
    commit({ ...decisions, [id]: decision }, { ids: [id], decision }, `${decision === "accepted" ? "Accepted" : "Rejected"}: ${describeEdit(e)}`);
    // Move to the next open suggestion.
    const j = nextPending(ids, { ...decisions, [id]: decision }, ids.indexOf(id));
    const nextId = j === -1 ? null : ids[j];
    setActive(nextId);
    if (nextId) requestAnimationFrame(() => refs.current.get(nextId)?.focus());
  };
  const decideAll = (decision: ProseDecision) => {
    const open = ids.filter((id) => !decisions[id]);
    if (!open.length) return;
    commit({ ...decisions, ...Object.fromEntries(open.map((id) => [id, decision])) }, { ids: open, decision }, `${decision === "accepted" ? "Accepted" : "Rejected"} ${open.length} ${open.length === 1 ? "suggestion" : "suggestions"}`);
  };
  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    const next = { ...decisions };
    for (const id of last.ids) delete next[id];
    setHistory((h) => h.slice(0, -1));
    commit(next, null, `Undid: ${last.ids.length === 1 ? describeEdit(edits.find((e) => e.id === last.ids[0])!) : `${last.ids.length} suggestions`}`);
    if (last.ids.length === 1) {
      setActive(last.ids[0]);
      requestAnimationFrame(() => refs.current.get(last.ids[0])?.focus());
    }
  };
  const move = (dir: 1 | -1) => {
    const from = active ? ids.indexOf(active) : dir === 1 ? -1 : ids.length;
    const j = nextPending(ids, decisions, from, dir);
    if (j === -1) return;
    setActive(ids[j]);
    refs.current.get(ids[j])?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    const k = e.key.toLowerCase();
    if (k === "y" || k === "enter") decide(id, "accepted");
    else if (k === "n") decide(id, "rejected");
    else if (k === "arrowright" || k === "arrowdown" || k === "j") move(1);
    else if (k === "arrowleft" || k === "arrowup" || k === "k") move(-1);
    else if ((e.metaKey || e.ctrlKey) && k === "z") undo();
    else return;
    e.preventDefault();
  };

  const firstOpen = ids.find((id) => !decisions[id]);
  const n = edits.length;

  return (
    <div className={cn("w-full", className)}>
      {toolbar && (
        <div className="mb-10 flex flex-wrap items-center gap-2">
          <span className="mr-auto text-[13px] text-muted-foreground tabular-nums">{left ? `${left} of ${n} ${n === 1 ? "suggestion" : "suggestions"} left` : "All suggestions decided"}</span>
          <Button size="sm" variant="ghost" onClick={() => move(-1)} disabled={!left} aria-label="Previous suggestion">
            ←
          </Button>
          <Button size="sm" variant="ghost" onClick={() => move(1)} disabled={!left} aria-label="Next suggestion">
            →
          </Button>
          <Button size="sm" variant="ghost" onClick={undo} disabled={!history.length}>
            Undo
          </Button>
          <Button size="sm" variant="secondary" onClick={() => decideAll("rejected")} disabled={!left}>
            Reject all
          </Button>
          <Button size="sm" onClick={() => decideAll("accepted")} disabled={!left}>
            Accept all
          </Button>
        </div>
      )}

      <div className="text-[15px] leading-[1.9] text-foreground/90 whitespace-pre-wrap" onPointerLeave={() => setHovered(null)}>
        {parts.map((p) => {
          if (p.kind === "same") return <span key={`t${parts.indexOf(p)}`}>{p.text}</span>;
          const d = decisions[p.id];
          if (d) return <span key={p.id}>{d === "accepted" ? p.new : p.old}</span>;
          const i = ids.indexOf(p.id);
          return (
            <span
              key={p.id}
              ref={(el) => {
                if (el) refs.current.set(p.id, el);
                else refs.current.delete(p.id);
              }}
              role="button"
              tabIndex={(active ?? firstOpen) === p.id ? 0 : -1}
              aria-label={`Suggestion ${i + 1} of ${n}: ${describeEdit(p)}. Y to accept, N to reject.`}
              data-active={shown === p.id || undefined}
              onFocus={() => setActive(p.id)}
              onPointerEnter={() => setHovered(p.id)}
              onKeyDown={(e) => onKey(e, p.id)}
              className="rounded-[4px] outline-none [box-decoration-break:clone] data-[active]:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] focus-visible:shadow-[0_0_0_2px_var(--ring)]"
            >
              {p.old && <del className="text-red-700 decoration-red-500/70 dark:text-red-300">{p.old}</del>}
              {p.new && <ins className="text-emerald-800 no-underline shadow-[inset_0_-2px_0_rgb(16_185_129/0.55)] dark:text-emerald-300">{p.new}</ins>}
            </span>
          );
        })}
      </div>

      <p className="mt-3 min-h-5 text-[13px] text-muted-foreground" aria-live="polite">
        {status}
      </p>

      {shownEdit && refs.current.get(shownEdit.id) && (
        <SuggestionPopover
          key={shownEdit.id}
          anchor={refs.current.get(shownEdit.id)!}
          onAccept={() => decide(shownEdit.id, "accepted")}
          onReject={() => decide(shownEdit.id, "rejected")}
          onEnter={() => setHovered(shownEdit.id)}
          onLeave={() => setHovered(null)}
        />
      )}
    </div>
  );
}

export default ProseDiff;
