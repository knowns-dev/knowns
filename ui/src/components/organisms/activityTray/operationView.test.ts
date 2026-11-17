import { describe, expect, test } from "bun:test";
import type { Operation } from "@/ui/models/operation";
import { operationView } from "./operationView";

const op = (over: Partial<Operation>): Operation => ({
	id: "op_1",
	source: "web",
	kind: "batch_archive",
	title: "Archiving 10 tasks",
	project: null,
	projectRoot: null,
	state: "running",
	progress: { done: 3, total: 10 },
	cancellable: true,
	retryable: false,
	error: null,
	message: null,
	startedAt: 1,
	updatedAt: 1,
	finishedAt: null,
	...over,
});

describe("operationView", () => {
	test("buttons come from the flags, not the kind", () => {
		expect(operationView(op({})).actions).toEqual(["cancel"]);
		expect(operationView(op({ kind: "reindex", cancellable: false })).actions).toEqual([]);
		const failed = operationView(op({ state: "failed", cancellable: false, retryable: true, error: "boom" }));
		expect(failed.actions).toEqual(["retry", "dismiss"]);
		expect(operationView(op({ state: "done", cancellable: false })).actions).toEqual(["dismiss"]);
	});

	test("cancelling is busy (a spinner), not an error, and has no buttons", () => {
		const v = operationView(op({ state: "cancelling", cancellable: false }));
		expect(v.tone).toBe("busy");
		expect(v.actions).toEqual([]);
	});

	test("progress becomes a fraction and a count; none is indeterminate", () => {
		expect(operationView(op({})).fraction).toBeCloseTo(0.3);
		expect(operationView(op({})).count).toBe("3 / 10");
		expect(operationView(op({ progress: null })).fraction).toBeNull();
		expect(operationView(op({ progress: { done: 12, total: 10 } })).count).toBe("10 / 10");
	});

	test("a failure shows the error line and then the counts with the reasons", () => {
		const v = operationView(
			op({ state: "failed", cancellable: false, error: "Lifecycle request failed", message: "2 archived, 1 not changed: #A must be done" }),
		);
		expect(v.tone).toBe("failed");
		expect(v.detail).toBe("Lifecycle request failed · 2 archived, 1 not changed: #A must be done");
	});

	test("the retry label never says Resume", () => {
		expect(operationView(op({ retryable: true })).retryLabel).toBe("Run again");
	});
});
