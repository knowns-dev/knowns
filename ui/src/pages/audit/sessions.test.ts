import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "@/ui/api/client";
import { SESSION_GAP_MS, sameCall, sessionOf, sessionize, toTrace } from "./sessions";

const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 9, 0, s)).toISOString();
const call = (s: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
	timestamp: at(s),
	toolName: "tasks",
	action: "get",
	actionClass: "read",
	result: "success",
	durationMs: 100,
	client: "claude-code",
	...over,
});

describe("sessionize", () => {
	test("keeps calls close together in one session, oldest first", () => {
		const sessions = sessionize([call(20), call(0), call(10)]);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.events.map((e) => e.timestamp)).toEqual([at(0), at(10), at(20)]);
	});

	test("a pause longer than the gap starts a new session", () => {
		const gap = SESSION_GAP_MS / 1000;
		expect(sessionize([call(0), call(gap)])).toHaveLength(1);
		expect(sessionize([call(0), call(gap + 1)])).toHaveLength(2);
	});

	test("the gap counts from the end of a long call", () => {
		expect(sessionize([call(0, { durationMs: 50_000 }), call(100)])).toHaveLength(1);
	});

	test("a different client starts a new session, calls without one share a bucket", () => {
		const sessions = sessionize([call(0), call(5, { client: "codex" }), call(10, { client: undefined }), call(15, { client: undefined })]);
		expect(sessions.map((s) => s.client)).toEqual(["claude-code", "codex", null]);
		expect(sessions[2]?.events).toHaveLength(2);
	});

	test("a single call is a session, a bad timestamp is skipped", () => {
		expect(sessionize([call(0)])).toHaveLength(1);
		expect(sessionize([call(0, { timestamp: "nope" })])).toHaveLength(0);
	});

	test("an overlapping call does not end the session early", () => {
		const sessions = sessionize([call(0, { durationMs: 5000 }), call(1), call(80)]);
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.events).toHaveLength(2);
	});

	test("sessionOf finds the session of a call", () => {
		const a = call(0);
		const b = call(500);
		const sessions = sessionize([a, b]);
		expect(sessionOf(sessions, b)?.events).toEqual([b]);
	});
});

describe("toTrace", () => {
	test("marks errors and denials in the text and as failures", () => {
		const session = sessionize([
			call(0),
			call(1, { result: "error", errorMessage: "task not found" }),
			call(2, { toolName: "tasks", action: "delete", result: "denied", errorMessage: "Policy blocks delete" }),
		])[0]!;
		const { actors, spans } = toTrace(session);
		expect(actors.map((a) => a.id)).toEqual(["client", "tool:tasks"]);
		expect(spans.map((s) => s.outcome)).toEqual(["success", "failure", "failure"]);
		expect(spans[1]?.summary).toBe("Error: tasks.get: task not found");
		expect(spans[2]?.summary).toBe("Denied: tasks.delete: Policy blocks delete");
		expect(spans[0]?.summary).toBe("tasks.get");
	});
});

describe("a call read twice", () => {
	test("sameCall matches a copy, and the session is found for the copy without duplicating it", () => {
		const burst = [call(0), call(1, { result: "error", errorMessage: "x" }), call(2, { action: "delete", result: "denied" })];
		const copy = JSON.parse(JSON.stringify(burst[2])) as AuditEvent;
		expect(sameCall(burst[2]!, copy)).toBe(true);
		const all = burst.some((other) => sameCall(other, copy)) ? burst : [...burst, copy];
		const session = sessionOf(sessionize(all), copy);
		expect(session?.events).toHaveLength(3);
	});
});
