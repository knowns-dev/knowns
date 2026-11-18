import { describe, expect, test } from "bun:test";
import type { Operation } from "@/ui/models/operation";
import { failureText, toActivityItem, type TrayHandlers } from "./toActivityItem";

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
		pending: new Map(),
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

/** What the stack does: the timer calls onDismiss("timeout"), the Dismiss button onDismiss("user"). */
const timer = (item: ReturnType<typeof operationItem>) => item.onDismiss?.("timeout");
const clickDismiss = (item: ReturnType<typeof operationItem>) => item.onDismiss?.("user");

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
		const item = operationItem(op({ retryable: true }), { ...h, pending: new Map([["op_1", "retry" as const]]) });
		expect(item.actions?.every((a) => a.disabled)).toBe(true);
	});

	test("the timer hides done and a cancelled row with nothing to run again, locally and without a request", () => {
		for (const o of [op({ state: "done", cancellable: false }), op({ state: "cancelled", cancellable: false, retryable: false })]) {
			const { h, calls } = handlers();
			timer(operationItem(o, h));
			expect(calls).toEqual(["hide op_1"]);
		}
	});

	test("Dismiss on a failed row, or a cancelled one with work left, removes it on the server; on a done one it only hides", () => {
		for (const o of [
			op({ state: "failed", cancellable: false, error: "boom" }),
			op({ state: "cancelled", cancellable: false, retryable: true }),
		]) {
			const { h, calls } = handlers();
			clickDismiss(operationItem(o, h));
			expect(calls).toEqual(["server-dismiss op_1"]);
		}
		const { h, calls } = handlers();
		clickDismiss(operationItem(op({ state: "done", cancellable: false }), h));
		expect(calls).toEqual(["hide op_1"]);
	});

	test("a failed row puts its reason on the collapsed line: the error and the counts with the reasons", () => {
		const o = op({
			state: "failed",
			cancellable: false,
			error: "Lifecycle request failed",
			message: "2 archived, 1 not changed: #A must be done",
		});
		expect(failureText(o)).toBe("2 archived, 1 not changed: #A must be done · Lifecycle request failed");
		const { h } = handlers();
		const item = operationItem(o, h);
		expect(item.message).toBeTruthy();
		// the collapsed line is cut at the card's width, so the open card repeats the whole reason, wrapped
		expect(item.error).toBe("2 archived, 1 not changed: #A must be done · Lifecycle request failed");
	});

	test("a row that is not failed passes its message through", () => {
		const { h } = handlers();
		expect(operationItem(op({ message: "125 archived, 375 left" }), h).message).toBe("125 archived, 375 left");
	});

	test("startedAt is a Date in milliseconds, so an elapsed clock moves once time passes", () => {
		const { h } = handlers();
		const a = operationItem(op({ startedAt: Date.now() - 5000, progress: { done: 1, total: 10 } }), h);
		expect(Date.now() - (a.startedAt?.getTime() ?? Date.now())).toBeGreaterThanOrEqual(5000);
	});

	test("pressing Cancel reads Cancelling at once, before the server answers", () => {
		const { h } = handlers();
		const item = operationItem(op({ state: "running" }), { ...h, pending: new Map([["op_1", "cancel" as const]]) });
		expect(item.state).toBe("cancelling");
		expect(item.actions?.every((a) => a.disabled)).toBe(true);
		// a retry in flight does not claim the row is cancelling
		expect(operationItem(op({ state: "running" }), { ...h, pending: new Map([["op_1", "retry" as const]]) }).state).toBe("running");
		// and a row that already finished stays what it is
		expect(operationItem(op({ state: "done" }), { ...h, pending: new Map([["op_1", "cancel" as const]]) }).state).toBe("done");
	});

	test("progress, state and times carry over; no progress stays null", () => {
		const { h } = handlers();
		const item = operationItem(op({ state: "cancelling", cancellable: false, progress: null, finishedAt: 5000 }), h);
		expect(item.state).toBe("cancelling");
		expect(item.progress).toBeNull();
		expect(item.startedAt).toEqual(new Date(1000));
		expect(item.finishedAt).toEqual(new Date(5000));
	});

	test("a finished row keeps its duration, unless it took under a second (that reads 0:00, so no clock)", () => {
		const { h } = handlers();
		const long = operationItem(op({ state: "done", cancellable: false, startedAt: 1000, finishedAt: 4500 }), h);
		expect(long.finishedAt!.getTime() - long.startedAt!.getTime()).toBe(3500);
		const quick = operationItem(op({ state: "failed", cancellable: false, startedAt: 1000, finishedAt: 1031 }), h);
		expect(quick.startedAt).toBeUndefined();
		// a running row always has its start
		expect(operationItem(op({ state: "running", startedAt: 1000 }), h).startedAt).toEqual(new Date(1000));
	});
});
