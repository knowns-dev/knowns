"use client";
/** @registry name="data-table" type="ui" title="Data table" description="A real <table> with multi-sort, filters and search, range selection, column visibility, density, pagination or virtualised rows." */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { Input } from "../input";
import { Menu, type MenuItem } from "../menu";
import { SegmentedControl } from "../segmented-control";
import { Skeleton } from "../skeleton";
import {
  ROW_HEIGHT,
  ariaSort,
  filterRows,
  headerState,
  paginate,
  selectRange,
  sortRows,
  toggleId,
  toggleShown,
  toggleSort,
  visibleWindow,
  type Density,
  type SortRule,
} from "./table-utils";

export type { Density, SortRule } from "./table-utils";

export interface DataColumn<T> {
  id: string;
  header: ReactNode;
  /** The column's value: a key of the row or a function. Used to sort, search and filter. */
  accessor?: keyof T | ((row: T) => unknown);
  /** Custom cell. Default: the value as text. */
  cell?: (row: T) => ReactNode;
  align?: "start" | "center" | "end";
  /** CSS width, e.g. 120 or "30%". */
  width?: number | string;
  sortable?: boolean;
  /** Custom order for this column. */
  compare?: (a: T, b: T) => number;
  /** Show a filter field for this column in the filter row. Default true when the filter row is on. */
  filterable?: boolean;
  /** Include in the search. Default true. */
  searchable?: boolean;
  /** Can be hidden from the Columns menu. Default true. */
  hideable?: boolean;
  /** Hidden at first. */
  defaultHidden?: boolean;
  /** Label in the Columns menu and filter placeholder when `header` is not text. */
  label?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: DataColumn<T>[];
  /** Stable id per row (selection, keys). */
  getRowId: (row: T) => string;
  /** Visible title above the table; also names it. */
  title?: ReactNode;
  /** The title's element, to fit the page's heading outline. Default "h3"; "div" for no heading. */
  titleAs?: "h2" | "h3" | "h4" | "div";
  "aria-label"?: string;
  /** Sort rules, controlled. Shift-click a header adds a rule. */
  sort?: SortRule[];
  defaultSort?: SortRule[];
  onSortChange?: (sort: SortRule[]) => void;
  /** Checkbox column; Shift-click selects a range. */
  selectable?: boolean;
  selected?: string[];
  defaultSelected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  /** Search field in the toolbar. Default true. */
  search?: boolean;
  /** A row of per-column filter fields under the header. Default false. */
  filterRow?: boolean;
  /** Rows per page, or false for one scrolling list (virtualised above `virtualizeAbove`). Default 25. */
  pageSize?: number | false;
  pageSizes?: number[];
  /** Above this many rows (with pageSize false) only rows in view are rendered. Default 200. */
  virtualizeAbove?: number;
  /** Scroll height of the body when paging is off. Default 480. */
  maxHeight?: number;
  density?: Density;
  defaultDensity?: Density;
  onDensityChange?: (d: Density) => void;
  /** Show the density switch and the Columns menu. Default true. */
  controls?: boolean;
  loading?: boolean;
  /** Shown when there are no rows (or none match). */
  empty?: ReactNode;
  /** Extra toolbar content on the right (e.g. a primary action, or actions for the selection). */
  toolbar?: ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
}

const HAIR = "[border-color:color-mix(in_srgb,var(--foreground)_8%,transparent)]";
const SURFACE = cn(
  "flex flex-col rounded-2xl border bg-card text-[13px] text-card-foreground",
  HAIR,
  "shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_5%,transparent),0_1px_2px_rgb(0_0_0/0.04)]",
  "dark:[background:color-mix(in_srgb,var(--card)_70%,#000)] dark:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_7%,transparent)]",
);
const ALIGN = { start: "text-left", center: "text-center", end: "text-right" } as const;
const JUSTIFY = { start: "justify-start", center: "justify-center", end: "justify-end" } as const;
const DENSITIES = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Roomy" },
];

const SortGlyph = ({ dir }: { dir: "ascending" | "descending" | "none" }) => (
  <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3 flex-none", dir === "none" ? "opacity-0 group-hover:opacity-40 group-focus-visible:opacity-40" : "opacity-80")} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {dir === "descending" ? <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" /> : <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />}
  </svg>
);
const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.5 10.5l3 3" />
  </svg>
);
const ColumnsGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <rect x="2.5" y="3" width="11" height="10" rx="2" />
    <path d="M6.25 3v10M9.75 3v10" />
  </svg>
);

const textOf = (n: ReactNode, fallback: string) => (typeof n === "string" || typeof n === "number" ? String(n) : fallback);

/**
 * A table for real data, no external library: sortable headers (Shift for multi-sort), search and an
 * optional per-column filter row, checkbox selection with Shift-click ranges, paging or a virtualised
 * scroll for long lists, a sticky header, density, and a Columns menu to hide columns. Loading and empty
 * states are built in. It stays a real <table> (aria-sort, aria-rowcount / aria-rowindex when virtualised).
 */
export function DataTable<T>({
  rows,
  columns,
  getRowId,
  title,
  titleAs: TitleTag = "h3",
  "aria-label": ariaLabel,
  sort: sortProp,
  defaultSort = [],
  onSortChange,
  selectable = false,
  selected: selectedProp,
  defaultSelected = [],
  onSelectedChange,
  search = true,
  filterRow = false,
  pageSize: pageSizeProp = 25,
  pageSizes = [10, 25, 50, 100],
  virtualizeAbove = 200,
  maxHeight = 480,
  density: densityProp,
  defaultDensity = "default",
  onDensityChange,
  controls = true,
  loading = false,
  empty,
  toolbar,
  onRowClick,
  className,
}: DataTableProps<T>) {
  const id = useId();
  const titleId = `${id}-title`;

  /* State: controlled or internal. */
  const [ownSort, setOwnSort] = useState(defaultSort);
  const sort = sortProp ?? ownSort;
  const setSort = (s: SortRule[]) => {
    if (sortProp === undefined) setOwnSort(s);
    onSortChange?.(s);
  };
  const [ownSel, setOwnSel] = useState(defaultSelected);
  const selected = selectedProp ?? ownSel;
  const setSelected = (s: string[]) => {
    if (selectedProp === undefined) setOwnSel(s);
    onSelectedChange?.(s);
  };
  const [ownDensity, setOwnDensity] = useState(defaultDensity);
  const density = densityProp ?? ownDensity;
  const setDensity = (d: Density) => {
    if (densityProp === undefined) setOwnDensity(d);
    onDensityChange?.(d);
  };
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)));
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(pageSizeProp === false ? 0 : pageSizeProp);
  const paged = pageSizeProp !== false;

  /* Pipeline: filter → sort → page / window. */
  const valueOf = useMemo(() => {
    const m = new Map<string, (row: T) => unknown>();
    for (const c of columns) {
      const a = c.accessor;
      m.set(c.id, typeof a === "function" ? (a as (row: T) => unknown) : a !== undefined ? (row: T) => row[a as keyof T] : () => undefined);
    }
    return m;
  }, [columns]);
  const colDefs = useMemo(() => columns.map((c) => ({ id: c.id, value: valueOf.get(c.id)!, searchable: c.searchable, compare: c.compare })), [columns, valueOf]);
  const filtered = useMemo(() => filterRows(rows, { search: query, filters, columns: colDefs.filter((c) => !hidden.has(c.id)) }), [rows, query, filters, colDefs, hidden]);
  const sorted = useMemo(() => sortRows(filtered, sort, colDefs), [filtered, sort, colDefs]);
  const pg = paged ? paginate(sorted, page, size) : null;
  useEffect(() => setPage(0), [query, filters, size]);
  const pageRows = pg ? pg.rows : sorted;

  const virtual = !paged && sorted.length > virtualizeAbove;
  const rowH = ROW_HEIGHT[density];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(maxHeight);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || maxHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxHeight]);
  const win = virtual ? visibleWindow(sorted.length, rowH, scrollTop, viewH) : { start: 0, end: pageRows.length, before: 0, after: 0 };
  const shownRows = virtual ? sorted.slice(win.start, win.end) : pageRows;
  const rowIndexBase = pg ? pg.from - 1 : win.start;

  /* Selection. Shift ranges use display order across the filtered + sorted rows. */
  const order = useMemo(() => sorted.map(getRowId), [sorted, getRowId]);
  const shownIds = useMemo(() => (paged ? pageRows.map(getRowId) : order), [paged, pageRows, order, getRowId]);
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  const head = headerState(selected, shownIds);
  const onRowCheck = (rid: string) => {
    setSelected(shift.current ? selectRange(selected, order, anchor.current, rid) : toggleId(selected, rid));
    anchor.current = rid;
    shift.current = false;
  };
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visibleCols = columns.filter((c) => !hidden.has(c.id));
  const colCount = visibleCols.length + (selectable ? 1 : 0);
  const anyFilter = filterRow && visibleCols.some((c) => c.filterable !== false);

  const columnItems: MenuItem[] = columns
    .filter((c) => c.hideable !== false)
    .map((c) => ({ id: c.id, label: c.label ?? textOf(c.header, c.id), kind: "switch", checked: !hidden.has(c.id), textValue: c.label ?? textOf(c.header, c.id) }));

  const onHeaderClick = (c: DataColumn<T>, e: MouseEvent) => setSort(toggleSort(sort, c.id, e.shiftKey));

  const cellPad = density === "compact" ? "px-3" : "px-4";
  const total = rows.length;
  const status = loading ? "Loading…" : filtered.length === total ? `${total} ${total === 1 ? "row" : "rows"}` : `${filtered.length} of ${total} rows`;

  const stickyHead = "sticky top-0 z-[2] bg-card dark:[background:color-mix(in_srgb,var(--card)_70%,#000)]";

  return (
    <div role="region" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : ariaLabel} className={cn(SURFACE, className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
        {title && (
          <TitleTag id={titleId} className="mr-1 text-[14px] font-semibold tracking-tight max-sm:order-1">
            {title}
          </TitleTag>
        )}
        <span className="text-[12px] text-muted-foreground tabular-nums max-sm:order-1" aria-live="polite">
          {status}
          {selectable && selected.length > 0 && ` · ${selected.length} selected`}
        </span>
        <span className="flex-1 max-sm:order-1" />
        {search && (
          <span className="max-w-full max-sm:order-2 max-sm:min-w-0 max-sm:flex-1 sm:w-52">
            <Input size="sm" type="search" icon={<SearchGlyph />} placeholder="Search" aria-label="Search rows" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
        )}
        {controls && <SegmentedControl className="max-sm:order-2" size="sm" aria-label="Row density" options={DENSITIES} value={density} onValueChange={(v) => setDensity(v as Density)} />}
        {controls && columnItems.length > 0 && (
          <span className="max-sm:order-1">
          <Menu
            aria-label="Columns"
            align="end"
            items={columnItems}
            onSelect={(item) =>
              setHidden((h) => {
                const n = new Set(h);
                if (n.has(item.id)) n.delete(item.id);
                // Keep at least one column.
                else if (columns.length - n.size > 1) n.add(item.id);
                return n;
              })
            }
            trigger={
              <Button size="sm" variant="secondary" icon={<ColumnsGlyph />}>
                Columns
              </Button>
            }
          />
          </span>
        )}
        {toolbar && <span className="max-sm:order-2">{toolbar}</span>}
      </div>

      {/* Table */}
      <div
        ref={scrollRef}
        onScroll={(e) => virtual && setScrollTop(e.currentTarget.scrollTop)}
        className={cn("kn-scroll kn-scroll-fade-x relative overflow-auto border-t", HAIR, !pg && "rounded-b-2xl")}
        style={!paged ? { maxHeight } : undefined}
      >
        <table aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : ariaLabel} aria-rowcount={virtual ? sorted.length + 1 : undefined} aria-busy={loading || undefined} className="w-full border-separate border-spacing-0 text-[13px]">
          <colgroup>
            {selectable && <col style={{ width: 44 }} />}
            {visibleCols.map((c) => (
              <col key={c.id} style={{ width: typeof c.width === "number" ? `${c.width}px` : c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={virtual ? 1 : undefined}>
              {selectable && (
                <th scope="col" className={cn(stickyHead, "border-b pl-4", HAIR)} style={{ height: 38 }}>
                  <Checkbox size="sm" aria-label={head.checked ? "Clear selection on this page" : "Select all shown rows"} checked={head.checked} indeterminate={head.indeterminate} onChange={() => setSelected(toggleShown(selected, shownIds))} />
                </th>
              )}
              {visibleCols.map((c) => {
                const dir = ariaSort(sort, c.id);
                const rank = sort.length > 1 ? sort.findIndex((r) => r.id === c.id) + 1 : 0;
                const align = c.align ?? "start";
                return (
                  <th key={c.id} scope="col" aria-sort={c.sortable ? dir : undefined} className={cn(stickyHead, "border-b text-[12px] font-medium whitespace-nowrap text-muted-foreground", ALIGN[align], cellPad, HAIR)} style={{ height: 38 }}>
                    {c.sortable ? (
                      <button
                        type="button"
                        onClick={(e) => onHeaderClick(c, e)}
                        title="Click to sort, Shift-click to add a sort"
                        className={cn("group -mx-1.5 inline-flex items-center gap-1 rounded-[6px] px-1.5 py-1 hover:text-foreground", JUSTIFY[align], dir !== "none" && "text-foreground", focusRing)}
                      >
                        {align === "end" && <SortGlyph dir={dir} />}
                        {c.header}
                        {align !== "end" && <SortGlyph dir={dir} />}
                        {rank > 0 && <span className="text-[10px] tabular-nums text-muted-foreground">{rank}</span>}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
            {anyFilter && (
              <tr>
                {selectable && <th className={cn(stickyHead, "top-[38px] border-b", HAIR)} />}
                {visibleCols.map((c) => (
                  <th key={c.id} className={cn(stickyHead, "top-[38px] border-b py-1.5 font-normal", cellPad, HAIR)}>
                    {c.filterable !== false && (
                      <Input
                        size="sm"
                        aria-label={`Filter ${c.label ?? textOf(c.header, c.id)}`}
                        placeholder="Filter"
                        value={filters[c.id] ?? ""}
                        onChange={(e) => setFilters((f) => ({ ...f, [c.id]: e.target.value }))}
                      />
                    )}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: Math.min(paged ? size : 8, 8) }, (_, i) => (
                <tr key={`sk${i}`} aria-hidden>
                  {selectable && <td className={cn("border-b pl-4", HAIR)} style={{ height: rowH }} />}
                  {visibleCols.map((c) => (
                    <td key={c.id} className={cn("border-b", cellPad, HAIR)} style={{ height: rowH }}>
                      <Skeleton className={cn("h-3", c.align === "end" ? "ml-auto w-12" : "w-3/5")} />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && shownRows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-12 text-center text-[13px] text-muted-foreground">
                  {empty ?? (query || Object.values(filters).some(Boolean) ? "No rows match." : "No rows yet.")}
                </td>
              </tr>
            )}
            {!loading && virtual && win.before > 0 && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: win.before, padding: 0 }} />
              </tr>
            )}
            {!loading &&
              shownRows.map((row, i) => {
                const rid = getRowId(row);
                const sel = selectedSet.has(rid);
                const style: CSSProperties = { height: rowH };
                return (
                  <tr
                    key={rid}
                    aria-rowindex={virtual ? rowIndexBase + i + 2 : undefined}
                    aria-selected={selectable ? sel : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "group/row transition-colors duration-100",
                      "hover:bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)]",
                      sel && "bg-[color-mix(in_srgb,var(--ring)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--ring)_11%,transparent)]",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {selectable && (
                      <td
                        className={cn("border-b pl-4 group-last/row:border-b-0", HAIR)}
                        style={style}
                        onClickCapture={(e) => (shift.current = e.shiftKey)}
                        onKeyDownCapture={(e) => (shift.current = e.shiftKey)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox size="sm" aria-label={`Select row ${rowIndexBase + i + 1}`} checked={sel} onChange={() => onRowCheck(rid)} />
                      </td>
                    )}
                    {visibleCols.map((c) => (
                      <td key={c.id} className={cn("border-b whitespace-nowrap group-last/row:border-b-0", ALIGN[c.align ?? "start"], c.align === "end" && "tabular-nums", cellPad, HAIR)} style={style}>
                        {c.cell ? c.cell(row) : String(valueOf.get(c.id)!(row) ?? "")}
                      </td>
                    ))}
                  </tr>
                );
              })}
            {!loading && virtual && win.after > 0 && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: win.after, padding: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pg && (
        <div className={cn("flex flex-wrap items-center gap-3 rounded-b-2xl border-t px-4 py-2.5 text-[12.5px] text-muted-foreground", HAIR)}>
          <span className="tabular-nums">{sorted.length ? `${pg.from}–${pg.to} of ${sorted.length}` : "0 rows"}</span>
          <label className="flex items-center gap-1.5">
            Rows
            <select
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className={cn("h-7 rounded-[7px] bg-card px-1.5 text-[12.5px] text-foreground shadow-[0_0_0_1px_var(--border)]", focusRing)}
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="flex-1" />
          <span className="tabular-nums">
            Page {pg.page + 1} of {pg.pageCount}
          </span>
          <Button size="sm" variant="secondary" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} aria-label="Previous page">
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={pg.page >= pg.pageCount - 1} onClick={() => setPage(pg.page + 1)} aria-label="Next page">
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export default DataTable;
