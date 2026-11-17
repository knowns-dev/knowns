import { describe, expect, test } from "bun:test";
import type { Operation } from "@/ui/models/operation";
import {
	adoptOperation,
	applyOperationEvent,
	applyRemoved,
	applySnapshot,
	emptyOperations,
	HIDE_FINISHED_AFTER_MS,
	nextHideAt,
	visibleOperations,
} from "./operationsStore";

const op = (id: string, over: Partial<Operation> = {}): Operation => ({
	id,
	source: "web",
	kind: "batch_archive",
	title: id,
	project: null,
	projectRoot: null,
	state: "running",
	progress: null,
	cancellable: true,
	retryable: false,
	error: null,
	message: null,
	startedAt: 1000,
	updatedAt: 1000,
	finishedAt: null,
	...over,
});

describe("operations store", () => {
	test("events before the first snapshot are ignored", () => {
		const s = applyOperationEvent(emptyOperations, { seq: 5, operation: op("op_a") });
		expect(s).toBe(emptyOperations);
	});

	test("only an event newer than the snapshot seq is applied", () => {
		let s = applySnapshot({ seq: 10, operations: [op("op_a", { message: "from snapshot" })] });
		s = applyOperationEvent(s, { seq: 10, operation: op("op_a", { message: "stale" }) });
		expect(s.byId.op_a?.message).toBe("from snapshot");
		s = applyOperationEvent(s, { seq: 11, operation: op("op_a", { message: "newer" }) });
		expect(s.byId.op_a?.message).toBe("newer");
		s = applyOperationEvent(s, { seq: 9, operation: op("op_a", { message: "late" }) });
		expect(s.byId.op_a?.message).toBe("newer");
	});

	test("a new snapshot replaces everything (reconnect)", () => {
		let s = applySnapshot({ seq: 3, operations: [op("op_a"), op("op_b")] });
		s = applySnapshot({ seq: 20, operations: [op("op_c")] });
		expect(Object.keys(s.byId)).toEqual(["op_c"]);
		expect(s.seq).toBe(20);
	});

	test("removed drops the row and respects seq", () => {
		let s = applySnapshot({ seq: 1, operations: [op("op_a")] });
		s = applyRemoved(s, { seq: 1, id: "op_a" });
		expect(s.byId.op_a).toBeDefined();
		s = applyRemoved(s, { seq: 2, id: "op_a" });
		expect(s.byId.op_a).toBeUndefined();
		expect(s.seq).toBe(2);
	});

	test("an action result is adopted, but never replaces a newer row", () => {
		let s = applySnapshot({ seq: 1, operations: [op("op_a", { updatedAt: 50, message: "newer" })] });
		s = adoptOperation(s, op("op_a", { updatedAt: 10, message: "older" }));
		expect(s.byId.op_a?.message).toBe("newer");
		s = adoptOperation(s, op("op_new"));
		expect(s.byId.op_new).toBeDefined();
	});

	test("done and cancelled hide after the delay, failed stays, running stays", () => {
		const finished = 10_000;
		const s = applySnapshot({
			seq: 1,
			operations: [
				op("op_done", { state: "done", finishedAt: finished }),
				op("op_cancelled", { state: "cancelled", finishedAt: finished }),
				op("op_failed", { state: "failed", finishedAt: finished, error: "boom" }),
				op("op_running"),
				op("op_cancelling", { state: "cancelling", cancellable: false }),
			],
		});
		const ids = (now: number) => visibleOperations(s, now).map((o) => o.id).sort();
		expect(ids(finished + HIDE_FINISHED_AFTER_MS - 1)).toContain("op_done");
		expect(ids(finished + HIDE_FINISHED_AFTER_MS)).toEqual(["op_cancelling", "op_failed", "op_running"]);
	});

	test("nextHideAt names the earliest pending hide", () => {
		const s = applySnapshot({
			seq: 1,
			operations: [
				op("op_a", { state: "done", finishedAt: 5000 }),
				op("op_b", { state: "cancelled", finishedAt: 7000 }),
				op("op_c", { state: "failed", finishedAt: 1000 }),
			],
		});
		expect(nextHideAt(s, 6000)).toBe(5000 + HIDE_FINISHED_AFTER_MS);
		expect(nextHideAt(s, 100_000)).toBeNull();
	});

	test("rows are newest first", () => {
		const s = applySnapshot({ seq: 1, operations: [op("op_old", { startedAt: 1 }), op("op_new", { startedAt: 9 })] });
		expect(visibleOperations(s, 0).map((o) => o.id)).toEqual(["op_new", "op_old"]);
	});
});
