"use client";
/** @registry name="command-menu" type="ui" title="Command menu" description="⌘K palette: fuzzy search with highlights, groups, shortcuts, nested pages, recents and async results - all by keyboard." */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Kbd } from "../kbd";
import { Spinner } from "../spinner";
import { fuzzyMatch, groupBy, highlightParts, hotkeyLabel, isHotkey, moveActive, pushRecent, rankItems } from "./command-utils";

export interface CommandItem {
  id: string;
  /** Plain text: it is matched and highlighted. */
  label: string;
  description?: ReactNode;
  /** Right after the label, e.g. a "Pro" mark or a "New" dot. Not matched. */
  badge?: ReactNode;
  /** 16px box on the left; svgs fill it. */
  icon?: ReactNode;
  /** Keys shown on the right as Kbd, e.g. ["⌘", "N"]. */
  shortcut?: string[];
  /** Extra words that also match ("new", "create"). */
  keywords?: string[];
  group?: string;
  disabled?: boolean;
  /** Open this page (Enter drills in, Backspace on an empty search goes back). */
  page?: string;
  /** Run on Enter / click. The menu closes unless `keepOpen`. */
  onSelect?: () => void;
  keepOpen?: boolean;
}

export interface CommandPage {
  id: string;
  /** Shown as a crumb in the search field. */
  title: string;
  placeholder?: string;
  items?: CommandItem[];
  /** Results that depend on the query (searched as you type, debounced; aborted when the query changes). */
  load?: (query: string, signal: AbortSignal) => Promise<CommandItem[]>;
  /** Group order on this page. */
  groups?: string[];
}

export interface CommandMenuProps {
  /** Root items. */
  items: CommandItem[];
  pages?: CommandPage[];
  /** Group order at the root. "Recent" always comes first. */
  groups?: string[];
  /** Async results at the root (e.g. a search API), shown in their own group. */
  load?: (query: string, signal: AbortSignal) => Promise<CommandItem[]>;
  /** Group name for loaded results. Default "Results". */
  loadGroup?: string;
  /** Delay before `load` runs, ms. Default 150. */
  debounce?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Global shortcut that toggles the menu; false to turn it off. Default "mod+k" (⌘K / Ctrl+K). */
  hotkey?: string | false;
  /** Called for every picked item (after its own onSelect). */
  onSelect?: (item: CommandItem) => void;
  /** Recently picked ids, shown at the root while the search is empty. Controlled with onRecentsChange, else kept here. */
  recents?: string[];
  onRecentsChange?: (ids: string[]) => void;
  /** How many recents to keep; 0 hides the group. Default 5. */
  maxRecents?: number;
  placeholder?: string;
  /** Shown when nothing matches. Default: "No results for “…”". */
  empty?: (query: string) => ReactNode;
  /** Label for the dialog. Default "Command menu". */
  "aria-label"?: string;
  className?: string;
}

const EASE = "ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]";

/*
 * Motion, all CSS so a closed menu costs nothing. A command menu is opened constantly, so it barely moves:
 * - the panel fades in and fades out (a real exit: the native dialog stays painted through `overlay` /
 *   `display` with allow-discrete); the backdrop fades with it;
 * - no stagger, no height tween and no gliding highlight: the list changes at once as you type and the
 *   highlight sits on the active row.
 * Reduced motion: the same fade is the only motion, and it is instant.
 */
const MOTION = `
[data-kn-cmd]{opacity:1;transition:opacity var(--kn-dur-fast,120ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),overlay var(--kn-dur-fast,120ms) allow-discrete,display var(--kn-dur-fast,120ms) allow-discrete}
[data-kn-cmd]:not([open]){opacity:0;transition-duration:calc(var(--kn-dur-fast,120ms)*.67)}
@starting-style{[data-kn-cmd][open]{opacity:0}}
[data-kn-cmd]::backdrop{background:rgb(0 0 0/.4);backdrop-filter:blur(2px);opacity:1;transition:opacity var(--kn-dur-fast,120ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),overlay var(--kn-dur-fast,120ms) allow-discrete,display var(--kn-dur-fast,120ms) allow-discrete}
[data-kn-cmd]:not([open])::backdrop{opacity:0;transition-duration:calc(var(--kn-dur-fast,120ms)*.67)}
@starting-style{[data-kn-cmd][open]::backdrop{opacity:0}}
@media (prefers-reduced-motion:reduce){
  [data-kn-cmd],[data-kn-cmd]::backdrop{transition-duration:0s}
}
`;
const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden className="size-4 flex-none text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.5 10.5l3 3" />
  </svg>
);
const Chevron = () => (
  <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 flex-none text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4l4 4-4 4" />
  </svg>
);
const Clock = () => (
  <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3l2 1.5" />
  </svg>
);

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges.length) return <span>{text}</span>;
  return (
    <>
      {highlightParts(text, ranges).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[2px] bg-transparent font-semibold text-foreground underline decoration-[color-mix(in_srgb,var(--foreground)_35%,transparent)] decoration-1 underline-offset-[3px]">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

interface Row {
  item: CommandItem;
  ranges: [number, number][];
  group: string;
  key: string;
}

/**
 * Command menu (⌘K): a dialog with a search field over grouped commands. Fuzzy matching highlights the
 * matched characters; items carry an icon, a description and a shortcut. Items can open nested pages
 * (Enter drills in, Backspace on an empty search or Escape goes back), recent picks show first, and a
 * page can load results as you type. The field is an ARIA combobox driving a listbox.
 */
export function CommandMenu({
  items,
  pages = [],
  groups = [],
  load,
  loadGroup = "Results",
  debounce = 150,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  hotkey = "mod+k",
  onSelect,
  recents: recentsProp,
  onRecentsChange,
  maxRecents = 5,
  placeholder = "Type a command or search…",
  empty,
  "aria-label": ariaLabel = "Command menu",
  className,
}: CommandMenuProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = openProp ?? ownOpen;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setOwnOpen(v);
    onOpenChange?.(v);
  };

  const [ownRecents, setOwnRecents] = useState<string[]>([]);
  const recents = recentsProp ?? ownRecents;
  const setRecents = (ids: string[]) => {
    if (recentsProp === undefined) setOwnRecents(ids);
    onRecentsChange?.(ids);
  };

  const [stack, setStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const pageId = stack.at(-1);
  const page = pages.find((p) => p.id === pageId);

  /* Global hotkey. */
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!hotkey) return;
    const mac = isMac();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isHotkey(e, hotkey, mac)) return;
      e.preventDefault();
      if (openProp === undefined) setOwnOpen(!openRef.current);
      onOpenChange?.(!openRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hotkey, openProp, onOpenChange]);

  /* Native modal dialog: focus trap, top layer, Escape → cancel. */
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      // Reset on open, not on close, so the closing panel keeps its content while it fades out.
      setStack([]);
      setQuery("");
      setActive(0);
      d.showModal();
      inputRef.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  /* Async results for the current page (or the root). */
  const loader = page ? page.load : load;
  const [loaded, setLoaded] = useState<{ key: string; items: CommandItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const loadKey = `${pageId ?? ""}\u0000${query}`;
  useEffect(() => {
    if (!open || !loader || (!page && !query.trim())) {
      setLoading(false);
      setLoaded(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    const t = window.setTimeout(() => {
      loader(query, ctl.signal)
        .then((r) => !ctl.signal.aborted && setLoaded({ key: loadKey, items: r }))
        .catch(() => !ctl.signal.aborted && setLoaded({ key: loadKey, items: [] }))
        .finally(() => !ctl.signal.aborted && setLoading(false));
    }, debounce);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, open, loader]);

  /* Rows: recents (root, empty query) → ranked static items → loaded results. */
  // Loaded results are remembered once picked, so they can show up in Recent too.
  const picked = useRef(new Map<string, CommandItem>());
  const allItems = useMemo(() => {
    const m = new Map<string, CommandItem>(picked.current);
    for (const it of items) m.set(it.id, it);
    for (const p of pages) for (const it of p.items ?? []) m.set(it.id, it);
    return m;
  }, [items, pages, recents]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: Row[] = useMemo(() => {
    const base = page ? (page.items ?? []) : items;
    const order = page ? (page.groups ?? []) : groups;
    const out: Row[] = [];
    if (!page && !query.trim() && maxRecents > 0) {
      for (const id of recents.slice(0, maxRecents)) {
        const it = allItems.get(id);
        if (it && !it.disabled) out.push({ item: { ...it, icon: it.icon ?? <Clock /> }, ranges: [], group: "Recent", key: `recent:${id}` });
      }
    }
    const ranked = rankItems(base, query);
    // With a query, best matches lead: one flat list in score order, grouped by first appearance.
    const grouped = query.trim()
      ? groupBy(ranked.map((r) => ({ ...r, group: r.item.group })))
      : groupBy(ranked.map((r) => ({ ...r, group: r.item.group })), order);
    for (const g of grouped) for (const r of g.items) out.push({ item: r.item, ranges: r.ranges, group: g.group, key: r.item.id });
    if (loaded && loaded.key === loadKey) {
      // The loader already searched: keep its order and every result (a server may match text the label
      // lacks), only highlight, and group like the static rows so one group never shows twice.
      const extra = loaded.items.map((item) => ({ item, group: item.group ?? (page ? "" : loadGroup), ranges: query ? (fuzzyMatch(query, item.label)?.ranges ?? []) : [] }));
      for (const g of groupBy(extra, order)) for (const r of g.items) out.push({ item: r.item, ranges: r.ranges, group: g.group, key: `loaded:${r.item.id}` });
    }
    return out;
  }, [page, items, groups, query, recents, maxRecents, allItems, loaded, loadKey, loadGroup]);

  // Keep the active row on an enabled item.
  useEffect(() => {
    const first = rows.findIndex((r) => !r.item.disabled);
    setActive(first === -1 ? -1 : first);
  }, [query, pageId, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const id = useId();
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`#${CSS.escape(optId(active))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* One highlight, placed on the active row at once (no glide). */
  const pillRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const el = active >= 0 ? listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optId(active))}`) : null;
    if (!pill) return;
    if (!el || !open) {
      pill.style.opacity = "0";
      delete pill.dataset.shown;
      return;
    }
    pill.style.transform = `translateY(${el.offsetTop}px)`;
    pill.style.height = `${el.offsetHeight}px`;
    pill.style.opacity = "1";
    pill.dataset.shown = "";
  });

  const choose = (row: Row) => {
    const it = row.item;
    if (it.disabled) return;
    if (it.page) {
      setStack((s) => [...s, it.page!]);
      setQuery("");
      return;
    }
    it.onSelect?.();
    onSelect?.(it);
    if (maxRecents > 0) {
      if (!allItems.has(it.id)) picked.current.set(it.id, it);
      setRecents(pushRecent(recents, it.id, maxRecents));
    }
    if (!it.keepOpen) setOpen(false);
  };

  const back = () => {
    setStack((s) => s.slice(0, -1));
    setQuery("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = moveActive(rows.map((r) => !!r.item.disabled), active, e.key);
    if (next !== null && (e.key === "ArrowDown" || e.key === "ArrowUp" || ((e.key === "Home" || e.key === "End") && !query))) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) choose(row);
    } else if (e.key === "Backspace" && !query && stack.length) {
      e.preventDefault();
      back();
    } else if (e.key === "Escape" && stack.length) {
      // Back out of a page first; the root closes the dialog.
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };

  const crumbs = stack.map((s) => pages.find((p) => p.id === s)?.title ?? s);
  const activeRow = rows[active];
  let lastGroup: string | null = null;
  let groupIdx = 0;

  return (
    <dialog
      ref={dialogRef}
      data-kn-cmd=""
      aria-label={ariaLabel}
      onCancel={(e) => {
        e.preventDefault();
        if (stack.length) back();
        else setOpen(false);
      }}
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      className={cn(
        "m-auto mt-[12vh] w-[calc(100%-2rem)] max-w-[600px] overflow-hidden rounded-2xl border bg-popover p-0 text-[13.5px] text-popover-foreground",
        "[border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_6%,transparent),0_24px_64px_-16px_rgb(0_0_0/0.4)]",
        "dark:[background:color-mix(in_srgb,var(--popover)_80%,#000)]",
        className,
      )}
    >
      <style href="kn-command-menu" precedence="default">
        {MOTION}
      </style>
      {/* Search */}
      <div className="flex h-12 items-center gap-2.5 border-b px-4 [border-color:color-mix(in_srgb,var(--foreground)_8%,transparent)]">
        <SearchGlyph />
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex flex-none items-center gap-1 rounded-[6px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-1.5 py-0.5 text-[12px] font-medium text-foreground">
            {c}
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && rows[active] ? optId(active) : undefined}
          aria-label={page ? `Search ${page.title}` : "Search commands"}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={page?.placeholder ?? placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-muted-foreground"
        />
        {loading && <Spinner className="size-4 text-muted-foreground" label="Loading results" />}
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
      </div>

      {/* List */}
      <div className="overflow-hidden">
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={page ? page.title : "Commands"}
        data-kn-cmd-list=""
        className="kn-scroll relative max-h-[min(380px,55vh)] overflow-y-auto overscroll-contain p-1.5 [scrollbar-width:thin]"
      >
        <div ref={pillRef} aria-hidden data-kn-cmd-pill="" className="pointer-events-none absolute inset-x-1.5 top-0 rounded-[9px] bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] opacity-0" />
        {rows.length === 0 && !loading && (
          <div role="presentation" data-kn-cmd-empty="" className="px-3 py-10 text-center text-[13px] text-muted-foreground">
            {query ? (empty ? empty(query) : <>No results for “{query}”</>) : "Nothing here yet."}
          </div>
        )}
        {rows.length === 0 && loading && (
          <div role="presentation" className="flex flex-col gap-1.5 p-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 rounded-[9px] bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] motion-safe:animate-pulse" style={{ opacity: 1 - i * 0.25 }} />
            ))}
          </div>
        )}
        {(() => {
          const out: ReactNode[] = [];
          let groupRows: ReactNode[] = [];
          const flush = () => {
            if (!groupRows.length) return;
            const gid = `${id}-g-${groupIdx++}`;
            out.push(
              <div key={gid} role="group" aria-labelledby={lastGroup ? gid : undefined} className="pb-1 [&+&]:border-t [&+&]:pt-1 [&+&]:[border-color:color-mix(in_srgb,var(--foreground)_6%,transparent)]">
                {lastGroup && (
                  <div id={gid} role="presentation" className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-muted-foreground">
                    {lastGroup}
                  </div>
                )}
                {groupRows}
              </div>,
            );
            groupRows = [];
          };
          rows.forEach((r, i) => {
            if (r.group !== lastGroup) {
              flush();
              lastGroup = r.group;
            }
            const it = r.item;
            const on = i === active;
            groupRows.push(
              <div
                key={r.key}
                id={optId(i)}
                role="option"
                aria-selected={on}
                aria-disabled={it.disabled || undefined}
                onPointerMove={() => !it.disabled && active !== i && setActive(i)}
                onClick={() => choose(r)}
                className={cn(
                  // Relative so the row paints above the gliding highlight. forced-colors has no highlight paint, so outline there.
                  "relative flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 select-none",
                  `transition-colors duration-100 ${EASE}`,
                  on && "forced-colors:outline forced-colors:outline-1",
                  it.disabled && "cursor-not-allowed opacity-45",
                )}
              >
                {it.icon && <span aria-hidden className="grid size-4 flex-none place-items-center text-muted-foreground [&>*]:size-full [&_svg]:size-full">{it.icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-muted-foreground [&>span]:text-foreground/90">
                      <Highlighted text={it.label} ranges={r.ranges} />
                    </span>
                    {it.badge && <span className="flex flex-none items-center">{it.badge}</span>}
                  </span>
                  {it.description && <span className="truncate text-[12px] text-muted-foreground">{it.description}</span>}
                </span>
                {it.shortcut && (
                  <span className="flex flex-none items-center gap-0.5" aria-label={`Shortcut ${it.shortcut.join(" ")}`}>
                    {it.shortcut.map((k, j) => (
                      <Kbd key={j}>{k}</Kbd>
                    ))}
                  </span>
                )}
                {it.page && <Chevron />}
              </div>,
            );
          });
          flush();
          return out;
        })()}
      </div>
      </div>

      {/* Footer hints */}
      <div className="flex h-9 items-center gap-4 border-t px-4 text-[11.5px] text-muted-foreground [border-color:color-mix(in_srgb,var(--foreground)_8%,transparent)]">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> {activeRow?.item.page ? "to open" : "to run"}
        </span>
        {stack.length > 0 && (
          <span className="flex items-center gap-1">
            <Kbd>⌫</Kbd> back
          </span>
        )}
        <span className="flex-1" />
        <span aria-live="polite" className="tabular-nums">
          {query ? `${rows.length} ${rows.length === 1 ? "result" : "results"}` : ""}
        </span>
      </div>
    </dialog>
  );
}

/** The usual trigger: a search-looking button with the hotkey, e.g. in a header. */
export function CommandMenuTrigger({ onClick, label = "Search…", hotkey = "mod+k", className }: { onClick: () => void; label?: string; hotkey?: string; className?: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={hotkey.replace("mod", mac ? "Meta" : "Control")}
      className={cn(
        "inline-flex h-8 w-56 items-center gap-2 rounded-[9px] bg-card px-2.5 text-[13px] text-muted-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.04)] transition-colors hover:text-foreground",
        "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <SearchGlyph />
      <span className="flex-1 text-left">{label}</span>
      <span className="flex gap-0.5" aria-hidden>
        {hotkeyLabel(hotkey, mac).map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </button>
  );
}

export default CommandMenu;
