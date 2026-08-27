import { expect, test } from "bun:test";

import { canonicalizeSemanticReference, transformMentions } from "./mentionUtils";
import { parseSource } from "../molecules/SourceLinkList";

// Task IDs carry a configurable prefix (settings.defaultTaskIdPrefix), so `OLM-H9PKPY`
// is one ID — the hyphen inside it is not a separator. Truncating at that hyphen used
// to send `@task/OLM` to /api/resolve, which returns found:false, so the badge rendered
// broken and swallowed its own click.
const PREFIXED = [
	["@task-OLM-H9PKPY", "@task/OLM-H9PKPY"],
	["@task/OLM-H9PKPY", "@task/OLM-H9PKPY"],
	["@task-OLM-H9PKPY{blocked-by}", "@task/OLM-H9PKPY{blocked-by}"],
	["@task/OLM-H9PKPY.1", "@task/OLM-H9PKPY.1"],
] as const;

const LEGACY = [
	["@task-8icoij", "@task/8icoij"],
	["@task/8icoij", "@task/8icoij"],
	["@task-8icoij{blocked-by}", "@task/8icoij{blocked-by}"],
	["@task-8icoij.1", "@task/8icoij.1"],
] as const;

for (const [raw, canonical] of [...PREFIXED, ...LEGACY]) {
	test(`canonicalizes ${raw}`, () => {
		expect(canonicalizeSemanticReference(raw)).toBe(canonical);
	});

	test(`links ${raw} in prose`, () => {
		const out = transformMentions(`See ${raw} here.`);
		expect(out).toContain(`[${canonical}]`);
		// The whole ID must live inside the link, never trail it as bare text.
		expect(out).not.toMatch(/\)-/);
	});
}

test("keeps sentence punctuation outside the reference", () => {
	expect(transformMentions("Blocked by @task/OLM-H9PKPY.")).toBe(
		"Blocked by [@task/OLM-H9PKPY](knowns-ref:%40task%2FOLM-H9PKPY).",
	);
});

test("resolves prefixed IDs in the `- title` output form", () => {
	expect(transformMentions("@task-OLM-H9PKPY - Record supersession")).toContain(
		"[@task/OLM-H9PKPY]",
	);
});

test("parseSource keeps prefixed task IDs whole", () => {
	expect(parseSource("@task/OLM-H9PKPY")).toEqual({ kind: "task", id: "OLM-H9PKPY" });
	expect(parseSource("@task-OLM-H9PKPY")).toEqual({ kind: "task", id: "OLM-H9PKPY" });
	expect(parseSource("@task/8icoij")).toEqual({ kind: "task", id: "8icoij" });
});
