"use client";
/** @registry name="notification-center" type="block" title="Notification center" description="A bell with an unread count and a panel of notifications: tabs, day groups, read state, agent actions and an endless list; a sheet on phones." */

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Avatar } from "@/ui/components/ui/knowns/avatar";
import { Button } from "@/ui/components/ui/knowns/button";
import { Dialog } from "@/ui/components/ui/knowns/dialog";
import { Popover } from "@/ui/components/ui/knowns/popover";
import { Tabs, TabsList, TabsTrigger } from "@/ui/components/ui/knowns/tabs";
import { groupByDay, relativeTime, fullTime } from "./app-feed-utils";
import {
  arrivals,
  badgeText,
  forTab,
  unreadCount,
  unreadSentence,
  type NotificationLike,
  type NotificationTab,
} from "./notification-utils";

export type { NotificationType, NotificationTab } from "./notification-utils";
export type NotificationState = "finished" | "needs-approval" | "failed";

export interface NotificationAction {
  id: string;
  label: string;
  /** "primary" for the one action that moves the work forward (Approve). */
  variant?: "primary" | "secondary";
}

export interface NotificationItem extends NotificationLike {
  title: string;
  body?: string;
  /** Who it is from. Agents get a bot mark instead of initials. */
  actor?: { name: string; agent?: boolean; src?: string };
  /** For agent runs: how it ended or what it waits for. */
  state?: NotificationState;
  /** Inline buttons on the row, e.g. Approve / Open. */
  actions?: NotificationAction[];
}

const STATE: Record<NotificationState, { label: string; text: string }> = {
  finished: { label: "Finished", text: "text-emerald-700 dark:text-emerald-400" },
  "needs-approval": { label: "Needs approval", text: "text-amber-700 dark:text-amber-400" },
  failed: { label: "Failed", text: "text-red-700 dark:text-red-400" },
};

const BotMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
    <path d="M12 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <rect x="4" y="7" width="16" height="13" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="9" cy="13" r="1.6" fill="currentColor" />
    <circle cx="15" cy="13" r="1.6" fill="currentColor" />
  </svg>
);
const BellMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </svg>
);
const CheckMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

const NARROW = "(max-width: 639px)";
function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(NARROW);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

export interface NotificationPanelProps {
  items: NotificationItem[];
  /** The clock (ms). Pass it so grouping and "5m" are the same on server and client. Default: first render time. */
  now?: number;
  /** Time zone that cuts the days. Default "UTC" (same everywhere, so no hydration mismatch). */
  timeZone?: string;
  /** One notification was read or marked unread. */
  onRead?: (id: string, read: boolean) => void;
  /** "Mark all as read" on the shown tab; gets the ids that were unread. */
  onReadAll?: (ids: string[]) => void;
  /** An inline action was pressed. */
  onAction?: (item: NotificationItem, actionId: string) => void;
  /** The row itself was pressed (open the thing it is about). */
  onOpen?: (item: NotificationItem) => void;
  /** The end of the list came into view, or "Show older" was pressed. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Shown when a tab has nothing. */
  emptyText?: string;
  /** Level of the day headings (Today, Yesterday). Default 3: set it so levels do not skip on your page. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/** The panel on its own: tabs, day groups, rows. Use it inline (a page, a sidebar) or inside NotificationCenter. */
export function NotificationPanel({
  items,
  now: nowProp,
  timeZone = "UTC",
  onRead,
  onReadAll,
  onAction,
  onOpen,
  onLoadMore,
  hasMore,
  loadingMore,
  emptyText = "You are all caught up.",
  headingLevel = 3,
  className,
}: NotificationPanelProps) {
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  const [fallbackNow] = useState(() => Date.now());
  const now = nowProp ?? fallbackNow;
  const [tab, setTab] = useState<NotificationTab>("all");
  const shown = useMemo(() => forTab(items, tab), [items, tab]);
  const groups = useMemo(() => groupByDay(shown, now, timeZone), [shown, now, timeZone]);
  const unread = unreadCount(items);
  const unreadHere = unreadCount(items, tab);
  const listId = useId();

  // Tell screen readers what arrived (a polite live region), but not on the first render.
  const seen = useRef<Set<string> | null>(null);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (seen.current) {
      const fresh = arrivals(seen.current, items);
      if (fresh.length) setAnnounce(fresh.length === 1 ? "1 new notification" : `${fresh.length} new notifications`);
    }
    seen.current = new Set(items.map((i) => i.id));
  }, [items]);

  // Endless list: load more when the sentinel scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loadingMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && loadRef.current?.(), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, shown.length]);

  const count = (t: NotificationTab) => unreadCount(items, t) || undefined;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 pt-3">
        <div className="min-w-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as NotificationTab)} size="sm">
            <TabsList aria-label="Notification type">
              <TabsTrigger value="all" badge={count("all")}>All</TabsTrigger>
              <TabsTrigger value="mentions" badge={count("mentions")}>Mentions</TabsTrigger>
              <TabsTrigger value="agents" badge={count("agents")}>Agents</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <Button
          variant="quiet"
          size="xs"
          disabled={unreadHere === 0}
          onClick={() => onReadAll?.(shown.filter((i) => !i.read).map((i) => i.id))}
          className="mb-2 shrink-0"
        >
          <span className="sm:hidden">Read all</span>
          <span className="max-sm:hidden">Mark all read</span>
        </Button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announce || unreadSentence(unread)}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" tabIndex={-1}>
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <span className="mb-1 grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
              <CheckMark />
            </span>
            <p className="text-[14px] font-medium">Nothing here</p>
            <p className="text-[13px] text-muted-foreground">{emptyText}</p>
          </div>
        ) : (
          <div id={listId}>
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <H className="sticky top-0 z-[1] border-b border-border bg-card px-4 py-1.5 text-[12px] font-medium text-muted-foreground">{g.label}</H>
                <ul className="divide-y divide-border">
                  {g.items.map((n) => (
                    <Row key={n.id} item={n} now={now} timeZone={timeZone} onRead={onRead} onAction={onAction} onOpen={onOpen} />
                  ))}
                </ul>
              </section>
            ))}
            {hasMore ? (
              <div ref={sentinel} className="flex justify-center border-t border-border p-3">
                <Button variant="quiet" size="sm" loading={loadingMore} onClick={() => onLoadMore?.()}>
                  {loadingMore ? "Loading" : "Show older"}
                </Button>
              </div>
            ) : (
              <p className="border-t border-border px-4 py-3 text-center text-[12px] text-muted-foreground">That is everything.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  item: n,
  now,
  timeZone,
  onRead,
  onAction,
  onOpen,
}: {
  item: NotificationItem;
  now: number;
  timeZone: string;
  onRead?: (id: string, read: boolean) => void;
  onAction?: (item: NotificationItem, actionId: string) => void;
  onOpen?: (item: NotificationItem) => void;
}) {
  const state = n.state ? STATE[n.state] : null;
  const agent = n.actor?.agent || n.type === "agent";
  return (
    <li className={cn("relative grid grid-cols-[auto_1fr_auto] gap-x-3 px-4 py-3", !n.read && "bg-muted/40")}>
      <span className="relative mt-0.5">
        {n.actor?.src || !agent ? (
          <Avatar label={n.actor?.name ?? "System"} src={n.actor?.src} size="sm" shape="circle" decorative />
        ) : (
          <Avatar label={n.actor?.name ?? "Agent"} icon={<BotMark />} size="sm" shape="square" decorative />
        )}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => onOpen?.(n)}
          className={cn("block w-full rounded-md text-left outline-none", focusRing)}
        >
          <span className="flex items-center gap-1.5">
            {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-indigo-500" aria-hidden="true" />}
            <span className={cn("truncate text-[14px] leading-5", n.read ? "text-foreground/85" : "font-medium text-foreground")}>
              {!n.read && <span className="sr-only">Unread: </span>}
              {n.title}
            </span>
          </span>
          {n.body && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-muted-foreground">{n.body}</span>}
        </button>
        {state && (
          // One state, one signal: the coloured word is the state. (No extra dot beside it.)
          <p className={cn("mt-1 text-[12px] font-medium", state.text)}>{state.label}</p>
        )}
        {n.actions && n.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {n.actions.map((a) => (
              <Button key={a.id} size="xs" variant={a.variant === "primary" ? "primary" : "secondary"} onClick={() => onAction?.(n, a.id)}>
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1">
        <time dateTime={new Date(n.at).toISOString()} title={fullTime(n.at, timeZone)} className="text-[12px] tabular-nums text-muted-foreground">
          {relativeTime(n.at, now)}
        </time>
        <button
          type="button"
          onClick={() => onRead?.(n.id, !n.read)}
          aria-label={n.read ? `Mark "${n.title}" as unread` : `Mark "${n.title}" as read`}
          title={n.read ? "Mark as unread" : "Mark as read"}
          className={cn("grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", focusRing, n.read && "opacity-50")}
        >
          <CheckMark />
        </button>
      </div>
    </li>
  );
}

export interface NotificationCenterProps extends NotificationPanelProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name of the bell and the panel. */
  label?: string;
  /** Popover side on wide screens. */
  align?: "start" | "end";
}

/** A bell with an unread count. Opens the panel in a popover, or as a full-height sheet below 640px. */
export function NotificationCenter({ open: openProp, onOpenChange, label = "Notifications", align = "end", ...panel }: NotificationCenterProps) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setOwn(v);
    onOpenChange?.(v);
  };
  const narrow = useNarrow();
  const unread = unreadCount(panel.items);
  const text = badgeText(unread);
  const bell = (
    <button
      type="button"
      aria-label={`${label}${unread ? `, ${unreadSentence(unread).toLowerCase()}` : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cn("relative grid size-9 place-items-center rounded-[10px] text-foreground/80 transition-colors hover:bg-muted hover:text-foreground", focusRing, open && "bg-muted text-foreground")}
    >
      <BellMark />
      {text && (
        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold leading-none tabular-nums text-white">
          {text}
        </span>
      )}
    </button>
  );
  if (narrow) {
    return (
      <>
        {bell}
        <Dialog open={open} onOpenChange={setOpen} title={label} sheet size="sm" className="max-sm:h-[calc(100dvh-2.5rem)]" bodyClassName="flex min-h-0 flex-1 flex-col p-0">
          <NotificationPanel {...panel} className="h-full" />
        </Dialog>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={bell} align={align} aria-label={label} className="w-[400px] max-w-[calc(100vw-1rem)] p-0">
      <NotificationPanel {...panel} className="max-h-[min(560px,70vh)]" />
    </Popover>
  );
}

export default NotificationCenter;
