// Task summaries, one stable order and cursor pagination, shared by MCP `tasks list`/`board` and
// GET /api/tasks (KN-6DVWN6, KN-F1DQ03). Filters apply before the page is cut.
import type { Task } from "../../models/task.ts";
import { goTrimSpace } from "../../storage/core/util.ts";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_COLUMN_PAGE_SIZE = 20;

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee?: string;
  labels: string[];
  parent?: string;
  order?: number;
  updatedAt: string;
  /** Which agent holds the task (KN-4FQN0P), when one does. */
  workedBy?: Task["workedBy"];
}

/** The small shape agents and list views need; everything else stays on `tasks get`. */
export function taskSummary(t: Task): TaskSummary {
  const out: TaskSummary = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    labels: t.labels ?? [],
    updatedAt: t.updatedAt,
  };
  if (t.assignee) out.assignee = t.assignee;
  if (t.parent) out.parent = t.parent;
  if (t.order !== undefined) out.order = t.order;
  if (t.workedBy) out.workedBy = t.workedBy;
  return out;
}

/** A sort key: a tuple of numbers and strings compared left to right. */
export type SortKey = Array<string | number>;

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** MCP key: the task id, the order storage lists tasks in. */
export const idKey = (t: Task): SortKey => [t.id];

/** UI key: `order` (unset last), then id. */
export const orderKey = (t: Task): SortKey => [t.order === undefined ? 1 : 0, t.order ?? 0, t.id];

export interface TaskPage<T> {
  items: T[];
  total: number;
  limit: number;
  nextCursor?: string;
}

/** Legacy cursor: an offset into the filtered list. Kept for the `offset` argument and old tokens. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o${offset}`).toString("base64url");
}

/** Keyset cursor: the key of the last item served. The next page is whatever sorts after it, so
 *  tasks that leave the filter (marked done) or arrive between pages do not shift it. */
export function encodeKeyCursor(key: SortKey): string {
  return Buffer.from(`a${JSON.stringify(key)}`).toString("base64url");
}

export type Cursor = { offset: number } | { after: SortKey };

export function decodeCursor(cursor: string): Cursor | undefined {
  try {
    const s = Buffer.from(cursor, "base64url").toString();
    if (/^o\d+$/.test(s)) return { offset: Number(s.slice(1)) };
    if (s.startsWith("a")) {
      const key: unknown = JSON.parse(s.slice(1));
      if (
        Array.isArray(key) &&
        key.length > 0 &&
        key.every((k) => typeof k === "string" || typeof k === "number")
      )
        return { after: key as SortKey };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** A limit in [1, MAX_PAGE_SIZE]. Unset means `fallback`; a numeric string is accepted; anything
 *  else is an error, so a client is told instead of silently getting the default. */
export function parseLimit(
  raw: unknown,
  fallback: number = DEFAULT_PAGE_SIZE,
): number | { error: string } {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
    return { error: "limit must be a positive integer" };
  return Math.min(n, MAX_PAGE_SIZE);
}

/** Sort by `keyOf`, then cut one page after the cursor. A bad cursor returns { error }. */
export function pageTasks(
  tasks: Task[],
  limit: number,
  cursor: string | undefined,
  keyOf: (t: Task) => SortKey,
): TaskPage<Task> | { error: string } {
  const keyed = tasks.map((t) => ({ t, k: keyOf(t) }));
  keyed.sort((x, y) => compareKeys(x.k, y.k));
  let start = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c === undefined)
      return { error: "cursor is not valid; use the nextCursor of a previous call" };
    if ("offset" in c) start = c.offset;
    else {
      const after = c.after;
      start = keyed.findIndex((x) => compareKeys(x.k, after) > 0);
      if (start < 0) start = keyed.length;
    }
  }
  const slice = keyed.slice(start, start + limit);
  const page: TaskPage<Task> = { items: slice.map((x) => x.t), total: keyed.length, limit };
  const last = slice[slice.length - 1];
  if (last && start + limit < keyed.length) page.nextCursor = encodeKeyCursor(last.k);
  return page;
}

export interface TaskQuery {
  status?: string;
  priority?: string;
  assignee?: string;
  unassigned?: boolean;
  label?: string;
  spec?: string;
  parent?: string;
  /** Case-insensitive substring of the title or description. */
  query?: string;
}

/** The one filter REST and MCP share. The assignee is trimmed like the CLI and UI: a
 *  whitespace-only assignee is unassigned (D13). */
export function matchesQuery(t: Task, q: TaskQuery): boolean {
  const assignee = goTrimSpace(t.assignee ?? "");
  if (q.status && t.status !== q.status) return false;
  if (q.priority && t.priority !== q.priority) return false;
  if (q.assignee && assignee !== goTrimSpace(q.assignee)) return false;
  if (q.unassigned && assignee !== "") return false;
  if (q.label && !(t.labels ?? []).includes(q.label)) return false;
  if (q.spec && (t.spec ?? "") !== q.spec) return false;
  if (q.parent && (t.parent ?? "") !== q.parent) return false;
  if (q.query) {
    const needle = q.query.toLowerCase();
    if (
      !t.title.toLowerCase().includes(needle) &&
      !(t.description ?? "").toLowerCase().includes(needle)
    )
      return false;
  }
  return true;
}
