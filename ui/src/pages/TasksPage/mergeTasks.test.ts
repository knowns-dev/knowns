import { expect, test } from "bun:test";

import type { Task } from "@/ui/models/task";
import { mergeTaskSubset } from "./mergeTasks";

const all = [{ id: "1", status: "todo" }, { id: "2", status: "todo" }] as Task[];
const updated = [{ id: "1", status: "done" }, { id: "3", status: "todo" }] as Task[];

// A drag on a filtered Board returns only the Tasks it showed; replacing the app's
// Task set with that list used to drop every filtered-out Task.
test("a filtered Board update keeps the Tasks it did not show and appends new ones", () => {
	const merged = mergeTaskSubset(all, updated, { appendNew: true });
	expect(merged.map((t) => [t.id, t.status])).toEqual([["1", "done"], ["2", "todo"], ["3", "todo"]]);
});

// A historical Board also holds archived Tasks; they must not enter the current set.
test("without appendNew only Tasks already in the set are updated", () => {
	const merged = mergeTaskSubset(all, updated, { appendNew: false });
	expect(merged.map((t) => [t.id, t.status])).toEqual([["1", "done"], ["2", "todo"]]);
});

// "Add card" appends the created Task to a list that may already hold it from the server's
// task-created event, while `all` is an older snapshot: the board showed the card twice.
test("a Task listed twice in the update is appended once", () => {
	const created = { id: "3", status: "todo" } as Task;
	const merged = mergeTaskSubset(all, [...all, created, created], { appendNew: true });
	expect(merged.map((t) => t.id)).toEqual(["1", "2", "3"]);
});
