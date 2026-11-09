import { expect, test } from "bun:test";

import type { Task } from "@/ui/models/task";
import { ALL_ASSIGNEES, UNASSIGNED, filterTasksByAssignee, groupTasksByAssignee } from "./assignees";

const task = (id: string, assignee?: string) => ({ id, assignee }) as Task;

const tasks = [
	task("1", "@bob"),
	task("2"),
	task("3", "@alice"),
	task("4", "  "),
	task("5", "@bob"),
	task("6", "@carol"),
];

// Every Task lands in exactly one bucket, blank assignees count as Unassigned,
// and Unassigned stays last however large it is.
test("groups every task once with counts and Unassigned last", () => {
	const groups = groupTasksByAssignee(tasks);
	expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
		["@bob", ["1", "5"]],
		["@alice", ["3"]],
		["@carol", ["6"]],
		[UNASSIGNED, ["2", "4"]],
	]);
});

test("filter by a person or Unassigned matches its group", () => {
	expect(filterTasksByAssignee(tasks, ALL_ASSIGNEES)).toBe(tasks);
	expect(filterTasksByAssignee(tasks, "@bob").map((t) => t.id)).toEqual(["1", "5"]);
	expect(filterTasksByAssignee(tasks, UNASSIGNED).map((t) => t.id)).toEqual(["2", "4"]);
});
