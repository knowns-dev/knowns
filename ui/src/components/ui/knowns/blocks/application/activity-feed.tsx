"use client";
/** @registry name="activity-feed" type="block" title="Activity feed" description="A timeline of what people and agents did: unread dots and Mark all read, type tabs with counts, expandable rows, day groups and a live N new update pill." */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Avatar } from "@/ui/components/ui/knowns/avatar";
import { Button } from "@/ui/components/ui/knowns/button";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { fullTime, groupByDay, relativeTime } from "./app-feed-utils";
import {
  activityTypes,
  diffSummary,
  filterActivity,
  isUnread,
  newPillText,
  newerThanSeen,
  sweepDelay,
  typeCounts,
  unreadCount,
  unreadIds,
  type ActivityWho,
} from "./activity-utils";

export type { ActivityWho } from "./activity-utils";

export type ActivityDetails =
  | { kind: "diff"; files: number; added: number; removed: number; summary?: string }
  | { kind: "tool"; name: string; input?: string; output?: string }
  | { kind: "text"; text: string };

export interface ActivityItem {
  id: string;
  at: number;
  /** A short type used by the tabs and the avatar badge: "comment", "deploy", "change", "file". */
  type: string;
  actor: { name: string; agent?: boolean; src?: string };
  /** What they did: "merged", "finished a run on". */
  verb: string;
  /** What it was done to: "feat/export-csv". */
  object: string;
  /** Not read yet. Shows a dot and counts in the header. */
  unread?: boolean;
  /** Where it happened, shown muted before the snippet: "atlas-web". */
  project?: string;
  /** A line of context. One line in the row, in full when the row is open. */
  snippet?: string;
  details?: ActivityDetails;
}

/** A tab label and the badge icon for a type. */
export interface ActivityTypeMeta {
  label: string;
  icon?: ReactNode;
}

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
export const ACTIVITY_TYPE_META: Record<string, ActivityTypeMeta> = {
  comment: { label: "Comments", icon: <Glyph><path d="M5 5h14v10H10l-5 4z" /></Glyph> },
  change: { label: "Changes", icon: <Glyph><circle cx="7" cy="6" r="2" /><circle cx="17" cy="18" r="2" /><path d="M7 8v4a4 4 0 0 0 4 4h4" /></Glyph> },
  deploy: { label: "Deploys", icon: <Glyph><path d="M12 19V6m0 0-5 5m5-5 5 5" /></Glyph> },
  file: { label: "Files", icon: <Glyph><path d="M7 3h7l4 4v14H7z" /></Glyph> },
  invite: { label: "Invites", icon: <Glyph><circle cx="10" cy="8" r="3" /><path d="M4 20a6 6 0 0 1 12 0M19 8v6M16 11h6" /></Glyph> },
};
const FALLBACK_ICON = <Glyph><circle cx="12" cy="12" r="3" /></Glyph>;
const plural = (t: string) => {
  const w = t.charAt(0).toUpperCase() + t.slice(1);
  return /s$/.test(w) ? w : `${w}s`;
};

const BotMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
    <path d="M12 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <rect x="4" y="7" width="16" height="13" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="9" cy="13" r="1.6" fill="currentColor" />
    <circle cx="15" cy="13" r="1.6" fill="currentColor" />
  </svg>
);
const CheckMark = ({ double }: { double?: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {double ? <path d="m2 13 4 4L15 7m-4 10 1 1L22 7" /> : <path d="m5 12.5 4.5 4.5L19 7.5" />}
  </svg>
);

export interface ActivityFeedProps {
  items: ActivityItem[];
  /** The clock (ms). Pass it so grouping and "5m" match on server and client. Default: first render time. */
  now?: number;
  /** Time zone that cuts the days. Default "UTC". */
  timeZone?: string;
  /** Show the type tabs and the people / agents switch. Default true. */
  filters?: boolean;
  /** Controlled filters. Leave out to let the feed keep them. */
  who?: ActivityWho;
  onWhoChange?: (who: ActivityWho) => void;
  /** The selected type: empty is All, one entry is that tab. */
  types?: string[];
  onTypesChange?: (types: string[]) => void;
  /** Label and badge icon per type. Merged over the built-in comment, change, deploy, file and invite. */
  typeMeta?: Record<string, ActivityTypeMeta>;
  /** Pressed on "Open" in an expanded row. */
  onOpen?: (item: ActivityItem) => void;
  /** Called with the id of a row that was just read by opening it. */
  onMarkRead?: (ids: string[]) => void;
  /** Called with the ids that "Mark all read" cleared. */
  onMarkAllRead?: (ids: string[]) => void;
  /** Keep items that arrive behind the pill even when the list is at the top. Default: only when scrolled down. */
  holdNew?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  emptyText?: string;
  /** Accessible name and title of the feed. */
  label?: string;
  /** Level of the day headings. Default 3: set it so levels do not skip on your page. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateOfKey = (key: string) => `${MONTHS[+key.slice(5, 7) - 1]} ${+key.slice(8, 10)}`;
const SWEEP_STEP = 40;
const SWEEP_FADE = 180;

/** A timeline of events, newest first, that tracks what is unread. One scroll area; new items can wait behind a "N new updates" pill. */
export function ActivityFeed({
  items,
  now: nowProp,
  timeZone = "UTC",
  filters = true,
  who: whoProp,
  onWhoChange,
  types: typesProp,
  onTypesChange,
  typeMeta,
  onOpen,
  onMarkRead,
  onMarkAllRead,
  holdNew = false,
  onLoadMore,
  hasMore,
  loadingMore,
  emptyText = "No activity matches these filters.",
  label = "Activity",
  headingLevel = 3,
  className,
}: ActivityFeedProps) {
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  const [fallbackNow] = useState(() => Date.now());
  const now = nowProp ?? fallbackNow;
  const meta = useMemo(() => ({ ...ACTIVITY_TYPE_META, ...typeMeta }), [typeMeta]);
  const [whoOwn, setWhoOwn] = useState<ActivityWho>("all");
  const [typesOwn, setTypesOwn] = useState<string[]>([]);
  const who = whoProp ?? whoOwn;
  const types = typesProp ?? typesOwn;
  const setWho = (v: ActivityWho) => (whoProp === undefined && setWhoOwn(v), onWhoChange?.(v));
  const setTypes = (v: string[]) => (typesProp === undefined && setTypesOwn(v), onTypesChange?.(v));
  const allTypes = useMemo(() => activityTypes(items), [items]);
  const tabKeys = useMemo(() => [...Object.keys(meta).filter((t) => allTypes.includes(t)), ...allTypes.filter((t) => !(t in meta))], [meta, allTypes]);

  // Items that arrive while the reader is scrolled down (or always, with holdNew) wait behind a pill instead of shifting the page.
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (seen.current) {
      const fresh = newerThanSeen(items, seen.current);
      if (fresh.length) {
        const scrolled = (scroller.current?.scrollTop ?? 0) > 24;
        if (holdNew || scrolled) setHeld((h) => new Set([...h, ...fresh]));
        setAnnounce(newPillText(fresh.length));
      }
    }
    seen.current = new Set(items.map((i) => i.id));
  }, [items, holdNew]);
  const visible = useMemo(() => items.filter((i) => !held.has(i.id)), [items, held]);
  const waiting = useMemo(() => items.filter((i) => held.has(i.id)).sort((a, b) => b.at - a.at), [items, held]);
  const byWho = useMemo(() => filterActivity(visible, who), [visible, who]);
  const counts = useMemo(() => typeCounts(byWho, tabKeys), [byWho, tabKeys]);
  const shown = useMemo(() => filterActivity(visible, who, types), [visible, who, types]);
  const groups = useMemo(() => groupByDay(shown, now, timeZone), [shown, now, timeZone]);
  const pending = waiting.length;
  const release = () => {
    setHeld(new Set());
    scroller.current?.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // Read state: the item's own flag, plus what the reader opened or swept here.
  const tracksRead = !!onMarkAllRead || items.some((i) => i.unread !== undefined);
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());
  const [sweep, setSweep] = useState<ReadonlySet<string> | null>(null);
  const unreadN = unreadCount(visible, read);
  const markRead = (ids: string[]) => setRead((r) => new Set([...r, ...ids]));
  const markAll = (instant: boolean) => {
    const ids = unreadIds(visible, read);
    if (!ids.length) return;
    onMarkAllRead?.(ids);
    if (instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return markRead(ids);
    setSweep(new Set(ids));
    window.setTimeout(() => {
      markRead(ids);
      setSweep(null);
    }, sweepDelay(ids.length - 1, SWEEP_STEP) + SWEEP_FADE + 40);
  };
  // The first unread rows in reading order get the stagger; the rest go together.
  const sweepOrder = useMemo(() => {
    const m = new Map<string, number>();
    if (sweep) for (const g of groups) for (const i of g.items) if (sweep.has(i.id)) m.set(i.id, m.size);
    return m;
  }, [sweep, groups]);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (it: ActivityItem) => {
    const willOpen = !open.has(it.id);
    setOpen((o) => {
      const n = new Set(o);
      willOpen ? n.add(it.id) : n.delete(it.id);
      return n;
    });
    if (willOpen && isUnread(it, read)) {
      markRead([it.id]);
      onMarkRead?.([it.id]);
    }
  };

  const tabs = useRef<HTMLDivElement>(null);
  const tabKey = (e: React.KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const els = [...(tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const at = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
    els[next]?.click();
  };
  const tabId = useId();
  const selected = types.length === 0 ? "" : types.length === 1 ? types[0] : null;
  const tab = (key: string, text: string, n: number) => {
    const on = selected === key;
    return (
      <button
        key={key || "all"}
        type="button"
        role="tab"
        id={`${tabId}-${key || "all"}`}
        aria-selected={on}
        tabIndex={on || (selected === null && key === "") ? 0 : -1}
        onClick={() => setTypes(key ? [key] : [])}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium transition-colors",
          focusRing,
          on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        {text}
        <span className={cn("text-[12px] tabular-nums", on ? "text-muted-foreground" : "text-muted-foreground/80")}>{n}</span>
      </button>
    );
  };

  const interactiveRow = (i: ActivityItem) => !!(i.object || i.details || i.snippet);
  const interactive = pending > 0 || hasMore || shown.some(interactiveRow);

  return (
    <section aria-label={label} className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card", className)}>
      {tracksRead && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <p className="min-w-0 flex-1 truncate text-[14px]">
            <span className="font-medium text-foreground">{label}</span> <span className="text-muted-foreground tabular-nums">{`${unreadN} unread`}</span>
          </p>
          <Button variant="quiet" size="sm" icon={<CheckMark double={unreadN > 0} />} disabled={unreadN === 0 || sweep !== null} onClick={(e) => markAll(e.detail === 0)}>
            {unreadN > 0 ? "Mark all read" : "All caught up"}
          </Button>
        </div>
      )}
      {filters && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
          {tabKeys.length > 1 && (
            <div ref={tabs} role="tablist" aria-label="Type" onKeyDown={tabKey} className="-mx-1 flex min-w-0 gap-0.5 overflow-x-auto px-1">
              {tab("", "All", counts.all)}
              {tabKeys.map((t) => tab(t, meta[t]?.label ?? plural(t), counts.byType[t] ?? 0))}
            </div>
          )}
          <div className="ml-auto">
            <SegmentedControl
              aria-label="Who"
              size="sm"
              value={who}
              onValueChange={(v) => setWho(v as ActivityWho)}
              options={[
                { value: "all", label: "Everyone" },
                { value: "people", label: "People" },
                { value: "agents", label: "Agents" },
              ]}
            />
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      {/* Rows with nothing to open have nothing to focus: the scroll area itself takes focus so the list can still be scrolled with the keyboard. */}
      <div
        ref={scroller}
        {...(interactive ? {} : { tabIndex: 0, role: "region", "aria-label": `${label} list` })}
        className={cn("relative min-h-0 flex-1 overflow-y-auto overscroll-contain", !interactive && focusRing)}
      >
        {pending > 0 && (
          <div className="sticky top-2 z-[2] flex justify-center">
            <button
              type="button"
              onClick={release}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card py-0 pr-3 pl-1.5 text-[13px] font-medium text-foreground shadow-md transition-transform ease-(--kn-ease-out) active:scale-[.97] motion-reduce:transform-none",
                focusRing,
              )}
            >
              {waiting[0] && (
                <span aria-hidden="true">
                  <Avatar label={waiting[0].actor.name} src={waiting[0].actor.src} icon={waiting[0].actor.agent && !waiting[0].actor.src ? <BotMark /> : undefined} size="xs" shape="circle" decorative />
                </span>
              )}
              {newPillText(pending)}
              <span aria-hidden="true">↑</span>
              <span className="sr-only">, show them</span>
            </button>
          </div>
        )}
        {groups.length === 0 ? (
          <p className="px-6 py-14 text-center text-[13px] text-muted-foreground">{emptyText}</p>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <H className="sticky top-0 z-[1] flex gap-1.5 border-b border-border bg-card px-4 py-1.5 text-[12px] text-muted-foreground">
                <span className="font-medium">{g.label.split(",")[0]}</span>
                {(g.label === "Today" || g.label === "Yesterday") && <span>{dateOfKey(g.key)}</span>}
              </H>
              <ul className="divide-y divide-border">
                {g.items.map((it) => (
                  <Event
                    key={it.id}
                    item={it}
                    now={now}
                    timeZone={timeZone}
                    meta={meta[it.type]}
                    open={open.has(it.id)}
                    onToggle={() => toggle(it)}
                    onOpen={onOpen}
                    tracksRead={tracksRead}
                    unread={isUnread(it, read)}
                    sweepStep={sweepOrder.get(it.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        {hasMore && groups.length > 0 && (
          <div className="flex justify-center border-t border-border p-3">
            <Button variant="quiet" size="sm" loading={loadingMore} onClick={() => onLoadMore?.()}>
              {loadingMore ? "Loading" : "Show older"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function Event({
  item: it,
  now,
  timeZone,
  meta,
  open,
  onToggle,
  onOpen,
  tracksRead,
  unread,
  sweepStep,
}: {
  item: ActivityItem;
  now: number;
  timeZone: string;
  meta?: ActivityTypeMeta;
  open: boolean;
  onToggle: () => void;
  onOpen?: (item: ActivityItem) => void;
  tracksRead: boolean;
  unread: boolean;
  sweepStep?: number;
}) {
  const id = useId();
  const agent = !!it.actor.agent;
  const sweeping = sweepStep !== undefined;
  const canOpen = !!(it.object || it.details || it.snippet);
  const rel = relativeTime(it.at, now);
  const metaLine = [it.project, it.snippet].filter(Boolean).join(" · ");
  const body = (
    <div className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3">
      <span className="relative mt-0.5 block">
        {agent && !it.actor.src ? (
          <Avatar label={it.actor.name} icon={<BotMark />} size="md" shape="square" decorative />
        ) : (
          <Avatar label={it.actor.name} src={it.actor.src} size="md" shape="circle" decorative />
        )}
        <span aria-hidden="true" className="absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full border border-border bg-card text-foreground shadow-[0_0_0_2px_var(--card)] [&>svg]:size-3">
          {meta?.icon ?? FALLBACK_ICON}
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-[14px] leading-5 text-muted-foreground">
          {unread && <span className="sr-only">Unread. </span>}
          <span className="font-medium text-foreground">{it.actor.name}</span>
          {agent && <span className="sr-only"> (agent)</span>} {it.verb}
          {it.object && (
            <>
              {" "}
              <span className="font-medium text-foreground">{it.object}</span>
            </>
          )}
        </p>
        {metaLine && !open && <p className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">{metaLine}</p>}
        {metaLine && open && it.project && <p className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">{it.project}</p>}
      </div>
      <div className="flex items-center gap-2 pt-px">
        <time dateTime={new Date(it.at).toISOString()} title={fullTime(it.at, timeZone)} className="text-[12px] leading-5 tabular-nums text-muted-foreground">
          {rel === "now" ? "Just now" : rel}
        </time>
        {tracksRead && (
          <span
            aria-hidden="true"
            style={sweeping ? { transitionDelay: `${sweepDelay(sweepStep, SWEEP_STEP)}ms` } : undefined}
            className={cn(
              "size-2 shrink-0 rounded-full transition-colors duration-[180ms] ease-(--kn-ease-out) motion-reduce:transition-none",
              unread && !sweeping ? "bg-indigo-500" : "bg-muted-foreground/25",
            )}
          />
        )}
      </div>
    </div>
  );
  if (!canOpen) return <li className="px-4 py-3">{body}</li>;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={cn("block w-full px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40", focusRing, "focus-visible:ring-inset")}
      >
        {body}
      </button>
      <div id={id} hidden={!open} className="px-4 pb-3 pl-[60px]">
        {it.snippet && <p className="rounded-lg bg-muted/50 px-3 py-2 text-[13px] leading-5 text-foreground/90">{it.snippet}</p>}
        {it.details && (
          <div className={it.snippet ? "mt-2" : ""}>
            <Details d={it.details} />
          </div>
        )}
        {onOpen && it.object && (
          <div className="mt-2">
            <Button variant="quiet" size="sm" onClick={() => onOpen(it)}>
              Open {it.object}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function Details({ d }: { d: ActivityDetails }) {
  if (d.kind === "diff")
    return (
      <div className="text-[13px]">
        <p className="font-mono text-[12px] tabular-nums">
          {d.files} file{d.files === 1 ? "" : "s"}
          {d.added > 0 && <span className="text-emerald-700 dark:text-emerald-400"> +{d.added}</span>}
          {d.removed > 0 && <span className="text-red-700 dark:text-red-400"> -{d.removed}</span>}
          <span className="sr-only">, {diffSummary(d)}</span>
        </p>
        {d.summary && <p className="mt-1 text-muted-foreground">{d.summary}</p>}
      </div>
    );
  if (d.kind === "tool")
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px] leading-5">
        <dt className="text-muted-foreground">tool</dt>
        <dd className="min-w-0 break-words">{d.name}</dd>
        {d.input && (
          <>
            <dt className="text-muted-foreground">input</dt>
            <dd className="min-w-0 break-words">{d.input}</dd>
          </>
        )}
        {d.output && (
          <>
            <dt className="text-muted-foreground">output</dt>
            <dd className="min-w-0 break-words">{d.output}</dd>
          </>
        )}
      </dl>
    );
  return <p className="text-[13px] text-muted-foreground">{d.text}</p>;
}

export default ActivityFeed;
