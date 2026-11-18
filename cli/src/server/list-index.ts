// A long-lived index of the task and doc lists for the server process (KN-1E9BJ9).
//
// GET /api/tasks and GET /api/docs used to read and parse every .md file on every request, even
// with limit=50. The index keeps the parsed entities and the sorted views a page needs, so a page
// costs the page, not the store:
//
//  - Parsing is the shared StatCache of the stores (a file whose stat is unchanged is never
//    reread), so a rescan that finds nothing new returns the very same frozen objects.
//  - A scan is skipped altogether while the directories are provably unchanged (DirFreshness: the
//    directory signature under the racy-timestamp rule, a watcher, and a maximum age). A write by
//    the CLI, MCP, another process or this one changes a directory mtime, so it is seen on the
//    next request; inside the racy window every request rescans (a stat pass, no rereads) rather
//    than trust a timestamp that may not have ticked.
//  - Sorted views (by status, per sort) are rebuilt only when a scan returned different objects.
//  - A scan that had to skip a file (Windows rename retries, a half-written file) is never
//    committed as fresh: the next request scans again, and meanwhile the entry from the scan
//    before stays in the list (a file that vanishes between readdir and read is a rename or a
//    replace far more often than a delete; the next scan confirms or refutes it). So the counts
//    and the list do not dip while an external writer renames files.
//
// Paging guarantee. A cursor is the sort key of the last item served, never a position, so a
// rebuild of the index between two pages cannot shift the next page. With sort=updated-desc the
// key is (updatedAt, id) and an update only moves a task to the top, before every cursor: inside
// one traversal an id is returned at most once (a task updated meanwhile may be missed by that
// traversal; the client sees it through the tasks:updated event). With sort=order the key is
// (lifecycle, order, id); a task whose status or order changes mid-traversal can cross the cursor
// and be returned twice, so a client paging in that order dedupes by id.

import {
  compareKeys,
  decodeCursor,
  encodeKeyCursor,
  matchesQuery,
  orderKey,
  type SortKey,
  type TaskQuery,
} from "../domain/tasklifecycle/summary.ts";
import type { Doc } from "../models/doc.ts";
import type { Task } from "../models/task.ts";
import { taskLifecycleState } from "../models/task.ts";
import {
  DirFreshness,
  type FreshnessOptions,
  type KeptEntry,
  newScanState,
  type ScanState,
} from "../storage/core/dir-freshness.ts";
import { goTrimSpace } from "../storage/core/util.ts";
import type { DocScanTrack, DocStore } from "../storage/stores/doc-store.ts";
import { parseIso } from "../storage/stores/internal.ts";
import type { TaskStore } from "../storage/stores/task-store.ts";

export interface Entry<T> {
  item: T;
  key: SortKey;
}

export interface IndexPage<T> {
  items: T[];
  total: number;
  limit: number;
  nextCursor?: string;
}

/** First index whose key sorts after `after` (entries are sorted by key). */
function upperBound<T>(
  list: Entry<T>[],
  after: SortKey,
  cmp: (a: SortKey, b: SortKey) => number,
): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp((list[mid] as Entry<T>).key, after) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** One page of a sorted list, after a keyset (or legacy offset) cursor. */
export function pageEntries<T>(
  list: Entry<T>[],
  limit: number,
  cursor: string | undefined,
  pred?: (item: T) => boolean,
  cmp: (a: SortKey, b: SortKey) => number = compareKeys,
): IndexPage<T> | { error: string } {
  const rows = pred ? list.filter((e) => pred(e.item)) : list;
  let start = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c === undefined)
      return { error: "cursor is not valid; use the nextCursor of a previous call" };
    start = "offset" in c ? c.offset : upperBound(rows, c.after, cmp);
  }
  const slice = rows.slice(start, start + limit);
  const page: IndexPage<T> = { items: slice.map((e) => e.item), total: rows.length, limit };
  const last = slice[slice.length - 1];
  if (last && start + limit < rows.length) page.nextCursor = encodeKeyCursor(last.key);
  return page;
}

/**
 * Active and archived tasks in one list. The two directories are scanned at different moments, so
 * a task moved between them can be in both: it is listed once, as the copy with the later updatedAt
 * (the active one on a tie, like `listAll`).
 */
function withoutDuplicates(active: readonly Task[], archived: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const t of active) byId.set(t.id, t);
  for (const t of archived) {
    const have = byId.get(t.id);
    if (!have || updatedMs(t.updatedAt) > updatedMs(have.updatedAt)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

function sameObjects<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const updatedMs = (iso: string): number => parseIso(iso)?.ms ?? 0;

// ---- tasks ----------------------------------------------------------------------------------

function lifecycleRank(t: Task): number {
  const s = taskLifecycleState(t);
  return s === "active" ? 0 : s === "done" ? 1 : 2;
}

/** The key GET /api/tasks has always ordered by: lifecycle, then order (unset last), then id. */
export const lifecycleKey = (t: Task): SortKey => [lifecycleRank(t), ...orderKey(t)];

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function progressKey(t: Task): SortKey {
  const ac = t.acceptanceCriteria ?? [];
  if (ac.length === 0) return [1, 0, t.id];
  return [0, ac.filter((a) => a.completed).length / ac.length, t.id];
}

interface SortDef {
  /** A key that ends with the id, so the order is total and a cursor never repeats an id. */
  keyOf: (t: Task) => SortKey;
  /** Key[0] is a "has no value" flag: those tasks come last in both directions. */
  nullable?: true;
}

const SORT_DEFS: Record<string, SortDef> = {
  order: { keyOf: lifecycleKey },
  id: { keyOf: (t) => [t.id] },
  title: { keyOf: (t) => [t.title.toLowerCase(), t.id] },
  status: { keyOf: (t) => [t.status, t.id] },
  priority: { keyOf: (t) => [PRIORITY_RANK[t.priority] ?? 3, t.id] },
  assignee: {
    keyOf: (t) => {
      const a = goTrimSpace(t.assignee ?? "");
      return [a === "" ? 1 : 0, a.toLowerCase(), t.id];
    },
    nullable: true,
  },
  spec: { keyOf: (t) => [t.spec ? 0 : 1, t.spec ?? "", t.id], nullable: true },
  progress: { keyOf: progressKey, nullable: true },
  updated: { keyOf: (t) => [updatedMs(t.updatedAt), t.id] },
  created: { keyOf: (t) => [updatedMs(t.createdAt), t.id] },
};

export const TASK_SORT_KEYS = Object.keys(SORT_DEFS);

export interface TaskSortSpec {
  /** The value of `sort=`, normalized; also the cache key of its view. */
  name: string;
  keyOf: (t: Task) => SortKey;
  /** Compares two keys of this sort, direction included. */
  cmp: (a: SortKey, b: SortKey) => number;
}

/**
 * `sort=<key>` or `sort=<key>-desc` (empty is `order`). Every key ends with the task id.
 * A cursor is the key of the last task served, so a task whose key a write can move may be served
 * twice in one traversal: that is every key but id, created and created-desc (nothing rewrites
 * those) and updated-desc (an update only moves a task to the top, before every cursor).
 */
export function parseTaskSort(raw: string | null): TaskSortSpec | { error: string } {
  const name = raw === null || raw === "" ? "order" : raw;
  const desc = name.endsWith("-desc");
  const base = desc ? name.slice(0, -5) : name;
  const def = SORT_DEFS[base];
  if (def === undefined) {
    return {
      error: `sort must be one of: ${TASK_SORT_KEYS.join(", ")}; each also as <key>-desc`,
    };
  }
  const nullable = def.nullable === true;
  const cmp = (a: SortKey, b: SortKey): number => {
    let from = 0;
    if (nullable) {
      if (a[0] !== b[0]) return (a[0] as number) < (b[0] as number) ? -1 : 1;
      from = 1;
    }
    for (let i = from; i < Math.max(a.length, b.length); i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (x === undefined) return desc ? 1 : -1;
      if (y === undefined) return desc ? -1 : 1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  };
  return { name: desc ? `${base}-desc` : base, keyOf: def.keyOf, cmp };
}

export const TASK_LIFECYCLES = ["current", "active", "done", "archived", "all"] as const;
export type TaskLifecycle = (typeof TASK_LIFECYCLES)[number];

/** `lifecycle=`; without it includeHistorical=true means all and nothing means current. */
export function parseLifecycle(
  raw: string | null,
  includeHistorical: boolean,
): TaskLifecycle | { error: string } {
  if (raw === null || raw === "") return includeHistorical ? "all" : "current";
  return (TASK_LIFECYCLES as readonly string[]).includes(raw)
    ? (raw as TaskLifecycle)
    : { error: `lifecycle must be one of: ${TASK_LIFECYCLES.join(", ")}` };
}

/** current = active and done, not archived (what the list always showed). */
const lifecyclePred: Record<TaskLifecycle, ((t: Task) => boolean) | undefined> = {
  current: undefined,
  all: undefined,
  archived: undefined,
  active: (t) => t.status !== "done",
  done: (t) => t.status === "done",
};

/** TaskQuery; `parent: "none"` means root tasks only, any other parent is an id. */
export type ListFilter = TaskQuery;

/**
 * The server-side list filter. Like matchesQuery, with three differences the list UI needs: the
 * free-text `query` also matches the id, the assignee and the labels; `unassigned` wins over
 * `assignee`; and `parent=none` is the root tasks.
 */
export function matchesList(t: Task, f: ListFilter): boolean {
  const { query, parent, assignee, ...rest } = f;
  if (
    !matchesQuery(t, {
      ...rest,
      ...(f.unassigned ? {} : assignee !== undefined && { assignee }),
      ...(parent !== undefined && parent !== "none" && { parent }),
    })
  )
    return false;
  if (parent === "none" && (t.parent ?? "") !== "") return false;
  if (query) {
    const needle = query.toLowerCase();
    const hay = [t.id, t.title, t.description ?? "", t.assignee ?? "", ...(t.labels ?? [])];
    if (!hay.some((h) => h.toLowerCase().includes(needle))) return false;
  }
  return true;
}

type TaskSource = "current" | "archived" | "all";
const sourceOf = (l: TaskLifecycle): TaskSource =>
  l === "archived" ? "archived" : l === "all" ? "all" : "current";

interface TaskView {
  all: Entry<Task>[];
  byStatus: Map<string, Entry<Task>[]>;
}

class Part<T> {
  readonly fresh: DirFreshness;
  items: T[] | undefined;
  /** What the last scan read by path: the fallback when a file cannot be read mid-scan. */
  seen: ReadonlyMap<string, KeptEntry<T>> | undefined;
  version = 0;
  constructor(opts?: FreshnessOptions) {
    this.fresh = new DirFreshness(opts);
  }
}

export interface TaskCounts {
  total: number;
  byStatus: Record<string, number>;
}

export interface TaskCountsResult extends TaskCounts {
  /** Tasks of the lifecycle by assignee ("" is unassigned), under every filter but assignee and status. */
  byAssignee: Record<string, number>;
  /** The archived tasks that pass the filters. */
  archived: TaskCounts;
}

export class TaskIndex {
  private readonly active: Part<Task>;
  private readonly archived: Part<Task>;
  private views = new Map<string, TaskView>();
  private viewsAt = "";
  private countsMemo = new Map<string, TaskCountsResult>();
  /** Counts how many times a scan ran; the bench and tests read it. */
  scans = 0;

  constructor(
    private readonly store: TaskStore,
    opts?: FreshnessOptions,
  ) {
    this.active = new Part(opts);
    this.archived = new Part(opts);
  }

  /** A write by this process: the next request scans without waiting for the watcher. */
  invalidate(): void {
    this.active.fresh.markDirty();
    this.archived.fresh.markDirty();
  }

  private refresh(part: Part<Task>, dir: string, scan: (s: ScanState<Task>) => Task[]): void {
    if (part.items !== undefined && part.fresh.fresh()) return;
    part.fresh.watchDirs([dir]);
    const pass = part.fresh.begin([dir]);
    const state = newScanState(part.seen);
    this.scans++;
    const items = scan(state);
    part.seen = state.seen;
    if (!sameObjects(part.items, items)) {
      part.items = items;
      part.version++;
    }
    part.fresh.commit(pass, [dir], state.skipped === 0);
  }

  private load(source: TaskSource): void {
    if (source !== "archived")
      this.refresh(this.active, this.store.tasksDir(), (s) => this.store.listActiveReadOnly(s));
    if (source !== "current")
      this.refresh(this.archived, this.store.archiveDir(), (s) =>
        this.store.listArchivedReadOnly(s),
      );
  }

  private tasksOf(source: TaskSource): readonly Task[] {
    if (source === "archived") return this.archived.items ?? [];
    if (source === "all")
      return withoutDuplicates(this.active.items ?? [], this.archived.items ?? []);
    return this.active.items ?? [];
  }

  private view(source: TaskSource, sort: TaskSortSpec): TaskView {
    const at = `${this.active.version}:${this.archived.version}`;
    if (at !== this.viewsAt) {
      this.views = new Map();
      this.viewsAt = at;
    }
    const k = `${source}:${sort.name}`;
    let v = this.views.get(k);
    if (v) return v;
    const all = this.tasksOf(source).map((item) => ({ item, key: sort.keyOf(item) }));
    all.sort((a, b) => sort.cmp(a.key, b.key));
    const byStatus = new Map<string, Entry<Task>[]>();
    for (const e of all) {
      const list = byStatus.get(e.item.status);
      if (list) list.push(e);
      else byStatus.set(e.item.status, [e]);
    }
    v = { all, byStatus };
    this.views.set(k, v);
    return v;
  }

  private rows(
    lifecycle: TaskLifecycle,
    sort: TaskSortSpec,
    filter: ListFilter,
  ): { base: Entry<Task>[]; pred: ((t: Task) => boolean) | undefined } {
    const source = sourceOf(lifecycle);
    this.load(source);
    const view = this.view(source, sort);
    const { status, ...rest } = filter;
    const base = status ? (view.byStatus.get(status) ?? []) : view.all;
    const lp = lifecyclePred[lifecycle];
    const others = Object.values(rest).some((v) => v !== undefined && v !== "" && v !== false);
    const pred =
      others || lp ? (t: Task) => (lp ? lp(t) : true) && matchesList(t, rest) : undefined;
    return { base, pred };
  }

  /** A page of the list of one lifecycle, in one sort, under the filters. */
  page(args: {
    lifecycle: TaskLifecycle;
    sort: TaskSortSpec;
    query: ListFilter;
    limit: number;
    cursor?: string;
  }): IndexPage<Task> | { error: string } {
    const { base, pred } = this.rows(args.lifecycle, args.sort, args.query);
    return pageEntries(base, args.limit, args.cursor, pred, args.sort.cmp);
  }

  /** Every task in list order, for the unpaged call old UIs make. */
  all(args: { lifecycle: TaskLifecycle; sort: TaskSortSpec; query: ListFilter }): Task[] {
    const { base, pred } = this.rows(args.lifecycle, args.sort, args.query);
    const items = base.map((e) => e.item);
    return pred ? items.filter(pred) : items;
  }

  /**
   * Counts of the lifecycle's tasks per status and per assignee, and of the archive, under every
   * filter but status (and, for byAssignee, assignee and unassigned).
   */
  counts(query: ListFilter, lifecycle: TaskLifecycle = "current"): TaskCountsResult {
    this.load("all");
    const { status: _status, ...rest } = query;
    const { assignee: _a, unassigned: _u, ...restNoAssignee } = rest;
    const key = `${this.active.version}:${this.archived.version}:${lifecycle}:${JSON.stringify(rest)}`;
    let memo = this.countsMemo.get(key);
    if (!memo) {
      if (this.countsMemo.size > 16) this.countsMemo.clear();
      const lp = lifecyclePred[lifecycle];
      const inLifecycle = this.tasksOf(sourceOf(lifecycle));
      const byStatus: Record<string, number> = {};
      const byAssignee: Record<string, number> = {};
      let total = 0;
      for (const t of inLifecycle) {
        if (lp && !lp(t)) continue;
        if (matchesList(t, rest)) {
          total++;
          byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        }
        if (matchesList(t, restNoAssignee)) {
          const a = goTrimSpace(t.assignee ?? "");
          byAssignee[a] = (byAssignee[a] ?? 0) + 1;
        }
      }
      const arch: TaskCounts = { total: 0, byStatus: {} };
      for (const t of this.archived.items ?? []) {
        if (!matchesList(t, rest)) continue;
        arch.total++;
        arch.byStatus[t.status] = (arch.byStatus[t.status] ?? 0) + 1;
      }
      memo = { total, byStatus, byAssignee, archived: arch };
      this.countsMemo.set(key, memo);
    }
    return memo;
  }
}

const taskIndexes = new WeakMap<TaskStore, TaskIndex>();

/** The one index of a task store, shared by every request of the server process. */
export function taskIndexFor(store: TaskStore): TaskIndex {
  let ix = taskIndexes.get(store);
  if (!ix) {
    ix = new TaskIndex(store);
    taskIndexes.set(store, ix);
  }
  return ix;
}

// ---- docs -----------------------------------------------------------------------------------

export type DocSort = "walk" | "path" | "updated-desc";

export function parseDocSort(raw: string | null, paged: boolean): DocSort | undefined {
  if (raw === null || raw === "") return paged ? "path" : "walk";
  return raw === "path" || raw === "updated-desc" || raw === "walk" ? raw : undefined;
}

export interface DocQuery {
  tag?: string;
  folder?: string;
  query?: string;
}

export function matchesDocQuery(d: Doc, q: DocQuery): boolean {
  if (q.tag && !(d.tags ?? []).includes(q.tag)) return false;
  if (q.folder) {
    const f = d.folder ?? "";
    if (f !== q.folder && !f.startsWith(`${q.folder}/`)) return false;
  }
  if (q.query) {
    const needle = q.query.toLowerCase();
    if (
      !d.title.toLowerCase().includes(needle) &&
      !d.path.toLowerCase().includes(needle) &&
      !(d.description ?? "").toLowerCase().includes(needle)
    )
      return false;
  }
  return true;
}

const MAX_WATCHED_DIRS = 64;

export class DocIndex {
  private readonly part: Part<Doc>;
  private dirs: string[] | undefined;
  private views = new Map<string, Entry<Doc>[]>();
  private viewsAt = -1;
  scans = 0;

  constructor(
    private readonly store: DocStore,
    opts?: FreshnessOptions,
  ) {
    this.part = new Part(opts);
  }

  invalidate(): void {
    this.part.fresh.markDirty();
  }

  private load(): void {
    const p = this.part;
    if (p.items !== undefined && p.fresh.fresh()) return;
    const pass = p.fresh.begin(this.dirs ?? [this.store.docsDir(), this.store.importsDir()]);
    const track: DocScanTrack = { dirs: [], ...newScanState(p.seen) };
    this.scans++;
    const docs = this.store.listReadOnly(track);
    p.seen = track.seen;
    if (!sameObjects(p.items, docs)) {
      p.items = docs;
      p.version++;
    }
    this.dirs = [...new Set(track.dirs)];
    p.fresh.watchDirs(this.dirs.slice(0, MAX_WATCHED_DIRS));
    p.fresh.commit(pass, this.dirs, track.skipped === 0);
  }

  private view(sort: DocSort): Entry<Doc>[] {
    if (this.viewsAt !== this.part.version) {
      this.views = new Map();
      this.viewsAt = this.part.version;
    }
    let v = this.views.get(sort);
    if (v) return v;
    const keyOf = (d: Doc): SortKey =>
      sort === "updated-desc" ? [-updatedMs(d.updatedAt), d.path] : [d.path];
    v = (this.part.items ?? []).map((item) => ({ item, key: keyOf(item) }));
    if (sort !== "walk") v.sort((a, b) => compareKeys(a.key, b.key));
    this.views.set(sort, v);
    return v;
  }

  page(args: {
    sort: DocSort;
    query: DocQuery;
    limit: number;
    cursor?: string;
  }): IndexPage<Doc> | { error: string } {
    this.load();
    const any = Object.values(args.query).some((v) => v);
    return pageEntries(
      this.view(args.sort),
      args.limit,
      args.cursor,
      any ? (d) => matchesDocQuery(d, args.query) : undefined,
    );
  }

  all(query: DocQuery): Doc[] {
    this.load();
    return this.view("walk")
      .map((e) => e.item)
      .filter((d) => matchesDocQuery(d, query));
  }
}

const docIndexes = new WeakMap<DocStore, DocIndex>();

export function docIndexFor(store: DocStore): DocIndex {
  let ix = docIndexes.get(store);
  if (!ix) {
    ix = new DocIndex(store);
    docIndexes.set(store, ix);
  }
  return ix;
}
