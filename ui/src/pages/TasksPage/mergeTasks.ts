import type { Task } from "@/ui/models/task";

/**
 * Applies a replacement for a subset of Tasks (e.g. what a filtered Board shows)
 * to the full set: Tasks outside the subset are kept. Tasks not yet in the set are
 * appended only with `appendNew`; a historical Board also holds archived Tasks,
 * which must not leak into the current set.
 */
export function mergeTaskSubset(all: Task[], updated: Task[], { appendNew }: { appendNew: boolean }): Task[] {
	const byId = new Map(updated.map((task) => [task.id, task]));
	const merged = all.map((task) => byId.get(task.id) ?? task);
	if (!appendNew) return merged;
	const known = new Set(all.map((task) => task.id));
	return [...merged, ...updated.filter((task) => !known.has(task.id))];
}
