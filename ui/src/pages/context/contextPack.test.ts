import { describe, expect, test } from "bun:test";
import { estimateTokens, itemHref, packRows, packSegments } from "./contextPack";

const items = [
	{ type: "doc", id: "guides/setup", title: "Setup", content: "x".repeat(40) },
	{ type: "task", id: "KN-1", title: "Fix", content: "y".repeat(9), directMatch: true },
	{ type: "doc", id: "readme", title: "", content: "" },
	{ type: "code", id: "a.ts", title: "a", content: "z" },
];

describe("contextPack", () => {
	test("estimates four characters per token, rounding up", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});

	test("rows carry size, score and link, and skip unknown types", () => {
		const rows = packRows(items, [{ type: "doc", id: "guides/setup", score: 0.9 }]);
		expect(rows.map((r) => r.key)).toEqual(["doc:guides/setup", "task:KN-1", "doc:readme"]);
		expect(rows[0]!).toMatchObject({ tokens: 10, score: 0.9, href: "/docs/guides/setup" });
		expect(rows[1]!).toMatchObject({ tokens: 3, score: null, directMatch: true, href: "/tasks/KN-1" });
		expect(rows[2]!.title).toBe("readme");
	});

	test("segments group by type in a fixed order with summed tokens", () => {
		const segments = packSegments(packRows(items));
		expect(segments.map((s) => s.id)).toEqual(["doc", "task"]);
		expect(segments[0]!.tokens).toBe(10);
		expect(segments[0]!.parts?.length).toBe(2);
	});

	test("no items give no segments", () => {
		expect(packSegments([])).toEqual([]);
	});

	test("hrefs encode ids per type", () => {
		expect(itemHref("memory", "ab c")).toBe("/memory/ab%20c");
		expect(itemHref("decision", "d1")).toBe("/decisions/d1");
	});
});
