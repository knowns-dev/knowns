import { describe, expect, test } from "bun:test";
import type { Operation } from "@/ui/models/operation";
import { toActivityItem, type TrayHandlers } from "./toActivityItem";

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
	startedAt: 1000,
	updatedAt: 1000,
	finishedAt: null,
	...over,
});

function handlers() {
	const calls: string[] = [];
	const h: TrayHandlers = {
		pending: new Set(),
		cancel: (id) => calls.push(`cancel ${id}`),
		retry: (id) => calls.push(`retry ${id}`),
		dismissOnServer: (id) => calls.push(`server-dismiss ${id}`),
		hideHere: (id) => calls.push(`hide ${id}`),
	};
	return { h, calls };
}

const operationItem = (o: Operation, h: TrayHandlers) => {
	const item = toActivityItem(o, h);
	if (item.kind !== "operation") throw new Error("not an operation item");
	return item;
};

describe("toActivityItem", () => {
	test("buttons come from the flags, not the kind", () => {
		const { h } = handlers();
		expect(operationItem(op({}), h).actions?.map((a) => a.id)).toEqual(["cancel"]);
		expect(operationItem(op({ kind: "reindex", cancellable: false }), h).actions).toEqual([]);
		const failed = operationItem(op({ state: "failed", cancellable: false, retryable: true, error: "boom" }), h);
		expect(failed.actions?.map((a) => a.id)).toEqual(["retry"]);
	});

	test("Cancel is destructive; the retry button says Run again, never Resume", () => {
		const { h } = handlers();
		const both = operationItem(op({ cancellable: true, retryable: true }), h);
		expect(both.actions?.[0]).toMatchObject({ id: "cancel", label: "Cancel", variant: "destructive" });
		expect(both.actions?.[1]?.label).toBe("Run again");
	});

	test("a button acts on its own operation", () => {
		const { h, calls } = handlers();
		const item = operationItem(op({ id: "job:7", cancellable: true, retryable: true }), h);
		for (const a of item.actions ?? []) a.onSelect();
		expect(calls).toEqual(["cancel job:7", "retry job:7"]);
	});

	test("buttons are disabled while that row has a request in flight", () => {
		const { h } = handlers();
		const item = operationItem(op({ retryable: true }), { ...h, pending: new Set(["op_1"]) });
		expect(item.actions?.every((a) => a.disabled)).toBe(true);
	});

	test("done and cancelled age out locally; only a failed Dismiss goes to the server", () => {
		for (const state of ["done", "cancelled"] as const) {
			const { h, calls } = handlers();
			operationItem(op({ state, cancellable: false, finishedAt: 2000 }), h).onDismiss?.();
			expect(calls).toEqual(["hide op_1"]);
		}
		const { h, calls } = handlers();
		operationItem(op({ state: "failed", cancellable: false, error: "boom" }), h).onDismiss?.();
		expect(calls).toEqual(["server-dismiss op_1"]);
	});

	test("the reasons of a partial failure reach the row: error and message pass through", () => {
		const { h } = handlers();
		const item = operationItem(
			op({ state: "failed", cancellable: false, error: "Lifecycle request failed", message: "2 archived, 1 not changed: #A must be done" }),
			h,
		);
		expect(item.error).toBe("Lifecycle request failed");
		expect(item.message).toBe("2 archived, 1 not changed: #A must be done");
	});

	test("progress, state and times carry over; no progress stays null", () => {
		const { h } = handlers();
		const item = operationItem(op({ state: "cancelling", cancellable: false, progress: null, finishedAt: 5000 }), h);
		expect(item.state).toBe("cancelling");
		expect(item.progress).toBeNull();
		expect(item.startedAt).toEqual(new Date(1000));
		expect(item.finishedAt).toEqual(new Date(5000));
	});
});
