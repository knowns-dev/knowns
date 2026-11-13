import type { Task } from "@/ui/models/task";

/** Filter/group key for Tasks with no assignee. Not a valid assignee string, so it cannot collide. */
export const UNASSIGNED = "__unassigned__";

/** Filter value meaning "no assignee filter". */
export const ALL_ASSIGNEES = "__all__";

export interface AssigneeGroup {
	/** The assignee string as stored on the Task, or UNASSIGNED. */
	key: string;
	tasks: Task[];
}

export function assigneeKey(task: Pick<Task, "assignee">): string {
	const assignee = task.assignee?.trim();
	return assignee ? assignee : UNASSIGNED;
}

/**
 * Buckets Tasks by assignee, keeping input order inside each bucket.
 * People come first, most Tasks first (ties by name); Unassigned is always last.
 */
export function groupTasksByAssignee(tasks: Task[]): AssigneeGroup[] {
	const buckets = new Map<string, Task[]>();
	for (const task of tasks) {
		const key = assigneeKey(task);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(task);
		else buckets.set(key, [task]);
	}
	const unassigned = buckets.get(UNASSIGNED);
	buckets.delete(UNASSIGNED);
	const groups = [...buckets.entries()]
		.map(([key, groupTasks]) => ({ key, tasks: groupTasks }))
		.sort((a, b) => b.tasks.length - a.tasks.length || a.key.localeCompare(b.key));
	if (unassigned) groups.push({ key: UNASSIGNED, tasks: unassigned });
	return groups;
}

export function filterTasksByAssignee(tasks: Task[], filter: string): Task[] {
	if (filter === ALL_ASSIGNEES) return tasks;
	return tasks.filter((task) => assigneeKey(task) === filter);
}

export function assigneeLabel(key: string): string {
	return key === UNASSIGNED ? "Unassigned" : key;
}
