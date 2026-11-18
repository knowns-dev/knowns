import { describe, expect, test } from "bun:test";
import type { Task } from "@/ui/models/task";
import { appendPage, applyUpdate, matchesFilters, removeTask } from "./taskFeed";

const t = (id: string, updatedAt: string, extra: Partial<Task> = {}): Task =>
	({ id, title: `Task ${id}`, status: "todo", priority: "medium", labels: [], createdAt: "2026-01-01T00:00:00Z", updatedAt, lifecycleState: "active", ...extra }) as Task;

describe("appendPage", () => {
	test("appends new ids in order", () => {
		const out = appendPage([t("a", "2026-01-03T00:00:00Z")], [t("b", "2026-01-02T00:00:00Z"), t("c", "2026-01-01T00:00:00Z")]);
		expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
	});

	test("an id on two pages is kept once, in its first place, with the newer copy", () => {
		const first = [t("a", "2026-01-03T00:00:00Z"), t("b", "2026-01-02T00:00:00Z")];
		const out = appendPage(first, [t("b", "2026-01-05T00:00:00Z", { title: "newer" }), t("c", "2026-01-01T00:00:00Z")]);
		expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
		expect(out[1]?.title).toBe("newer");
	});

	test("an older duplicate does not replace the newer copy", () => {
		const out = appendPage([t("a", "2026-01-05T00:00:00Z", { title: "new" })], [t("a", "2026-01-01T00:00:00Z", { title: "old" })]);
		expect(out).toHaveLength(1);
		expect(out[0]?.title).toBe("new");
	});

	test("duplicates inside one page collapse too", () => {
		expect(appendPage([], [t("a", "2026-01-01T00:00:00Z"), t("a", "2026-01-01T00:00:00Z")])).toHaveLength(1);
	});
});

describe("matchesFilters", () => {
	test("status, assignee, label and query", () => {
		const task = t("a", "2026-01-01T00:00:00Z", { status: "done", assignee: "@me", labels: ["ui"], title: "Fix the parser" });
		expect(matchesFilters(task, { status: "done" })).toBe(true);
		expect(matchesFilters(task, { status: "todo" })).toBe(false);
		expect(matchesFilters(task, { assignee: "@me", label: "ui" })).toBe(true);
		expect(matchesFilters(task, { label: "cli" })).toBe(false);
		expect(matchesFilters(task, { query: "PARSER" })).toBe(true);
		expect(matchesFilters(task, { query: "nothing" })).toBe(false);
	});

	test("archived tasks only with includeHistorical", () => {
		const task = t("a", "2026-01-01T00:00:00Z", { lifecycleState: "archived" });
		expect(matchesFilters(task, {})).toBe(false);
		expect(matchesFilters(task, { includeHistorical: true })).toBe(true);
	});
});

describe("applyUpdate", () => {
	const items = [t("a", "2026-01-03T00:00:00Z"), t("b", "2026-01-02T00:00:00Z")];

	test("a new task goes to the top under updated-desc", () => {
		expect(applyUpdate(items, t("n", "2026-01-09T00:00:00Z"), {}, "updated-desc").map((x) => x.id)).toEqual(["n", "a", "b"]);
	});

	test("a newer copy of a present task moves to the top; the list keeps no duplicate", () => {
		expect(applyUpdate(items, t("b", "2026-01-09T00:00:00Z"), {}, "updated-desc").map((x) => x.id)).toEqual(["b", "a"]);
	});

	test("an update that does not bump updatedAt replaces in place", () => {
		const out = applyUpdate(items, t("b", "2026-01-02T00:00:00Z", { title: "x" }), {}, "updated-desc");
		expect(out.map((x) => x.id)).toEqual(["a", "b"]);
		expect(out[1]?.title).toBe("x");
	});

	test("a task that stops matching the column leaves it", () => {
		expect(applyUpdate(items, t("a", "2026-01-09T00:00:00Z", { status: "done" }), { status: "todo" }, "updated-desc").map((x) => x.id)).toEqual(["b"]);
	});

	test("a task that starts matching enters at the top", () => {
		expect(applyUpdate(items, t("z", "2026-01-09T00:00:00Z", { status: "done" }), { status: "done" }, "updated-desc").map((x) => x.id)).toEqual(["z", "a", "b"]);
	});

	test("under sort=order a present task with the same order is replaced in place", () => {
		expect(applyUpdate(items, t("a", "2026-01-09T00:00:00Z", { title: "r" }), {}, "order")[0]?.title).toBe("r");
	});

	test("under sort=order a new task is placed by its order, or skipped past the end of an unfinished list", () => {
		const ordered = [t("a", "2026-01-03T00:00:00Z", { order: 1 }), t("b", "2026-01-02T00:00:00Z", { order: 5 })];
		expect(applyUpdate(ordered, t("n", "2026-01-09T00:00:00Z", { order: 3 }), {}, "order").map((x) => x.id)).toEqual(["a", "n", "b"]);
		expect(applyUpdate(ordered, t("z", "2026-01-09T00:00:00Z", { order: 9 }), {}, "order", false)).toBe(ordered);
		expect(applyUpdate(ordered, t("z", "2026-01-09T00:00:00Z", { order: 9 }), {}, "order", true).map((x) => x.id)).toEqual(["a", "b", "z"]);
	});

	test("under sort=order a reordered present task moves to its new place", () => {
		const ordered = [t("a", "2026-01-03T00:00:00Z", { order: 1 }), t("b", "2026-01-02T00:00:00Z", { order: 5 })];
		expect(applyUpdate(ordered, t("a", "2026-01-09T00:00:00Z", { order: 9 }), {}, "order").map((x) => x.id)).toEqual(["b", "a"]);
	});

	test("an archived task is removed", () => {
		expect(applyUpdate(items, t("a", "2026-01-09T00:00:00Z", { lifecycleState: "archived" }), {}, "updated-desc").map((x) => x.id)).toEqual(["b"]);
	});
});

test("removeTask", () => {
	const items = [t("a", "2026-01-03T00:00:00Z")];
	expect(removeTask(items, "a")).toEqual([]);
	expect(removeTask(items, "x")).toBe(items);
});
