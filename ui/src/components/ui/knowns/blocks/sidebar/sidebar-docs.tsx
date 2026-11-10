"use client";
/** @registry name="sidebar-docs" type="block" title="Docs sidebar" description="A docs sidebar built on Sidebar: search, filter chips, sections, categories and pages with counts, New and Pro marks, upcoming pages marked Soon, remembered folds and the current page scrolled into view." */

/**
 * DocsSidebar: a docs library sidebar. A search button, filter chips (with an overflow "More" menu),
 * sections of categories of pages with counts and guide lines, a New dot and Pro stars per page, and a
 * footer slot. The current page's section and category open on their own and scroll into view; what
 * the reader opens or closes is remembered.
 */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Kbd } from "../../kbd";
import { loadJSON, saveJSON } from "./sidebar-utils";

export interface DocsPage {
  id: string;
  label: string;
  href: string;
  /** A green dot. */
  isNew?: boolean;
  /** A filled star (true) or an outline star ("variants": free, with Pro variants). */
  pro?: boolean | "variants";
  /**
   * Coming soon: listed muted after the live pages of its category with a "Soon" badge, and left out of the
   * counts. Still a link (to a placeholder page), so the keyboard reaches it. Filters decide whether it shows.
   */
  soon?: boolean;
}

export interface DocsCategory {
  id: string;
  label: string;
  /** The category's own page (its name links there). */
  href?: string;
  pages: DocsPage[];
}

export interface DocsSection {
  id: string;
  label: string;
  icon?: ReactNode;
  href?: string;
  /** Pages straight under the section (e.g. Getting started)... */
  pages?: DocsPage[];
  /** ...or categories of pages. */
  categories?: DocsCategory[];
  /** Show the page count next to the label. Default true when the section has categories. */
  count?: boolean;
}

export interface DocsFilter {
  id: string;
  label: string;
  match: (page: DocsPage) => boolean;
  /** Open every section and category while this filter is on (short lists such as "New"). */
  expand?: boolean;
  /** A colour dot in the More menu. */
  dot?: string;
}

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode; "aria-current"?: "page" }>;

export interface DocsSidebarProps {
  sections: DocsSection[];
  /** The current page, section or category id. */
  current: string;
  /** Filter chips. The first `chips` show as a segmented control, the rest in a "More" menu. */
  filters?: DocsFilter[];
  chips?: number;
  /** Controlled filter id. */
  filter?: string;
  onFilterChange?: (id: string) => void;
  /** Shows the search button. */
  onSearch?: () => void;
  /** Before the search button on its row, e.g. a SidebarTrigger (look="field") that hides the sidebar. */
  searchLeading?: ReactNode;
  /** Shows ⌘ instead of Ctrl on the search button. */
  isMac?: boolean;
  /** Replace the default New dot and Pro stars after a page's name. */
  renderMark?: (page: DocsPage) => ReactNode;
  /** Remember the open sections and categories under this localStorage key. */
  storageKey?: string;
  /** Under the list, e.g. a "What's new" button. */
  footer?: ReactNode;
  linkAs?: LinkComponent | "a";
  label?: string;
  emptyText?: ReactNode;
  className?: string;
}

const pagesOf = (s: DocsSection) => [...(s.pages ?? []), ...(s.categories ?? []).flatMap((c) => c.pages)];
/** Pages that count: everything but the upcoming ones. */
export const liveCount = (pages: DocsPage[]) => pages.filter((p) => !p.soon).length;
/** Live pages first, then the upcoming ones, each in the given order. */
export const soonLast = (pages: DocsPage[]) => [...pages.filter((p) => !p.soon), ...pages.filter((p) => p.soon)];

/** Open keys: "<section>" and "<section>/<category>". */
export function docsOpenKeys(sections: DocsSection[], current: string): string[] {
  for (const s of sections) {
    if (s.id === current) return [s.id];
    if (s.pages?.some((p) => p.id === current)) return [s.id];
    for (const c of s.categories ?? []) if (c.id === current || c.pages.some((p) => p.id === current)) return [s.id, `${s.id}/${c.id}`];
  }
  return [];
}

/** The sections a filter leaves: pages that match, categories and sections that still have one. */
export function filterSections(sections: DocsSection[], match: (p: DocsPage) => boolean): DocsSection[] {
  return sections
    .map((s) => ({
      ...s,
      pages: s.pages?.filter(match),
      categories: s.categories?.map((c) => ({ ...c, pages: c.pages.filter(match) })).filter((c) => c.pages.length > 0),
    }))
    .filter((s) => pagesOf(s).length > 0);
}

const STAR = "M8 1.6l1.9 4.1 4.5.5-3.3 3.1.9 4.4L8 11.5l-4 2.2.9-4.4-3.3-3.1 4.5-.5z";

/** The default marks: a New dot, then a Pro star (filled) or a Pro-variants star (outline). */
export function DocsMark({ page }: { page: DocsPage }) {
  return (
    <>
      {page.isNew && (
        <span title="New" className="size-1.5 shrink-0 rounded-full bg-emerald-500">
          <span className="sr-only">New</span>
        </span>
      )}
      {page.pro && (
        <svg viewBox="0 0 16 16" role="img" aria-label={page.pro === "variants" ? "Free, with Pro variants" : "Pro"} className="ml-auto size-3 shrink-0 text-violet-500">
          <path d={STAR} fill={page.pro === true ? "currentColor" : "none"} stroke="currentColor" strokeWidth={page.pro === true ? 0 : 1.3} strokeLinejoin="round" />
        </svg>
      )}
    </>
  );
}

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none", open && "rotate-90", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** The neutral "Soon" tag on an upcoming page; its link name reads "<title>, coming soon". */
function SoonBadge() {
  return (
    <span className="ml-auto shrink-0 rounded-md border px-1.5 text-[10.5px] font-medium leading-[16px] text-muted-foreground">
      <span aria-hidden="true">Soon</span>
      <span className="sr-only">, coming soon</span>
    </span>
  );
}

function Count({ n }: { n: number }) {
  // A category with only upcoming pages has no count.
  if (n === 0) return null;
  return <span className="rounded-md bg-muted px-1.5 text-[10.5px] font-medium tabular-nums leading-[18px] text-muted-foreground">{n}</span>;
}

function Collapse({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  return (
    <div
      id={id}
      className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function FoldButton({ open, label, controls, onToggle, className }: { open: boolean; label: string; controls: string; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
      className={cn("grid size-6 shrink-0 place-items-center rounded-md outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-9", className)}
    >
      <Chevron open={open} />
    </button>
  );
}

const ON = "bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]";
const idFor = (key: string) => `kn-docs-nav-${key.toLowerCase().replace(/\W+/g, "-")}`;

function Pages({ pages, current, mark, LinkAs }: { pages: DocsPage[]; current: string; mark: (p: DocsPage) => ReactNode; LinkAs: LinkComponent | "a" }) {
  return (
    <ul className="ml-[15px] flex flex-col gap-px border-l py-0.5 pl-2 [border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)]">
      {soonLast(pages).map((p) => (
        <li key={p.id}>
          <LinkAs
            href={p.href}
            aria-current={current === p.id ? "page" : undefined}
            className={cn(
              "group relative flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-[13px] outline-none pointer-coarse:h-10",
              "text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              "aria-[current=page]:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] aria-[current=page]:font-medium aria-[current=page]:text-foreground",
              "forced-colors:aria-[current=page]:outline forced-colors:aria-[current=page]:outline-1",
            )}
          >
            {/* The current page marks the guide line beside it. */}
            <span aria-hidden="true" className="absolute top-1/2 -left-[9px] h-4 w-[2px] -translate-y-1/2 rounded-full bg-foreground opacity-0 group-aria-[current=page]:opacity-100" />
            <span className="min-w-0 truncate">{p.label}</span>
            {p.soon ? <SoonBadge /> : mark(p)}
          </LinkAs>
        </li>
      ))}
    </ul>
  );
}

function MoreFilter({ filters, value, onPick }: { filters: DocsFilter[]; value: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const picked = filters.find((f) => f.id === value);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative flex-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-6 w-full items-center justify-center gap-0.5 rounded-lg px-1.5 text-[11.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          picked ? "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {picked ? picked.label : "More"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label="More filters" className="absolute right-0 top-full z-20 mt-1.5 flex w-40 flex-col rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitemradio"
              aria-checked={value === f.id}
              onClick={() => {
                onPick(f.id);
                setOpen(false);
              }}
              className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none hover:bg-muted focus-visible:bg-muted"
            >
              {f.dot && <span className="size-1.5 rounded-full" style={{ background: f.dot }} aria-hidden="true" />}
              {f.label}
              {value === f.id && (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ml-auto size-3.5">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A docs library sidebar. Sticky inside its column; give the column a height (e.g. h-[calc(100dvh-4rem)]). */
export function DocsSidebar({
  sections,
  current,
  filters = [],
  chips = 3,
  filter: filterProp,
  onFilterChange,
  onSearch,
  searchLeading,
  isMac,
  renderMark,
  storageKey,
  footer,
  linkAs: LinkAs = "a",
  label = "Library",
  emptyText = "Nothing in this filter.",
  className,
}: DocsSidebarProps) {
  const [ownFilter, setOwnFilter] = useState(filters[0]?.id ?? "");
  const filterId = filterProp ?? ownFilter;
  const navRef = useRef<HTMLElement>(null);
  const pick = (id: string) => {
    if (filterProp === undefined) setOwnFilter(id);
    onFilterChange?.(id);
    navRef.current?.scrollTo({ top: 0 });
  };

  const [open, setOpen] = useState<Set<string>>(() => new Set(loadJSON<string[] | null>(storageKey, null) ?? docsOpenKeys(sections, current)));
  // The current page opens its section and category.
  const auto = docsOpenKeys(sections, current).join("|");
  useEffect(() => {
    if (!auto) return;
    setOpen((o) => (auto.split("|").every((k) => o.has(k)) ? o : new Set([...o, ...auto.split("|")])));
  }, [auto]);
  useEffect(() => saveJSON(storageKey, [...open]), [open, storageKey]);

  // Keep the current page in view once its category has finished opening.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const nav = navRef.current;
      const row = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!nav || !row) return;
      const a = row.getBoundingClientRect();
      const b = nav.getBoundingClientRect();
      if (a.top < b.top || a.bottom > b.bottom) nav.scrollTop += a.top - b.top - b.height / 3;
    }, 260);
    return () => window.clearTimeout(t);
  }, [current]);

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const active = filters.find((f) => f.id === filterId);
  const visible = active ? filterSections(sections, active.match) : sections;
  const isOpen = (key: string) => Boolean(active?.expand) || open.has(key);
  const mark = renderMark ?? ((p: DocsPage) => <DocsMark page={p} />);
  const chipList = filters.slice(0, chips);
  const more = filters.slice(chips);

  return (
    <div className={cn("flex h-full min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {(onSearch || searchLeading || filters.length > 0) && (
        <div className="flex shrink-0 flex-col gap-2 pb-3 pr-3.5">
          {(onSearch || searchLeading) && (
            <div className="flex items-center gap-1.5">
              {searchLeading}
              {onSearch && (
                <button
                  type="button"
                  onClick={onSearch}
                  className="flex h-9 w-full min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-2.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="size-3.5">
                    <circle cx="7" cy="7" r="4.5" />
                    <path d="M10.5 10.5L13.5 13.5" />
                  </svg>
                  Search
                  <span className="ml-auto flex gap-0.5">
                    <Kbd size="sm">{isMac ? "⌘" : "Ctrl"}</Kbd>
                    <Kbd size="sm">K</Kbd>
                  </span>
                </button>
              )}
            </div>
          )}
          {filters.length > 1 && (
            <div className="flex h-7 items-center gap-0.5 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-0.5">
              <div role="radiogroup" aria-label="Show" className="flex gap-0.5" style={{ flex: chipList.length }}>
                {chipList.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={filterId === f.id}
                    onClick={() => pick(f.id)}
                    className={cn(
                      "h-6 flex-1 rounded-lg px-1.5 text-[11.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      filterId === f.id ? "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {more.length > 0 && <MoreFilter filters={more} value={filterId} onPick={pick} />}
            </div>
          )}
        </div>
      )}

      <nav ref={navRef} aria-label={label} className="kn-scroll-auto min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2 pb-3">
        <div className="flex flex-col gap-1.5">
          {visible.map((s) => {
            const id = idFor(s.id);
            const sOpen = isOpen(s.id);
            const on = current === s.id;
            const head = (
              <>
                {s.icon && <span className="grid size-4 place-items-center text-muted-foreground [&>svg]:size-3.5">{s.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {(s.count ?? Boolean(s.categories)) && <Count n={liveCount(pagesOf(s))} />}
              </>
            );
            const headClass = "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-[13px] font-semibold text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10";
            return (
              <div key={s.id}>
                <div className={cn("flex items-center gap-0.5 rounded-lg", on && ON)}>
                  {s.href ? (
                    <LinkAs href={s.href} aria-current={on ? "page" : undefined} className={headClass}>
                      {head}
                    </LinkAs>
                  ) : (
                    <span className={headClass}>{head}</span>
                  )}
                  <FoldButton open={sOpen} label={s.label} controls={id} onToggle={() => toggle(s.id)} />
                </div>
                <Collapse id={id} open={sOpen}>
                  <div className={cn("flex flex-col gap-px pl-1", s.categories?.length && "py-0.5")}>
                    {s.pages && s.pages.length > 0 && <Pages pages={s.pages} current={current} mark={mark} LinkAs={LinkAs} />}
                    {s.categories?.map((c) => {
                      const key = `${s.id}/${c.id}`;
                      const cid = idFor(key);
                      const cOpen = isOpen(key);
                      const cOn = current === c.id;
                      const inner = (
                        <>
                          <span className="min-w-0 flex-1 truncate">{c.label}</span>
                          <Count n={liveCount(c.pages)} />
                        </>
                      );
                      const cClass = "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-[12.5px] font-medium text-foreground/90 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10";
                      return (
                        <div key={c.id}>
                          <div className={cn("flex h-7 items-center gap-0.5 rounded-lg pointer-coarse:h-10", cOn && ON)}>
                            <FoldButton open={cOpen} label={c.label} controls={cid} onToggle={() => toggle(key)} className="ml-0.5" />
                            {c.href ? (
                              <LinkAs href={c.href} aria-current={cOn ? "page" : undefined} className={cClass}>
                                {inner}
                              </LinkAs>
                            ) : (
                              <span className={cClass}>{inner}</span>
                            )}
                          </div>
                          <Collapse id={cid} open={cOpen}>
                            <Pages pages={c.pages} current={current} mark={mark} LinkAs={LinkAs} />
                          </Collapse>
                        </div>
                      );
                    })}
                  </div>
                </Collapse>
              </div>
            );
          })}
          {visible.length === 0 && <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{emptyText}</p>}
        </div>
      </nav>

      {footer && <div className="mt-1 mr-3.5 shrink-0">{footer}</div>}
    </div>
  );
}
