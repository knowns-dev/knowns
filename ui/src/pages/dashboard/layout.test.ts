import { expect, test } from "bun:test";

import { DEFAULT_LAYOUT, isDefaultLayout, moveItem, normalizeLayout } from "./layout";

test("a missing or broken saved layout falls back to the default", () => {
	expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
	expect(normalizeLayout("x")).toEqual(DEFAULT_LAYOUT);
});

test("a saved layout keeps its order, drops unknown ids and appends new widgets", () => {
	const saved = { main: ["progress", "gone", "continue", "progress"], side: ["problems"], hidden: ["attention", "nope"] };
	expect(normalizeLayout(saved)).toEqual({
		main: ["progress", "continue", "attention"],
		side: ["problems", "review", "activity"],
		hidden: ["attention"],
	});
});

test("isDefaultLayout notices a hidden widget or a new order", () => {
	expect(isDefaultLayout(DEFAULT_LAYOUT)).toBe(true);
	expect(isDefaultLayout({ ...DEFAULT_LAYOUT, hidden: ["summary"] })).toBe(false);
	expect(isDefaultLayout({ ...DEFAULT_LAYOUT, main: moveItem(DEFAULT_LAYOUT.main, 0, 1) })).toBe(false);
});

test("moveItem swaps with a neighbour and ignores moves past either end", () => {
	expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
	expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
	expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
	expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
});
