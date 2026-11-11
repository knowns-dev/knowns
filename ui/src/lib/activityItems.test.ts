import { describe, expect, test } from "bun:test";
import { activityActor, activityId, activityKind, activitySummary, toActivityItem, toNotificationItem } from "./activityItems";

const base = (over: Record<string, unknown> = {}) =>
	({
		taskId: "abc123",
		taskTitle: "Fix login",
		version: 3,
		timestamp: new Date(1_700_000_000_000),
		changes: [{ field: "status", oldValue: "todo", newValue: "done" }],
		...over,
	}) as never;

describe("activityActor", () => {
	test("mcp client becomes a named agent", () => {
		expect(activityActor("mcp:claude-code")).toEqual({ name: "Claude Code", agent: true });
		expect(activityActor("mcp:some-new-tool")).toEqual({ name: "Some New Tool", agent: true });
	});
	test("people and missing authors", () => {
		expect(activityActor("@howznguyen")).toEqual({ name: "@howznguyen", agent: false });
		expect(activityActor(undefined)).toEqual({ name: "Someone", agent: false });
	});
});

describe("activity mapping", () => {
	test("kind and summary", () => {
		expect(activityKind(base())).toBe("status");
		expect(activitySummary(base())).toBe("completed");
		expect(activityKind(base({ changes: [{ field: "assignee", oldValue: "", newValue: "@me" }] }))).toBe("assignee");
		expect(activityKind(base({ changes: [{ field: "description", oldValue: "a", newValue: "b" }] }))).toBe("content");
	});
	test("ids and unread flow through", () => {
		expect(activityId(base())).toBe("abc123:3");
		const item = toActivityItem(base({ author: "mcp:claude-code" }), () => true);
		expect(item).toMatchObject({ id: "abc123:3", at: 1_700_000_000_000, type: "status", unread: true, object: "#abc123 Fix login" });
		expect(item.actor.agent).toBe(true);
		const note = toNotificationItem(base({ author: "mcp:claude-code" }), () => false);
		expect(note).toMatchObject({ type: "agent", read: true });
		expect(toNotificationItem(base(), () => true).type).toBe("update");
	});
});
