"use client";
/** @registry name="kanban-board" type="ui" title="Kanban board" description="Task board with WIP limits, drag and drop with touch and keyboard, swimlanes per assignee and quick add." */

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/knowns/utils";
import { modelIcon } from "@/ui/lib/knowns/icons/model-icons";
import { Avatar } from "../avatar";
import { Badge } from "../badge";
import { Button } from "../button";
import { fieldClass } from "../input";
import { Progress } from "../progress";
import { SegmentedControl } from "../segmented-control";
import { fadeEdges, fadeMask } from "../tabs";
import { Tooltip } from "../tooltip";
import type { KanbanBoardProps, KanbanCard, KanbanColumn, KanbanPerson } from "./types";
import {
  ALL,
  UNASSIGNED,
  cellKey,
  columnIndex,
  edgeSpeed,
  groupCards,
  keyboardMove,
  laneName,
  laneOf,
  moveCard,
  positionText,
  slotIndex,
  wip,
  type CellTarget,
  type GroupBy,
} from "./board-utils";

export type { KanbanBoardProps, KanbanCard, KanbanColumn, KanbanMove, KanbanPerson } from "./types";

const EASE = "cubic-bezier(.22,1,.36,1)";
/** Columns share the width, but never get narrower than this; past that the board scrolls (with faded edges). */
const COL_MIN = 248;
const COL_GAP = 12;
const GAP = 8; // gap between cards in a cell (gap-2)
const TOUCH_DELAY = 200;

const TONE_DOT: Record<NonNullable<KanbanColumn["tone"]>, string> = {
  neutral: "bg-muted-foreground/60",
  accent: "bg-indigo-500",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/* ── Glyphs ── */

const S = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const CalendarGlyph = () => (
  <svg {...S}>
    <rect x="2.5" y="3.25" width="11" height="10" rx="2" />
    <path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5" />
  </svg>
);
const ChecklistGlyph = () => (
  <svg {...S}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
    <path d="m5.5 8.25 1.75 1.75 3.25-3.5" />
  </svg>
);
const LockGlyph = () => (
  <svg {...S}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.75" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);
const PlusGlyph = () => (
  <svg {...S}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

/* ── Default card ── */

export interface KanbanCardViewProps {
  card: KanbanCard;
  person?: KanbanPerson;
  /** Lifted look (the copy following the pointer, or the card being moved by keyboard). */
  dragging?: boolean;
  className?: string;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** The default card: key and labels, title, optional progress and footer, then due / checklist / points / assignee. */
export function KanbanCardView({ card, person, dragging = false, className }: KanbanCardViewProps) {
  const { state } = card;
  const done = card.checklist && card.checklist.total > 0 && card.checklist.done >= card.checklist.total;
  const hasMeta = card.due || card.points !== undefined || card.checklist || person;
  const showBar = typeof card.progress === "number" || (state === "busy" && card.progress === undefined);
  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 rounded-xl bg-card p-3 text-left",
        "dark:bg-[color-mix(in_srgb,var(--muted)_42%,var(--card))]",
        "transition-[box-shadow] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]",
        // One state, one signal: the badge says it. No coloured halo or outline as well.
        "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_1px_2px_rgb(0_0_0/0.05)]",
        dragging && "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_16%,transparent),0_18px_40px_-14px_rgb(0_0_0/0.35),0_4px_10px_-4px_rgb(0_0_0/0.12)]",
        className,
      )}
    >
      {state === "busy" && (
        // Breathes like a running agent; on its own layer so the hairline stays put.
        <span
          aria-hidden
          style={{ ["--hue" as string]: "rgb(99 102 241)" }}
          className="pointer-events-none absolute inset-0 rounded-[inherit] animate-[kn-breathe_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
        />
      )}

      {(card.key || card.labels?.length || card.locked || state === "blocked" || state === "failed" || state === "busy") && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {card.key && <span className="font-mono text-[11px] tracking-[0.01em] text-muted-foreground">{card.key}</span>}
          {card.locked && (
            <span className="grid text-muted-foreground [&_svg]:size-3" title="Moved by an agent">
              <LockGlyph />
            </span>
          )}
          {card.labels?.map((l) => (
            <Badge key={l.text} tone={l.tone ?? "neutral"} className="h-5 px-1.5 text-[11px]">
              {l.text}
            </Badge>
          ))}
          {state === "blocked" && (
            <Badge tone="warning" className="ml-auto h-5 text-[11px]">
              Needs you
            </Badge>
          )}
          {state === "failed" && (
            <Badge tone="danger" className="ml-auto h-5 text-[11px]">
              Failed
            </Badge>
          )}
          {state === "busy" && (
            <Badge tone="accent" className="ml-auto h-5 text-[11px]">
              Working
            </Badge>
          )}
        </div>
      )}

      <div className="line-clamp-3 text-[13.5px] leading-snug font-medium text-foreground">{card.title}</div>

      {showBar && (
        <Progress
          aria-label={`${card.title}: progress`}
          value={typeof card.progress === "number" ? card.progress * 100 : undefined}
          indeterminate={typeof card.progress !== "number"}
          tone={state === "failed" ? "danger" : "info"}
          size="sm"
          valueLabel="none"
        />
      )}

      {card.footer && (
        // Controls in the footer never start a drag, open the card or move it.
        <div data-kb-nodrag onPointerDown={stop} onKeyDown={stop} onClick={stop}>
          {card.footer}
        </div>
      )}

      {hasMeta && (
        <div className="flex min-w-0 items-center gap-3 text-[11.5px] text-muted-foreground tabular-nums [&_svg]:size-3.5">
          {card.due && (
            <span className="flex items-center gap-1">
              <CalendarGlyph />
              {card.due}
            </span>
          )}
          {card.checklist && (
            <span className={cn("flex items-center gap-1", done && "text-emerald-700 dark:text-emerald-400")} aria-label={`Checklist ${card.checklist.done} of ${card.checklist.total}`}>
              <ChecklistGlyph />
              {card.checklist.done}/{card.checklist.total}
            </span>
          )}
          {card.points !== undefined && (
            <span
              aria-label={`${card.points} ${card.points === 1 ? "point" : "points"}`}
              className="grid h-4.5 min-w-4.5 place-items-center rounded-full bg-muted px-1 text-[10.5px] font-medium text-muted-foreground"
            >
              {card.points}
            </span>
          )}
          {person && (
            <span className="ml-auto">
              <PersonAvatar person={person} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** First letter only for one-word names ("You" → "Y"); Avatar's two-letter initials otherwise. */
export function personMark(name: string): string | undefined {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length === 1 ? [...words[0]][0]?.toUpperCase() : undefined;
}

function PersonAvatar({ person, size = "sm" }: { person: KanbanPerson; size?: "xs" | "sm" }) {
  const agent = person.kind === "agent";
  const mark = !agent && !person.icon ? personMark(person.name) : undefined;
  return (
    <Avatar
      label={person.name}
      size={size}
      shape={agent ? "square" : "circle"}
      icon={
        person.icon ??
        (agent ? (modelIcon(person.model ?? person.name) ?? undefined) : mark ? <span className="grid place-items-center leading-none font-semibold">{mark}</span> : undefined)
      }
    />
  );
}

/* ── Board pieces ── */

interface Drag {
  mode: "pointer" | "keyboard";
  id: string;
  origin: CellTarget;
  /** Where it would land; null over a locked column. */
  over: CellTarget | null;
  width: number;
  height: number;
}

type RenderCard = KanbanBoardProps["renderCard"];

/** A press that may become a drag (after a few pixels, or a held touch). */
interface Pending {
  id: string;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  el: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
}

interface CellHandlers {
  pointerDown: (e: ReactPointerEvent<HTMLElement>, card: KanbanCard) => void;
  click: (card: KanbanCard) => void;
  contextMenu: (e: SyntheticEvent) => void;
  add: (column: string, title: string) => void;
}

function renderWith(renderCard: RenderCard, card: KanbanCard, person: KanbanPerson | undefined, dragging: boolean) {
  return renderCard ? renderCard(card, { dragging, person }) : <KanbanCardView card={card} person={person} dragging={dragging} />;
}

interface CellProps {
  column: KanbanColumn;
  lane: string;
  laneLabel?: string;
  cards: KanbanCard[];
  /** The card being moved, when it started in this cell (it's taken out of the flow). */
  hiddenId: string | null;
  /** Insertion slot, when this cell is the target. */
  slot: number | null;
  slotHeight: number;
  /** Keyboard moves show the card itself in the slot. */
  slotCard: KanbanCard | null;
  over: boolean;
  dimmed: boolean;
  addable: boolean;
  reduced: boolean;
  hintId: string;
  people: Map<string, KanbanPerson>;
  renderCard: RenderCard;
  h: CellHandlers;
}

/** One column × lane. Memoised: during a drag only the source and target cells re-render. */
const Cell = memo(function Cell({
  column,
  lane,
  laneLabel,
  cards,
  hiddenId,
  slot,
  slotHeight,
  slotCard,
  over,
  dimmed,
  addable,
  reduced,
  hintId,
  people,
  renderCard,
  h,
}: CellProps) {
  const list = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());

  /* FLIP: neighbours glide to their new place (layout positions, so scrolling doesn't count as movement). */
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const next = new Map<string, number>();
    for (const item of el.querySelectorAll<HTMLElement>(":scope > [data-kb-flip]")) {
      if (item.offsetParent === null) continue;
      const k = item.dataset.kbFlip!;
      const top = item.offsetTop;
      next.set(k, top);
      const before = tops.current.get(k);
      if (!reduced && before !== undefined && before !== top) {
        item.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], { duration: 220, easing: EASE });
      }
    }
    tops.current = next;
  });

  const visible = hiddenId ? cards.filter((c) => c.id !== hiddenId) : cards;
  const items: ReactNode[] = visible.map((card) => {
    const person = card.assignee ? people.get(card.assignee) : undefined;
    const label = [card.key, card.title, card.state === "blocked" ? "needs you" : card.state === "failed" ? "failed" : card.state === "busy" ? "working" : "", card.locked ? "locked" : ""]
      .filter(Boolean)
      .join(", ");
    return (
      // A group, not a button: cards can hold their own controls (footer buttons), and a button may not
      // contain focusable children. Keyboard focus goes to the stretched button underneath the content; the
      // pointer goes to the content, handled on the group.
      <div
        key={card.id}
        data-kb-card={card.id}
        data-kb-flip={card.id}
        role="group"
        aria-roledescription="card"
        aria-label={card.title}
        onPointerDown={(e) => h.pointerDown(e, card)}
        onClick={() => h.click(card)}
        onContextMenu={h.contextMenu}
        className={cn(
          "relative rounded-xl select-none [-webkit-touch-callout:none]",
          "has-[>[data-kb-open]:focus-visible]:outline-solid has-[>[data-kb-open]:focus-visible]:outline-2 has-[>[data-kb-open]:focus-visible]:outline-offset-2 has-[>[data-kb-open]:focus-visible]:outline-ring",
          card.locked ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        )}
      >
        <button
          type="button"
          data-kb-open={card.id}
          aria-label={label}
          aria-describedby={hintId}
          className="pointer-events-none absolute inset-0 rounded-xl outline-none"
        />
        <div className="relative">{renderWith(renderCard, card, person, false)}</div>
      </div>
    );
  });
  if (slot !== null) {
    const at = Math.min(slot, items.length);
    items.splice(
      at,
      0,
      slotCard ? (
        <div key="__slot" data-kb-slot data-kb-flip="__slot" tabIndex={-1} className="rounded-xl outline-2 outline-offset-2 outline-ring">
          {renderWith(renderCard, slotCard, slotCard.assignee ? people.get(slotCard.assignee) : undefined, true)}
        </div>
      ) : (
        <div
          key="__slot"
          data-kb-slot
          data-kb-flip="__slot"
          aria-hidden
          style={{ height: slotHeight }}
          className="rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_14%,transparent)]"
        />
      ),
    );
  }

  return (
    <div
      data-kb-cell
      data-col={column.id}
      data-lane={lane}
      role="group"
      aria-label={laneLabel ? `${column.title}, ${laneLabel}` : column.title}
      className={cn(
        "flex min-h-24 flex-col rounded-xl p-2 transition-[background-color,box-shadow,opacity] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]",
        "bg-[color-mix(in_srgb,var(--muted)_55%,transparent)] dark:bg-[color-mix(in_srgb,var(--muted)_40%,transparent)]",
        slot !== null && !slotCard && "bg-[color-mix(in_srgb,var(--muted)_80%,transparent)]",
        dimmed && "opacity-50",
      )}
    >
      <div ref={list} data-kb-list className="relative flex min-h-10 flex-col gap-2">
        {items}
      </div>
      {addable && <AddCard column={column} onAdd={h.add} />}
    </div>
  );
});

function AddCard({ column, onAdd }: { column: KanbanColumn; onAdd: (column: string, title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    setText("");
    if (refocus) requestAnimationFrame(() => opener.current?.focus());
  };
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(column.id, t);
    setText("");
  };
  if (!open)
    return (
      <Button ref={opener} variant="ghost" icon={<PlusGlyph />} onClick={() => setOpen(true)} className="mt-2 w-full justify-start! px-2! font-normal">
        Add card
      </Button>
    );
  return (
    <div className="mt-2 flex flex-col gap-2 animate-[kn-rise_160ms_var(--kn-ease-out,cubic-bezier(.22,1,.36,1))_both] motion-reduce:animate-none">
      <textarea
        autoFocus
        rows={2}
        value={text}
        aria-label={`New card in ${column.title}`}
        placeholder="Card title"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close(true);
          }
        }}
        onBlur={(e) => {
          // Leaving an empty box closes it; clicking Add / Cancel is handled by them.
          if (!text.trim() && !e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) close(false);
        }}
        className={cn(fieldClass, "resize-none px-2.5 py-2 leading-snug")}
      />
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={submit} disabled={!text.trim()}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => close(true)}>
          Cancel
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">Enter to add</span>
      </div>
    </div>
  );
}

const ColumnHeader = memo(function ColumnHeader({ column, count, bare }: { column: KanbanColumn; count: number; bare?: boolean }) {
  const w = wip(count, column.limit);
  return (
    <div className={cn("sticky top-0 z-10 flex h-9 items-center gap-2 px-1.5", bare ? "bg-transparent" : "bg-card dark:bg-[color-mix(in_srgb,var(--muted)_18%,var(--card))]")}>
      {/* A dot only when the column's tone means something; neutral columns have none. */}
      {column.tone && column.tone !== "neutral" && <span aria-hidden className={cn("size-2 flex-none rounded-full", TONE_DOT[column.tone])} />}
      <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">{column.title}</h3>
      <span
        className="text-[12px] tabular-nums text-muted-foreground"
        aria-label={column.limit !== undefined ? `${count} of ${column.limit} allowed` : `${count} cards`}
      >
        {w.label}
      </span>
      {w.over && <span className="text-[11.5px] text-red-600 dark:text-red-400">Over limit</span>}
      {column.locked && (
        <Tooltip content="Agents fill this column" description="Cards can't be dropped here" className="ml-auto">
          <span tabIndex={0} role="img" aria-label="Locked: cards can't be dropped here" className="grid rounded-sm text-muted-foreground/80 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5">
            <LockGlyph />
          </span>
        </Tooltip>
      )}
    </div>
  );
});

/* ── Board ── */

/**
 * A kanban board with pointer and keyboard drag and drop, WIP limits, locked columns, swimlanes by
 * assignee and inline "Add card". Cards are controlled (`cards`) or uncontrolled (`defaultCards`).
 */
export function KanbanBoard({
  columns,
  people = [],
  cards: cardsProp,
  defaultCards = [],
  onCardsChange,
  onMove,
  groupBy: groupByProp,
  defaultGroupBy = "status",
  onGroupByChange,
  onAddCard,
  onCardOpen,
  renderCard,
  title,
  actions,
  summary,
  columnMinWidth = COL_MIN,
  surface = "panel",
  className,
  "aria-label": ariaLabel,
}: KanbanBoardProps) {
  const bare = surface === "none";
  const [ownCards, setOwnCards] = useState(defaultCards);
  const cards = cardsProp ?? ownCards;
  const [ownGroupBy, setOwnGroupBy] = useState<GroupBy>(defaultGroupBy);
  const groupBy: GroupBy = people.length ? (groupByProp ?? ownGroupBy) : "status";
  const reduced = useReducedMotion();
  const hintId = useId();

  const peopleIds = useMemo(() => new Set(people.map((p) => p.id)), [people]);
  const personById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const lanes = useMemo(() => (groupBy === "status" ? [ALL] : [...people.map((p) => p.id), UNASSIGNED]), [groupBy, people]);
  const cells = useMemo(() => groupCards(cards, groupBy, peopleIds), [cards, groupBy, peopleIds]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.column, (m.get(c.column) ?? 0) + 1);
    return m;
  }, [cards]);

  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = useCallback((d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  }, []);

  const [said, setSaid] = useState({ text: "", n: 0 });
  const say = useCallback((text: string) => setSaid((s) => ({ text, n: s.n + 1 })), []);

  const root = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const overlayInner = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const suppressClick = useRef(false);

  /* Everything the stable handlers need, refreshed every render. */
  const live = useRef({ cards, columns, lanes, cells, groupBy, peopleIds, people, onMove, onCardsChange, onCardOpen, onAddCard, controlled: cardsProp !== undefined, reduced });
  live.current = { cards, columns, lanes, cells, groupBy, peopleIds, people, onMove, onCardsChange, onCardOpen, onAddCard, controlled: cardsProp !== undefined, reduced };

  const titleOf = (id: string) => live.current.cards.find((c) => c.id === id)?.title ?? "card";
  const colTitle = (id: string) => live.current.columns.find((c) => c.id === id)?.title ?? id;
  const cellSize = (column: string, lane: string, without?: string) => {
    const list = live.current.cells.get(cellKey(column, lane)) ?? [];
    return without && list.some((c) => c.id === without) ? list.length - 1 : list.length;
  };
  const where = (t: CellTarget, id: string) =>
    positionText("", colTitle(t.column), t.index, cellSize(t.column, t.lane, id) + 1, laneName(t.lane, live.current.people)).trim();

  /** Apply a move. Returns true if the cards changed. */
  const commit = (id: string, target: CellTarget): boolean => {
    const L = live.current;
    const card = L.cards.find((c) => c.id === id);
    if (!card) return false;
    const fromLane = laneOf(card, L.groupBy, L.peopleIds);
    const fromIndex = (L.cells.get(cellKey(card.column, fromLane)) ?? []).findIndex((c) => c.id === id);
    if (target.column === card.column && target.lane === fromLane && target.index === fromIndex) return false;
    const next = moveCard(L.cards, id, target, L.groupBy, L.peopleIds);
    const move = { card: id, from: card.column, to: target.column, index: columnIndex(next, id) };
    if (L.onMove?.(move) === false) {
      say(`Move of ${card.title} was not allowed.`);
      return false;
    }
    if (!L.controlled) setOwnCards(next);
    L.onCardsChange?.(next);
    return true;
  };

  /* After a drop or cancel, put focus back on the card wherever it ended up. */
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id || drag) return;
    focusAfter.current = null;
    root.current?.querySelector<HTMLElement>(`[data-kb-open="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
  }, [cards, drag]);

  /* Keyboard moves: keep the lifted card focused and in view. */
  useLayoutEffect(() => {
    if (drag?.mode !== "keyboard") return;
    const el = root.current?.querySelector<HTMLElement>("[data-kb-slot]");
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [drag, reduced]);

  /* ── Pointer drag ── */

  const ptr = useRef({ x: 0, y: 0, offX: 0, offY: 0, lastX: 0, lastT: 0, tilt: 0 });
  const raf = useRef(0);
  const settling = useRef(false);
  const pending = useRef<Pending | null>(null);
  const cleanup = useRef<() => void>(() => {});

  const blockTouch = useCallback((e: TouchEvent) => {
    if (dragRef.current?.mode === "pointer" || settling.current) e.preventDefault();
  }, []);

  const endPointer = () => {
    cancelAnimationFrame(raf.current);
    cleanup.current();
    cleanup.current = () => {};
    window.removeEventListener("touchmove", blockTouch);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    // The click that may follow pointerup lands on whatever is under it; don't let it open a card.
    setTimeout(() => (suppressClick.current = false), 0);
  };

  const transformAt = (x: number, y: number, tilt: number) => `translate3d(${x}px, ${y}px, 0) rotate(${tilt}deg)`;

  const hitTest = () => {
    const d = dragRef.current;
    if (!d) return;
    const p = ptr.current;
    const el = document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>("[data-kb-cell]");
    if (!el || !root.current?.contains(el)) return; // between cells: keep the last target
    const column = el.dataset.col!;
    const lane = el.dataset.lane!;
    if (live.current.columns.find((c) => c.id === column)?.locked) {
      if (d.over) setDrag({ ...d, over: null });
      return;
    }
    const list = el.querySelector<HTMLElement>("[data-kb-list]")!;
    const slot = list.querySelector<HTMLElement>(":scope > [data-kb-slot]");
    const top = list.getBoundingClientRect().top;
    const shift = slot ? slot.offsetHeight + GAP : 0;
    const mids: number[] = [];
    for (const item of list.querySelectorAll<HTMLElement>(":scope > [data-kb-card]")) {
      // Positions as if the slot weren't there, so the target doesn't oscillate.
      const below = slot && item.offsetTop > slot.offsetTop ? shift : 0;
      mids.push(top + item.offsetTop - below + item.offsetHeight / 2);
    }
    const center = p.y - p.offY + d.height / 2;
    const index = slotIndex(mids, center);
    const o = d.over;
    if (!o || o.column !== column || o.lane !== lane || o.index !== index) setDrag({ ...d, over: { column, lane, index } });
  };

  const frame = (t: number) => {
    const d = dragRef.current;
    if (!d || d.mode !== "pointer" || settling.current) return;
    const p = ptr.current;
    const dt = Math.max(1, t - (p.lastT || t - 16));
    const vx = (p.x - p.lastX) / dt;
    p.lastX = p.x;
    p.lastT = t;
    const target = live.current.reduced ? 0 : Math.max(-5, Math.min(5, vx * 3.5));
    p.tilt += (target - p.tilt) * 0.16;
    if (overlay.current) overlay.current.style.transform = transformAt(p.x - p.offX, p.y - p.offY, p.tilt);

    // Edge auto-scroll: the board on both axes, then the page vertically.
    const s = scroller.current;
    if (s) {
      const r = s.getBoundingClientRect();
      const sx = edgeSpeed(p.x, r.left, r.right);
      const sy = edgeSpeed(p.y, r.top, r.bottom);
      const canY = s.scrollHeight > s.clientHeight;
      if (sx) s.scrollLeft += sx;
      if (sy && canY) s.scrollTop += sy;
      const wy = edgeSpeed(p.y, 0, window.innerHeight, 40, 14);
      if (wy && (!canY || !sy)) window.scrollBy(0, wy);
    }
    hitTest();
    raf.current = requestAnimationFrame(frame);
  };

  const cancelPointer = (announce = true) => {
    const d = dragRef.current;
    endPointer();
    setDrag(null);
    if (d && announce) say(`Move cancelled. ${titleOf(d.id)} is back in ${colTitle(d.origin.column)}.`);
  };

  const dropPointer = () => {
    const d = dragRef.current;
    if (!d) return;
    cancelAnimationFrame(raf.current);
    if (!d.over) return cancelPointer();
    const finish = () => {
      settling.current = false;
      const moved = commit(d.id, d.over!);
      endPointer();
      setDrag(null);
      focusAfter.current = d.id;
      say(moved ? `Dropped ${titleOf(d.id)}. ${where(d.over!, d.id)}.` : `Dropped ${titleOf(d.id)}. No change.`);
    };
    const slot = root.current?.querySelector<HTMLElement>("[data-kb-slot]");
    if (live.current.reduced || !slot || !overlay.current) return finish();
    // Settle into the slot, then swap the overlay for the real card.
    settling.current = true;
    const r = slot.getBoundingClientRect();
    overlay.current.style.transition = `transform 200ms ${EASE}`;
    overlay.current.style.transform = transformAt(r.left, r.top, 0);
    if (overlayInner.current) overlayInner.current.style.scale = "1";
    setTimeout(finish, 210);
  };

  const begin = (x: number, y: number) => {
    const pend = pending.current;
    pending.current = null;
    if (!pend) return;
    clearTimeout(pend.timer);
    const L = live.current;
    const card = L.cards.find((c) => c.id === pend.id);
    if (!card || !pend.el.isConnected) return;
    const lane = laneOf(card, L.groupBy, L.peopleIds);
    const index = (L.cells.get(cellKey(card.column, lane)) ?? []).findIndex((c) => c.id === card.id);
    const rect = pend.el.getBoundingClientRect();
    ptr.current = { x, y, offX: x - rect.left, offY: y - rect.top, lastX: x, lastT: 0, tilt: 0 };
    suppressClick.current = true;
    try {
      root.current?.setPointerCapture(pend.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pend.pointerId) return;
      ptr.current.x = e.clientX;
      ptr.current.y = e.clientY;
    };
    const up = (e: PointerEvent) => e.pointerId === pend.pointerId && dropPointer();
    const cancel = (e: PointerEvent) => e.pointerId === pend.pointerId && cancelPointer();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPointer();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      try {
        root.current?.releasePointerCapture(pend.pointerId);
      } catch {
        /* already released */
      }
    };

    setDrag({ mode: "pointer", id: card.id, origin: { column: card.column, lane, index }, over: { column: card.column, lane, index }, width: rect.width, height: rect.height });
    say(`Picked up ${card.title}.`);
    raf.current = requestAnimationFrame(frame);
  };

  const abortPending = () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    cleanup.current();
    cleanup.current = () => {};
    window.removeEventListener("touchmove", blockTouch);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, card: KanbanCard) => {
    if (e.button !== 0 || dragRef.current || settling.current || pending.current) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, label, [data-kb-nodrag]")) return;
    if (card.locked) return; // still focusable and openable
    const touch = e.pointerType === "touch";
    const el = e.currentTarget;
    const p: Pending = { id: card.id, pointerId: e.pointerId, touch, x: e.clientX, y: e.clientY, el };
    pending.current = p;
    let lx = e.clientX;
    let ly = e.clientY;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== p.pointerId) return;
      lx = ev.clientX;
      ly = ev.clientY;
      const dist = Math.hypot(lx - p.x, ly - p.y);
      // Touch: moving before the press settles is a scroll. Mouse / pen: a few pixels starts the drag.
      if (touch) {
        if (dist > 8) abortPending();
      } else if (dist > 4) {
        cleanup.current();
        begin(lx, ly);
      }
    };
    const up = (ev: PointerEvent) => ev.pointerId === p.pointerId && abortPending();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    if (touch) {
      window.addEventListener("touchmove", blockTouch, { passive: false });
      p.timer = setTimeout(() => {
        cleanup.current();
        begin(lx, ly);
      }, TOUCH_DELAY);
    }
  };

  /* ── Keyboard ── */

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const d = dragRef.current;
    const L = live.current;
    if (d?.mode === "pointer") return; // handled on window
    if (d?.mode === "keyboard") {
      const over = d.over ?? d.origin;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const moved = commit(d.id, over);
        focusAfter.current = d.id;
        setDrag(null);
        say(moved ? `Dropped ${titleOf(d.id)}. ${where(over, d.id)}.` : `Dropped ${titleOf(d.id)}. No change.`);
        return;
      }
      if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Escape") e.preventDefault();
        focusAfter.current = d.id;
        setDrag(null);
        say(`Move cancelled. ${titleOf(d.id)} is back in ${colTitle(d.origin.column)}.`);
        return;
      }
      const pos = { col: L.columns.findIndex((c) => c.id === over.column), lane: Math.max(0, L.lanes.indexOf(over.lane)), index: over.index };
      const next = keyboardMove(pos, e.key, e.shiftKey, L.columns, L.lanes.length, (c, l) => cellSize(L.columns[c].id, L.lanes[l], d.id));
      if (e.key.startsWith("Arrow")) e.preventDefault();
      if (!next) return;
      const t = { column: L.columns[next.col].id, lane: L.lanes[next.lane], index: next.index };
      setDrag({ ...d, over: t });
      say(`Moved to ${where(t, d.id)}`);
      return;
    }
    // Not moving: Space lifts the focused card; Enter opens it (or lifts when nothing opens cards).
    const el = e.target as HTMLElement;
    if (!el.matches("[data-kb-open]")) return;
    const card = L.cards.find((c) => c.id === el.dataset.kbOpen);
    if (!card) return;
    const open = e.key === "Enter" && !!L.onCardOpen;
    if (open) {
      e.preventDefault();
      L.onCardOpen!(card);
      return;
    }
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (card.locked) return say(`${card.title} is locked and can't be moved.`);
    const lane = laneOf(card, L.groupBy, L.peopleIds);
    const index = (L.cells.get(cellKey(card.column, lane)) ?? []).findIndex((c) => c.id === card.id);
    const origin = { column: card.column, lane, index };
    setDrag({ mode: "keyboard", id: card.id, origin, over: origin, width: el.offsetWidth, height: el.offsetHeight });
    say(`Picked up ${card.title}. ${where(origin, card.id)}. Arrow keys move it${L.lanes.length > 1 ? ", Shift with up or down changes lane" : ""}. Space drops, Escape cancels.`);
  };

  /* Stable handlers for the memoised cells. */
  const api = useRef({ onPointerDown, commit });
  api.current = { onPointerDown, commit };
  const h = useMemo<CellHandlers>(
    () => ({
      pointerDown: (e, card) => api.current.onPointerDown(e, card),
      click: (card) => {
        if (suppressClick.current || dragRef.current) return;
        live.current.onCardOpen?.(card);
      },
      contextMenu: (e) => {
        if (pending.current?.touch || dragRef.current) e.preventDefault();
      },
      add: (column, text) => {
        const L = live.current;
        if (!L.controlled) {
          const card: KanbanCard = { id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, column, title: text };
          const next = [...L.cards, card];
          setOwnCards(next);
          L.onCardsChange?.(next);
        }
        L.onAddCard?.(column, text);
        say(`Added ${text} to ${L.columns.find((c) => c.id === column)?.title ?? column}.`);
      },
    }),
    [say],
  );

  useEffect(() => () => endPointer(), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* Fade whichever edge has more board beyond it, so clipped columns read as scrollable. */
  const grid = useRef<HTMLDivElement>(null);
  const updateFade = useCallback(() => {
    const s = scroller.current;
    if (!s) return;
    const mask = fadeMask(fadeEdges(s.scrollLeft, s.clientWidth, s.scrollWidth), 36) ?? "";
    s.style.maskImage = mask;
    s.style.setProperty("-webkit-mask-image", mask);
  }, []);
  useLayoutEffect(() => {
    updateFade();
    const ro = new ResizeObserver(updateFade);
    if (scroller.current) ro.observe(scroller.current);
    if (grid.current) ro.observe(grid.current);
    return () => ro.disconnect();
  }, [updateFade, columns.length]);

  /* Switching grouping: a short opacity fade only (no remount, no filter), so nothing goes blank. */
  const firstGroup = useRef(true);
  useLayoutEffect(() => {
    if (firstGroup.current) {
      firstGroup.current = false;
      return;
    }
    updateFade();
    if (!reduced) grid.current?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: EASE });
  }, [groupBy]); // eslint-disable-line react-hooks/exhaustive-deps

  const setGroupBy = (g: GroupBy) => {
    if (groupByProp === undefined) setOwnGroupBy(g);
    onGroupByChange?.(g);
    say(g === "assignee" ? "Grouped by assignee" : "Grouped by status");
  };

  const dragCard = drag ? cards.find((c) => c.id === drag.id) : undefined;
  const label = ariaLabel ?? (typeof title === "string" ? title : "Board");
  const empty: KanbanCard[] = [];

  return (
    <section
      ref={root}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden text-foreground",
        !bare && "rounded-2xl bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_1px_2px_rgb(0_0_0/0.04)] dark:bg-[color-mix(in_srgb,var(--muted)_18%,var(--card))]",
        className,
      )}
    >
      {(title || actions || people.length > 0) && (
        <header className={cn("flex flex-wrap items-center gap-3", bare ? "px-1 pb-3" : "border-b border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-4 py-3")}>
          {title && <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{title}</h2>}
          {summary === undefined && <span className="text-[12.5px] text-muted-foreground tabular-nums">{cards.length} cards</span>}
          <div className="flex-1" />
          {summary !== undefined && <div className="min-w-0 text-[12.5px] text-muted-foreground tabular-nums">{summary}</div>}
          {people.length > 0 && (
            <SegmentedControl
              aria-label="Group by"
              size="sm"
              value={groupBy}
              onValueChange={(v) => setGroupBy(v as GroupBy)}
              options={[
                { value: "status", label: "Status" },
                { value: "assignee", label: "Assignee" },
              ]}
            />
          )}
          {actions}
        </header>
      )}

      <div ref={scroller} onScroll={updateFade} className={cn("min-h-0 flex-1 overflow-auto overscroll-contain", bare ? "pb-1" : "px-3 pb-3")}>
        <div
          ref={grid}
          className="grid w-full gap-y-2"
          style={
            {
              columnGap: COL_GAP,
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              minWidth: columns.length * columnMinWidth + (columns.length - 1) * COL_GAP,
            } as CSSProperties
          }
        >
          {columns.map((col) => (
            <ColumnHeader key={col.id} column={col} count={counts.get(col.id) ?? 0} bare={bare} />
          ))}
          {lanes.map((lane) => {
            const name = laneName(lane, people);
            const person = personById.get(lane);
            const inLane = groupBy === "assignee" ? columns.reduce((n, c) => n + (cells.get(cellKey(c.id, lane))?.length ?? 0), 0) : 0;
            return (
              <Fragment key={lane}>
                {groupBy === "assignee" && (
                  <div style={{ gridColumn: "1 / -1" }} className="pt-2">
                    <div className="sticky left-0 inline-flex items-center gap-2 px-1">
                      {person ? <PersonAvatar person={person} size="xs" /> : <Avatar label="" size="xs" shape="circle" decorative />}
                      <span className="text-[13px] font-medium">{name}</span>
                      <span className="text-[12px] text-muted-foreground tabular-nums">{inLane}</span>
                    </div>
                  </div>
                )}
                {columns.map((col) => {
                  const k = cellKey(col.id, lane);
                  const src = drag && drag.origin.column === col.id && drag.origin.lane === lane;
                  const tgt = drag?.over && drag.over.column === col.id && drag.over.lane === lane;
                  return (
                    <Cell
                      key={k}
                      column={col}
                      lane={lane}
                      laneLabel={name}
                      cards={cells.get(k) ?? empty}
                      hiddenId={src ? drag!.id : null}
                      slot={tgt ? drag!.over!.index : null}
                      slotHeight={tgt ? drag!.height : 0}
                      slotCard={tgt && drag!.mode === "keyboard" ? (dragCard ?? null) : null}
                      over={wip(counts.get(col.id) ?? 0, col.limit).over}
                      dimmed={!!drag && !!col.locked}
                      addable={!!onAddCard && groupBy === "status" && !col.locked}
                      reduced={reduced}
                      hintId={hintId}
                      people={personById}
                      renderCard={renderCard}
                      h={h}
                    />
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      </div>

      <p id={hintId} className="sr-only">
        Space picks the card up; then the arrow keys move it and Space drops it.{onCardOpen ? " Enter opens it." : ""}
      </p>
      <div aria-live="polite" aria-atomic className="sr-only">
        <span key={said.n}>{said.text}</span>
      </div>

      {drag?.mode === "pointer" &&
        dragCard &&
        createPortal(
          <div
            ref={overlay}
            aria-hidden
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              width: drag.width,
              zIndex: 70,
              pointerEvents: "none",
              willChange: "transform",
              transform: transformAt(ptr.current.x - ptr.current.offX, ptr.current.y - ptr.current.offY, ptr.current.tilt),
            }}
          >
            <div
              ref={overlayInner}
              className="origin-center scale-[1.02] cursor-grabbing transition-[scale] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:scale-100"
            >
              {renderWith(renderCard, dragCard, dragCard.assignee ? personById.get(dragCard.assignee) : undefined, true)}
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}

export default KanbanBoard;
