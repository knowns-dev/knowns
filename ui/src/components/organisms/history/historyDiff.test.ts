import { describe, expect, test } from "bun:test";
import { PROSE_TOKEN_LIMIT, changedFiles, foldRun, snapshotChanges, textDiffMode, tokenCount } from "./historyDiff";

describe("historyDiff", () => {
	test("counts words and the spaces between them", () => {
		expect(tokenCount("")).toBe(0);
		expect(tokenCount("a b")).toBe(3);
	});

	test("small texts get a word diff, large ones a line diff", () => {
		expect(textDiffMode("a b", "a c")).toBe("prose");
		const big = Array.from({ length: PROSE_TOKEN_LIMIT }, () => "w").join(" ");
		expect(textDiffMode(big, "x")).toBe("lines");
		expect(textDiffMode("x", big)).toBe("lines");
	});

	test("maps changed fields to summary entries", () => {
		const files = changedFiles(
			[{ field: "status", oldValue: "todo", newValue: "done" }],
			(f) => f.toUpperCase(),
			(_f, v) => String(v ?? ""),
		);
		expect(files).toEqual([{ path: "STATUS", status: "modified", before: "todo", after: "done" }]);
	});

	test("lists only the fields that differ between two snapshots", () => {
		const changes = snapshotChanges(
			{ title: "A", content: "x", tags: ["a"] },
			{ title: "A", content: "y", tags: ["a", "b"] },
			["title", "description", "content", "tags"],
		);
		expect(changes.map((c) => c.field)).toEqual(["content", "tags"]);
	});

	test("folds only long unchanged runs", () => {
		expect(foldRun("short")).toBeNull();
		const folded = foldRun("a".repeat(1000));
		expect(folded?.hidden).toBe(600);
		expect(folded?.head.length).toBe(200);
	});
});
