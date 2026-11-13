import { describe, expect, test } from "bun:test";

import type { Task } from "@/ui/models/task";
import {
	agingTakeaway,
	buildLabelGrowth,
	buildLeadTimeHistogram,
	buildLoadByAssignee,
	buildOpenTrend,
	buildThroughput,
	buildWorkAging,
	finishedWithSpec,
	flowTakeaway,
	getFlowSummary,
	getLeadTimeStats,
	knowledgeTakeaway,
	labelTakeaway,
	leadTimeTakeaway,
	loadTakeaway,
	openAt,
	stageOf,
} from "./analytics";

const NOW = new Date(2026, 10, 10, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let seq = 0;
function task(p: Partial<Task> & { created: number; done?: number; updated?: number }): Task {
	const { created, done, updated, ...rest } = p;
	seq += 1;
	return {
		id: `T-${seq}`,
		title: `Task ${seq}`,
		status: done !== undefined ? "done" : "todo",
		priority: "medium",
		labels: [],
		subtasks: [],
		acceptanceCriteria: [],
		timeSpent: 0,
		timeEntries: [],
		archived: false,
		lifecycleState: done !== undefined ? "done" : "active",
		createdAt: daysAgo(created),
		updatedAt: daysAgo(updated ?? done ?? created),
		completedAt: done !== undefined ? daysAgo(done) : undefined,
		...rest,
	} as Task;
}

describe("flow", () => {
	const tasks = [
		task({ created: 40, done: 35 }), // finished in the previous period
		task({ created: 20, done: 10 }),
		task({ created: 5 }),
		task({ created: 3 }),
		task({ created: 50 }), // open since before the period
	];

	test("counts added, finished, the period before, and open work", () => {
		const flow = getFlowSummary(tasks, 30, NOW);
		expect(flow).toEqual({ created: 3, completed: 1, previousCompleted: 1, openNow: 3, openAtStart: 1 });
	});

	test("the takeaway says which way open work moved", () => {
		expect(flowTakeaway(getFlowSummary(tasks, 30, NOW), 30)).toBe(
			"You finished 1 and added 3 in the last 30 days, so open work grew by 2.",
		);
		expect(flowTakeaway({ created: 1, completed: 4, previousCompleted: 1, openNow: 0, openAtStart: 3 }, 7)).toBe(
			"You finished 4 and added 1 in the last 7 days, so open work shrank by 3. That is 3 more finished than the 7 days before.",
		);
		expect(flowTakeaway({ created: 0, completed: 0, previousCompleted: 0, openNow: 0, openAtStart: 0 }, 30)).toBe(
			"Nothing was added or finished in the last 30 days.",
		);
	});

	test("open work at an instant ignores archived and finished tasks", () => {
		const list = [task({ created: 10 }), task({ created: 10, done: 5 }), task({ created: 10, archived: true })];
		expect(openAt(list, daysAgo(7))).toBe(2);
		expect(openAt(list, NOW)).toBe(1);
		const trend = buildOpenTrend(list, buildThroughput(list, 7, NOW));
		expect(trend.at(-1)).toBe(1);
	});
});

describe("lead time", () => {
	test("histogram keeps every bucket, even empty ones", () => {
		const histogram = buildLeadTimeHistogram([0.5, 2, 2.5, 10, 40]);
		expect(histogram.map((b) => b.count)).toEqual([1, 2, 0, 1, 1]);
		expect(buildLeadTimeHistogram([]).every((b) => b.count === 0)).toBe(true);
	});

	test("a small sample says so instead of quoting percentiles", () => {
		const one = getLeadTimeStats([task({ created: 4, done: 2 })], 30, NOW);
		expect(leadTimeTakeaway(one, 30)).toBe(
			"Only 1 task was finished in this range; it took 2d. Finish a few more to see a pattern.",
		);
		expect(leadTimeTakeaway(null, 7)).toBe("No task was finished in the last 7 days, so there is no time to measure yet.");
	});

	test("a full sample quotes the median and the 85th percentile", () => {
		const tasks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => task({ created: d + 1, done: 1 }));
		const stats = getLeadTimeStats(tasks, 30, NOW);
		expect(leadTimeTakeaway(stats, 30)).toBe(
			"Half the work is finished within 5d of being created, and 85% within 9d. The slowest took 10d.",
		);
	});
});

describe("aging", () => {
	test("names the status holding the most stale work", () => {
		const tasks = [
			task({ created: 30, updated: 20, status: "blocked" }),
			task({ created: 30, updated: 20, status: "blocked" }),
			task({ created: 3, updated: 1, status: "in-progress" }),
			task({ created: 30, updated: 9, status: "in-progress" }),
		];
		const rows = buildWorkAging(tasks, ["todo", "in-progress", "blocked"], NOW);
		expect(agingTakeaway(rows)).toBe("3 of 4 open tasks have not moved for more than a week. Blocked holds the most: 2 of 2.");
	});

	test("fresh and empty boards read plainly", () => {
		expect(agingTakeaway([])).toBe("No open work, so nothing is stuck.");
		const rows = buildWorkAging([task({ created: 1 })], ["todo"], NOW);
		expect(agingTakeaway(rows)).toBe("All 1 open task moved in the last week. Nothing looks stuck.");
	});
});

describe("load", () => {
	test("stages come from the status name", () => {
		expect(stageOf("in-progress")).toBe("progress");
		expect(stageOf("In Review")).toBe("review");
		expect(stageOf("blocked")).toBe("blocked");
		expect(stageOf("backlog")).toBe("todo");
	});

	test("groups open work per person, busiest first, and folds the tail", () => {
		const tasks = [
			task({ created: 1, assignee: "@an", status: "in-progress" }),
			task({ created: 1, assignee: "@an", status: "in-review" }),
			task({ created: 1, assignee: "@an" }),
			task({ created: 1, assignee: "@linh" }),
			task({ created: 1 }),
			task({ created: 3, done: 1, assignee: "@linh" }),
		];
		const rows = buildLoadByAssignee(tasks);
		expect(rows.map((r) => [r.who, r.total])).toEqual([
			["@an", 3],
			["@linh", 1],
			["Unassigned", 1],
		]);
		expect(loadTakeaway(rows)).toBe(
			"@an holds the most open work: 3 of 5 (60%), 2 of them in progress or review. 1 task has no owner.",
		);
		expect(buildLoadByAssignee(tasks, 2).map((r) => r.who)).toEqual(["@an", "Others"]);
	});

	test("one person or nobody", () => {
		expect(loadTakeaway([])).toBe("Nobody holds open work right now.");
		expect(loadTakeaway(buildLoadByAssignee([task({ created: 1, assignee: "@mai" })]))).toBe("@mai holds all 1 open task.");
	});
});

describe("labels", () => {
	test("the fastest-growing label comes first", () => {
		const tasks = [
			task({ created: 2, labels: ["ui"] }),
			task({ created: 2, labels: ["ui"] }),
			task({ created: 5, done: 1, labels: ["search"] }),
			task({ created: 90, done: 2, labels: ["search"] }),
			task({ created: 1 }),
		];
		const rows = buildLabelGrowth(tasks, 30, NOW);
		expect(rows[0]).toEqual({ label: "ui", added: 2, finished: 0, net: 2 });
		expect(rows.find((r) => r.label === "search")).toEqual({ label: "search", added: 1, finished: 2, net: -1 });
		expect(labelTakeaway(rows, 30)).toBe("ui grows fastest: 2 added, 0 finished, so 2 more tasks open than 30 days ago.");
	});

	test("shrinking and unlabelled work", () => {
		expect(labelTakeaway([{ label: "docs", added: 1, finished: 3, net: -2 }], 30)).toBe(
			"No area grew: every label finished at least as much as it added. docs saw the most done (3).",
		);
		expect(labelTakeaway([{ label: "No label", added: 2, finished: 0, net: 2 }], 30)).toBe(
			"None of this work has a label yet. Label tasks to see which areas grow.",
		);
		expect(labelTakeaway([], 7)).toBe("No labelled work was added or finished in the last 7 days.");
	});
});

describe("knowledge", () => {
	test("counts finished work that links to a spec", () => {
		const tasks = [task({ created: 5, done: 1, spec: "specs/a" }), task({ created: 5, done: 2 }), task({ created: 5 })];
		expect(finishedWithSpec(tasks, 30, NOW)).toEqual({ finished: 2, withSpec: 1 });
	});

	test("review backlog first, then spec coverage", () => {
		expect(
			knowledgeTakeaway({ finished: 4, finishedWithSpec: 1, memoriesProposed: 2, decisionsWaiting: 1, memoriesActive: 5 }),
		).toBe("2 memories and 1 decision wait for your review. 1 of 4 tasks finished in this range links to a spec (25%).");
		expect(knowledgeTakeaway({ finished: 0, finishedWithSpec: 0, specLinked: 1, specTotal: 8, memoriesProposed: 0, decisionsWaiting: 0, memoriesActive: 0 })).toBe(
			"Nothing waits for review. 1 of 8 tasks link to a spec.",
		);
		expect(knowledgeTakeaway({ finished: 0, finishedWithSpec: 0 })).toBe("Knowledge is up to date: nothing waits for review.");
	});
});
