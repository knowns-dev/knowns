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
function upperBound<T>(list: Entry<T>[], after: SortKey): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareKeys((list[mid] as Entry<T>).key, after) > 0) hi = mid;
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
): IndexPage<T> | { error: string } {
  const rows = pred ? list.filter((e) => pred(e.item)) : list;
  let start = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c === undefined)
      return { error: "cursor is not valid; use the nextCursor of a previous call" };
    start = "offset" in c ? c.offset : upperBound(rows, c.after);
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

export type TaskSort = "order" | "updated-desc";

export function parseTaskSort(raw: string | null): TaskSort | undefined {
  if (raw === null || raw === "" || raw === "order") return "order";
  if (raw === "updated-desc") return "updated-desc";
  return undefined;
}

function lifecycleRank(t: Task): number {
  const s = taskLifecycleState(t);
  return s === "active" ? 0 : s === "done" ? 1 : 2;
}

/** The key GET /api/tasks has always ordered by: lifecycle, then order (unset last), then id. */
export const lifecycleKey = (t: Task): SortKey => [lifecycleRank(t), ...orderKey(t)];

const sortKeys: Record<TaskSort, (t: Task) => SortKey> = {
  order: lifecycleKey,
  "updated-desc": (t) => [-updatedMs(t.updatedAt), t.id],
};

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

export class TaskIndex {
  private readonly active: Part<Task>;
  private readonly archived: Part<Task>;
  private views = new Map<string, TaskView>();
  private viewsAt = "";
  private countsMemo = new Map<string, { total: TaskCounts; archived: TaskCounts }>();
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

  private load(includeArchived: boolean): void {
    this.refresh(this.active, this.store.tasksDir(), (s) => this.store.listActiveReadOnly(s));
    if (includeArchived)
      this.refresh(this.archived, this.store.archiveDir(), (s) =>
        this.store.listArchivedReadOnly(s),
      );
  }

  private view(includeArchived: boolean, sort: TaskSort): TaskView {
    const at = `${this.active.version}:${this.archived.version}`;
    if (at !== this.viewsAt) {
      this.views = new Map();
      this.viewsAt = at;
    }
    const k = `${includeArchived}:${sort}`;
    let v = this.views.get(k);
    if (v) return v;
    const tasks = includeArchived
      ? withoutDuplicates(this.active.items ?? [], this.archived.items ?? [])
      : (this.active.items ?? []);
    const keyOf = sortKeys[sort];
    const all = tasks.map((item) => ({ item, key: keyOf(item) }));
    all.sort((a, b) => compareKeys(a.key, b.key));
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

  /** A page of the (optionally archived-inclusive) list, filtered like GET /api/tasks. */
  page(args: {
    includeArchived: boolean;
    sort: TaskSort;
    query: TaskQuery;
    limit: number;
    cursor?: string;
  }): IndexPage<Task> | { error: string } {
    this.load(args.includeArchived);
    const view = this.view(args.includeArchived, args.sort);
    const { status, ...rest } = args.query;
    const base = status ? (view.byStatus.get(status) ?? []) : view.all;
    const others = Object.values(rest).some((v) => v !== undefined && v !== "" && v !== false);
    return pageEntries(
      base,
      args.limit,
      args.cursor,
      others ? (t) => matchesQuery(t, rest) : undefined,
    );
  }

  /** Every task in list order, for the unpaged call old UIs make. */
  all(args: { includeArchived: boolean; sort: TaskSort; query: TaskQuery }): Task[] {
    this.load(args.includeArchived);
    const view = this.view(args.includeArchived, args.sort);
    const { status, ...rest } = args.query;
    const base = status ? (view.byStatus.get(status) ?? []) : view.all;
    return base.map((e) => e.item).filter((t) => matchesQuery(t, rest));
  }

  /** Counts per status of the active and the archived tasks that pass every filter but status. */
  counts(query: TaskQuery): {
    total: number;
    byStatus: Record<string, number>;
    archived: TaskCounts;
  } {
    this.load(true);
    const { status: _status, ...rest } = query;
    const key = `${this.active.version}:${this.archived.version}:${JSON.stringify(rest)}`;
    let memo = this.countsMemo.get(key);
    if (!memo) {
      if (this.countsMemo.size > 16) this.countsMemo.clear();
      const count = (tasks: readonly Task[] | undefined): TaskCounts => {
        const byStatus: Record<string, number> = {};
        let total = 0;
        for (const t of tasks ?? []) {
          if (!matchesQuery(t, rest)) continue;
          total++;
          byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        }
        return { total, byStatus };
      };
      memo = { total: count(this.active.items), archived: count(this.archived.items) };
      this.countsMemo.set(key, memo);
    }
    return { ...memo.total, archived: memo.archived };
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
