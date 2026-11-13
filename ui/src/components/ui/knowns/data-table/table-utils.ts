export interface SortRule {
  id: string;
  desc: boolean;
}

/**
 * Click on a sortable header: ascending → descending → off. Without `multi` the column becomes the only
 * rule; with `multi` (Shift) it is added or cycled in place and the other rules stay.
 */
export function toggleSort(rules: SortRule[], id: string, multi = false): SortRule[] {
  const cur = rules.find((r) => r.id === id);
  const next: SortRule | null = !cur ? { id, desc: false } : !cur.desc ? { id, desc: true } : null;
  if (!multi) return next ? [next] : [];
  if (!cur) return [...rules, next!];
  return next ? rules.map((r) => (r.id === id ? next : r)) : rules.filter((r) => r.id !== id);
}

/** Natural comparison: numbers by value, dates by time, strings with locale + numeric collation, empty last. */
export function compareValues(a: unknown, b: unknown): number {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (empty(a) || empty(b)) return empty(a) && empty(b) ? 0 : empty(a) ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export interface SortableColumn<T> {
  id: string;
  value: (row: T) => unknown;
  compare?: (a: T, b: T) => number;
}

/** Stable multi-column sort. Empty values stay last in both directions. */
export function sortRows<T>(rows: T[], rules: SortRule[], columns: SortableColumn<T>[]): T[] {
  const active = rules.map((r) => ({ r, c: columns.find((c) => c.id === r.id) })).filter((x): x is { r: SortRule; c: SortableColumn<T> } => !!x.c);
  if (!active.length) return rows;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      for (const { r, c } of active) {
        const va = c.value(x.row);
        const vb = c.value(y.row);
        const emptyA = va === null || va === undefined || va === "";
        const emptyB = vb === null || vb === undefined || vb === "";
        if (emptyA !== emptyB) return emptyA ? 1 : -1;
        const d = c.compare ? c.compare(x.row, y.row) : compareValues(va, vb);
        if (d) return r.desc ? -d : d;
      }
      return x.i - y.i;
    })
    .map((x) => x.row);
}

const text = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v)).toLowerCase();

/** Rows where every column filter matches its column, and the search matches any searchable column. */
export function filterRows<T>(rows: T[], opts: { search?: string; filters?: Record<string, string>; columns: { id: string; value: (row: T) => unknown; searchable?: boolean }[] }): T[] {
  const q = (opts.search ?? "").trim().toLowerCase();
  const filters = Object.entries(opts.filters ?? {}).map(([id, v]) => [id, v.trim().toLowerCase()] as const).filter(([, v]) => v);
  if (!q && !filters.length) return rows;
  const byId = new Map(opts.columns.map((c) => [c.id, c]));
  const searchable = opts.columns.filter((c) => c.searchable !== false);
  return rows.filter((row) => {
    for (const [id, v] of filters) {
      const c = byId.get(id);
      if (c && !text(c.value(row)).includes(v)) return false;
    }
    return !q || searchable.some((c) => text(c.value(row)).includes(q));
  });
}

/** Toggle one id. */
export function toggleId(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/**
 * Shift-click: set every row between the anchor and `id` (in display order) to the state the clicked row
 * gets. With no anchor (or the anchor no longer shown) it is a plain toggle.
 */
export function selectRange(selected: string[], order: string[], anchor: string | null, id: string): string[] {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a === -1 || b === -1) return toggleId(selected, id);
  const on = !selected.includes(id);
  const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  const set = new Set(selected);
  for (const x of span) on ? set.add(x) : set.delete(x);
  return [...set];
}

/** The header checkbox: checked when every shown row is selected, mixed when some are. */
export function headerState(selected: string[], shown: string[]): { checked: boolean; indeterminate: boolean } {
  if (!shown.length) return { checked: false, indeterminate: false };
  const s = new Set(selected);
  const n = shown.filter((id) => s.has(id)).length;
  return { checked: n === shown.length, indeterminate: n > 0 && n < shown.length };
}

/** Header checkbox click: select every shown row, or clear them if all were selected. Rows not shown keep their state. */
export function toggleShown(selected: string[], shown: string[]): string[] {
  const { checked } = headerState(selected, shown);
  const set = new Set(selected);
  for (const id of shown) checked ? set.delete(id) : set.add(id);
  return [...set];
}

/** One page of rows, with the page clamped into range. */
export function paginate<T>(rows: T[], page: number, size: number): { rows: T[]; page: number; pageCount: number; from: number; to: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / Math.max(1, size)));
  const p = Math.min(Math.max(0, page), pageCount - 1);
  const from = p * size;
  const slice = rows.slice(from, from + size);
  return { rows: slice, page: p, pageCount, from: rows.length ? from + 1 : 0, to: from + slice.length };
}

/** Rows in view for fixed-height rows (+ overscan), with the spacer heights above and below. */
export function visibleWindow(count: number, rowH: number, scrollTop: number, viewH: number, overscan = 8) {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewH) / rowH) + overscan);
  return { start, end, before: start * rowH, after: Math.max(0, (count - end) * rowH) };
}

export type Density = "compact" | "default" | "comfortable";
export const ROW_HEIGHT: Record<Density, number> = { compact: 32, default: 40, comfortable: 48 };

/** aria-sort for a column. */
export function ariaSort(rules: SortRule[], id: string): "ascending" | "descending" | "none" {
  const r = rules.find((x) => x.id === id);
  return !r ? "none" : r.desc ? "descending" : "ascending";
}
