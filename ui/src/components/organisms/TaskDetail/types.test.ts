import { describe, expect, test } from "bun:test";
import { formatTracked, moveItem, statusTone } from "./types";

describe("moveItem", () => {
	test("moves an item down and up", () => {
		expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
	});
	test("clamps the target and returns the same list for no-ops", () => {
		const list = ["a", "b"];
		expect(moveItem(list, 1, 5)).toBe(list);
		expect(moveItem(list, 0, -1)).toBe(list);
		expect(moveItem(list, 4, 0)).toBe(list);
	});
});

describe("statusTone", () => {
	test("uses defaults, then config colours", () => {
		expect(statusTone("done")).toBe("success");
		expect(statusTone("in-progress")).toBe("info");
		expect(statusTone("custom")).toBe("neutral");
		expect(statusTone("custom", { custom: "red" })).toBe("danger");
	});
});

describe("formatTracked", () => {
	test("formats seconds as hours and minutes", () => {
		expect(formatTracked(0)).toBe("0m");
		expect(formatTracked(30)).toBe("30s");
		expect(formatTracked(1800)).toBe("30m");
		expect(formatTracked(6300)).toBe("1h 45m");
		expect(formatTracked(7200)).toBe("2h");
	});
});
