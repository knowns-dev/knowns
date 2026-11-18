import type { Task } from "@/ui/models/task";
import type { TaskFilters } from "../api/client";

/**
 * The pure half of the paged task lists (Tasks list, one Kanban column). A feed holds the pages
 * loaded so far, newest first when sorted by updated-desc; these helpers keep it free of duplicate
 * ids (a task that changes mid-traversal can appear on two pages) and fold live updates in.
 */

export type FeedSort = string;

const ms = (t: Task): number => {
	const u: unknown = t.updatedAt;
	const v = u instanceof Date ? u.getTime() : Date.parse(String(u));
	return Number.isNaN(v) ? 0 : v;
};

/**
 * Appends a page. An id already present keeps its place and takes the newer copy (by updatedAt; a tie
 * goes to the later arrival), so a duplicate across pages never renders twice or throws on a key.
 */
export function appendPage(items: readonly Task[], page: readonly Task[]): Task[] {
	const out = items.slice();
	const at = new Map<string, number>();
	out.forEach((t, i) => at.set(t.id, i));
	for (const t of page) {
		const i = at.get(t.id);
		if (i === undefined) {
			at.set(t.id, out.length);
			out.push(t);
		} else if (ms(t) >= ms(out[i] as Task)) {
			out[i] = t;
		}
	}
	return out;
}

/** The client-side twin of the server filters, for deciding whether a pushed task belongs in a feed. */
export function matchesFilters(task: Task, f: TaskFilters): boolean {
	const life = f.lifecycle ?? (f.includeHistorical ? "all" : "current");
	const state = task.lifecycleState ?? "active";
	if (life === "current" && state === "archived") return false;
	if (life === "active" && state !== "active") return false;
	if (life === "done" && state !== "done") return false;
	if (life === "archived" && state !== "archived") return false;
	if (f.status && task.status !== f.status) return false;
	if (f.priority && task.priority !== f.priority) return false;
	if (f.unassigned) {
		if ((task.assignee ?? "") !== "") return false;
	} else if (f.assignee && (task.assignee ?? "") !== f.assignee) return false;
	if (f.label && !(task.labels ?? []).includes(f.label)) return false;
	if (f.parent === "none") {
		if (task.parent) return false;
	} else if (f.parent && task.parent !== f.parent) return false;
	if (f.query) {
		const q = f.query.toLowerCase();
		const hay = `${task.id} ${task.title} ${task.descriptionPreview ?? task.description ?? ""} ${task.assignee ?? ""} ${(task.labels ?? []).join(" ")}`.toLowerCase();
		if (!hay.includes(q)) return false;
	}
	return true;
}

/**
 * Folds one pushed task into a feed: dropped when it no longer matches, replaced in place when
 * present (moved to the top if its updatedAt grew under updated-desc), and inserted at the top when
 * new under updated-desc. Under sort=order it is placed by its order (see insertByOrder).
 */
export function applyUpdate(
	items: readonly Task[],
	task: Task,
	filters: TaskFilters,
	sort: FeedSort,
	exhausted = false,
): Task[] {
	const i = items.findIndex((t) => t.id === task.id);
	if (!matchesFilters(task, filters)) return i < 0 ? (items as Task[]) : items.filter((t) => t.id !== task.id);
	if (sort !== "updated-desc" && sort !== "order" && sort !== "board") {
		// Any other server sort: its slot for a changed task is unknown, so only replace what is loaded.
		if (i < 0) return items as Task[];
		const next = items.slice();
		next[i] = task;
		return next;
	}
	if (sort === "order" || sort === "board") {
		// A changed order or status moves the card: drop the old copy, place the new one by its order.
		const without = i >= 0 ? items.filter((t) => t.id !== task.id) : (items as Task[]);
		const moved = i >= 0 && orderCompare(task, items[i] as Task) !== 0;
		if (i >= 0 && !moved) {
			const next = items.slice();
			next[i] = task;
			return next;
		}
		return insertByOrder(without, task, exhausted || i >= 0);
	}
	if (i >= 0) {
		const grew = ms(task) > ms(items[i] as Task);
		if (!grew) {
			const next = items.slice();
			next[i] = task;
			return next;
		}
		return [task, ...items.filter((t) => t.id !== task.id)];
	}
	return [task, ...items];
}

/** The server's sort=order key: ordered tasks first by order, then the rest, id as the tie-break. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** sort=board: ordered cards by order; the unordered tail by priority, then newest update, then id. */
function orderCompare(a: Task, b: Task): number {
	const ao = a.order === undefined || a.order === null ? 1 : 0;
	const bo = b.order === undefined || b.order === null ? 1 : 0;
	if (ao !== bo) return ao - bo;
	if (ao === 0 && (a.order as number) !== (b.order as number)) return (a.order as number) - (b.order as number);
	if (ao === 1) {
		const p = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
		if (p !== 0) return p;
		const u = ms(b) - ms(a);
		if (u !== 0) return u;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Places a task into a list sorted by sort=order. Past the last loaded item it is only added when the
 * list is exhausted (otherwise the paging that has not happened yet brings it in at its place).
 */
export function insertByOrder(items: readonly Task[], task: Task, exhausted: boolean): Task[] {
	const at = items.findIndex((t) => orderCompare(task, t) < 0);
	if (at >= 0) return [...items.slice(0, at), task, ...items.slice(at)];
	return exhausted ? [...items, task] : (items as Task[]);
}

export function removeTask(items: readonly Task[], id: string): Task[] {
	return items.some((t) => t.id === id) ? items.filter((t) => t.id !== id) : (items as Task[]);
}
