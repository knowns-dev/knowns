// Task summaries, one stable order and cursor pagination, shared by MCP `tasks list`/`board` and
// GET /api/tasks (KN-6DVWN6, KN-F1DQ03). Filters apply before the page is cut.
import type { Task } from "../../models/task.ts";

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

/** The UI order: `order` (unset last), then id. MCP keeps the storage order agents already saw. */
export function compareTasks(a: Task, b: Task): number {
  if (a.order !== undefined || b.order !== undefined) {
    if (a.order === undefined) return 1;
    if (b.order === undefined) return -1;
    if (a.order !== b.order) return a.order - b.order;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface TaskPage<T> {
  items: T[];
  total: number;
  limit: number;
  nextCursor?: string;
}

/** The cursor is the offset into the filtered, sorted list, wrapped so callers treat it as opaque. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o${offset}`).toString("base64url");
}

export function decodeCursor(cursor: string): number | undefined {
  try {
    const s = Buffer.from(cursor, "base64url").toString();
    if (!/^o\d+$/.test(s)) return undefined;
    return Number(s.slice(1));
  } catch {
    return undefined;
  }
}

/** Clamp a caller supplied limit to [1, MAX_PAGE_SIZE]; unset or invalid means `fallback`. */
export function clampLimit(raw: unknown, fallback: number = DEFAULT_PAGE_SIZE): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(Math.floor(raw), MAX_PAGE_SIZE);
}

/** Optionally sort, then cut one page starting at the cursor. A bad cursor returns { error }. */
export function pageTasks(
  tasks: Task[],
  limit: number,
  cursor: string | undefined,
  compare?: (a: Task, b: Task) => number,
): TaskPage<Task> | { error: string } {
  let start = 0;
  if (cursor) {
    const off = decodeCursor(cursor);
    if (off === undefined)
      return { error: "cursor is not valid; use the nextCursor of a previous call" };
    start = off;
  }
  const sorted = compare ? [...tasks].sort(compare) : tasks;
  const items = sorted.slice(start, start + limit);
  const page: TaskPage<Task> = { items, total: sorted.length, limit };
  if (start + limit < sorted.length) page.nextCursor = encodeCursor(start + limit);
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

export function matchesQuery(t: Task, q: TaskQuery): boolean {
  const assignee = (t.assignee ?? "").trim();
  if (q.status && t.status !== q.status) return false;
  if (q.priority && t.priority !== q.priority) return false;
  if (q.assignee && assignee !== q.assignee) return false;
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
