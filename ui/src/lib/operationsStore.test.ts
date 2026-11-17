import { describe, expect, test } from "bun:test";
import type { Operation } from "@/ui/models/operation";
import {
	adoptOperation,
	agesOut,
	applyOperationEvent,
	applyRemoved,
	applySnapshot,
	beginSnapshot,
	emptyOperations,
	failSnapshot,
	hideOperation,
	SHOW_FINISHED_FOR_MS,
	visibleOperations,
	type OperationsState,
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

/** Request n, answered with this snapshot. */
const loaded = (n: number, seq: number, operations: Operation[], from: OperationsState = emptyOperations, now = 0) =>
	applySnapshot(beginSnapshot(from, n), n, { seq, operations }, now);

describe("operations store: snapshot and events", () => {
	test("an event that arrives before the snapshot survives when it is newer than the snapshot", () => {
		let s = beginSnapshot(emptyOperations, 1);
		s = applyOperationEvent(s, { seq: 12, operation: op("op_a", { message: "from event" }) });
		s = applySnapshot(s, 1, { seq: 10, operations: [op("op_a", { message: "from snapshot" })] }, 0);
		expect(s.byId.op_a?.message).toBe("from event");
		expect(s.seq).toBe(12);
	});

	test("a buffered event the snapshot already covers is dropped", () => {
		let s = beginSnapshot(emptyOperations, 1);
		s = applyOperationEvent(s, { seq: 9, operation: op("op_a", { message: "old" }) });
		s = applySnapshot(s, 1, { seq: 10, operations: [op("op_a", { message: "from snapshot" })] }, 0);
		expect(s.byId.op_a?.message).toBe("from snapshot");
	});

	test("events with no snapshot request yet are buffered too (the first connect)", () => {
		let s = applyOperationEvent(emptyOperations, { seq: 5, operation: op("op_a") });
		expect(s.byId.op_a).toBeUndefined();
		s = applySnapshot(beginSnapshot(s, 1), 1, { seq: 1, operations: [] }, 0);
		// begin cleared the buffer of events seen before the request started: they are covered by it
		expect(s.byId.op_a).toBeUndefined();
	});

	test("an older snapshot response is ignored", () => {
		let s = beginSnapshot(emptyOperations, 1);
		s = beginSnapshot(s, 2);
		const stale = applySnapshot(s, 1, { seq: 5, operations: [op("op_stale")] }, 0);
		expect(stale).toBe(s);
		const fresh = applySnapshot(s, 2, { seq: 9, operations: [op("op_fresh")] }, 0);
		expect(Object.keys(fresh.byId)).toEqual(["op_fresh"]);
		// and the stale one arriving after the fresh one changes nothing
		expect(applySnapshot(fresh, 1, { seq: 5, operations: [op("op_stale")] }, 0)).toBe(fresh);
	});

	test("a reconnect snapshot does not wipe a newer event that arrived while it was in flight", () => {
		let s = loaded(1, 10, [op("op_a", { message: "one" })]);
		s = beginSnapshot(s, 2);
		s = applyOperationEvent(s, { seq: 15, operation: op("op_a", { message: "newer than the snapshot" }) });
		s = applySnapshot(s, 2, { seq: 12, operations: [op("op_a", { message: "two" })] }, 0);
		expect(s.byId.op_a?.message).toBe("newer than the snapshot");
	});

	test("only an event newer than what was applied wins", () => {
		let s = loaded(1, 10, [op("op_a", { message: "from snapshot" })]);
		s = applyOperationEvent(s, { seq: 10, operation: op("op_a", { message: "stale" }) });
		expect(s.byId.op_a?.message).toBe("from snapshot");
		s = applyOperationEvent(s, { seq: 11, operation: op("op_a", { message: "newer" }) });
		expect(s.byId.op_a?.message).toBe("newer");
		s = applyOperationEvent(s, { seq: 9, operation: op("op_a", { message: "late" }) });
		expect(s.byId.op_a?.message).toBe("newer");
	});

	test("a failed snapshot request keeps the old picture and still applies what was buffered", () => {
		let s = loaded(1, 10, [op("op_a")]);
		s = beginSnapshot(s, 2);
		s = applyOperationEvent(s, { seq: 11, operation: op("op_b") });
		s = failSnapshot(s, 2);
		expect(Object.keys(s.byId).sort()).toEqual(["op_a", "op_b"]);
		expect(s.loading).toBe(false);
	});

	test("removed drops the row and respects seq", () => {
		let s = loaded(1, 1, [op("op_a")]);
		s = applyRemoved(s, { seq: 1, id: "op_a" });
		expect(s.byId.op_a).toBeDefined();
		s = applyRemoved(s, { seq: 2, id: "op_a" });
		expect(s.byId.op_a).toBeUndefined();
		expect(s.seq).toBe(2);
	});

	test("an action result is adopted, but never replaces a newer row", () => {
		let s = loaded(1, 1, [op("op_a", { updatedAt: 50, message: "newer" })]);
		s = adoptOperation(s, op("op_a", { updatedAt: 10, message: "older" }));
		expect(s.byId.op_a?.message).toBe("newer");
		s = adoptOperation(s, op("op_new"));
		expect(s.byId.op_new).toBeDefined();
	});
});

describe("operations store: what is shown", () => {
	test("a locally hidden row is left out", () => {
		let s = loaded(1, 1, [op("op_done", { state: "done", finishedAt: 10_000 }), op("op_running")]);
		s = hideOperation(s, "op_done");
		expect(visibleOperations(s).map((o) => o.id)).toEqual(["op_running"]);
	});

	test("a daemon job that runs again under the same id comes back after it was hidden", () => {
		let s = loaded(1, 1, [op("job:7", { state: "done", finishedAt: 10_000, source: "daemon" })]);
		s = hideOperation(s, "job:7");
		expect(visibleOperations(s)).toHaveLength(0);
		s = applyOperationEvent(s, { seq: 2, operation: op("job:7", { state: "running", source: "daemon" }) });
		expect(visibleOperations(s).map((o) => o.id)).toEqual(["job:7"]);
	});

	test("a retry that keeps the id is shown again too", () => {
		let s = loaded(1, 1, [op("job:7", { state: "failed", finishedAt: 10_000, error: "x" })]);
		s = hideOperation(s, "job:7");
		s = adoptOperation(s, op("job:7", { state: "queued", updatedAt: 2000 }));
		expect(visibleOperations(s)).toHaveLength(1);
	});

	test("a finished row that finished long before the snapshot is not shown; a fresh one is", () => {
		const now = 100_000;
		const s = loaded(
			1,
			1,
			[
				op("op_old", { state: "done", finishedAt: now - SHOW_FINISHED_FOR_MS - 1 }),
				op("op_fresh", { state: "done", finishedAt: now - 1000 }),
				op("op_failed", { state: "failed", finishedAt: now - 60_000, error: "boom" }),
			],
			emptyOperations,
			now,
		);
		expect(visibleOperations(s).map((o) => o.id).sort()).toEqual(["op_failed", "op_fresh"]);
	});

	test("a cancelled row with work left to run again does not age out; the others do", () => {
		expect(agesOut(op("a", { state: "cancelled", retryable: true }))).toBe(false);
		expect(agesOut(op("a", { state: "cancelled", retryable: false }))).toBe(true);
		expect(agesOut(op("a", { state: "done" }))).toBe(true);
		expect(agesOut(op("a", { state: "failed" }))).toBe(false);
		const now = 100_000;
		const s = loaded(1, 1, [op("op_c", { state: "cancelled", retryable: true, finishedAt: now - 60_000 })], emptyOperations, now);
		expect(visibleOperations(s)).toHaveLength(1);
	});

	test("rows are newest first", () => {
		const s = loaded(1, 1, [op("op_old", { startedAt: 1 }), op("op_new", { startedAt: 9 })]);
		expect(visibleOperations(s).map((o) => o.id)).toEqual(["op_new", "op_old"]);
	});
});
