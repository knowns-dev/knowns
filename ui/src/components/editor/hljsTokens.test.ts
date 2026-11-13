import { describe, expect, test } from "bun:test";
import hljs from "highlight.js";
import { hljsHtmlToLines, kindForScope } from "./hljsTokens";

describe("kindForScope", () => {
	test("maps compound highlight.js scopes", () => {
		expect(kindForScope("hljs-title function_")).toBe("function");
		expect(kindForScope("hljs-title class_")).toBe("type");
		expect(kindForScope("hljs-keyword")).toBe("keyword");
		expect(kindForScope("hljs-unknown-thing")).toBeNull();
	});
});

describe("hljsHtmlToLines", () => {
	test("splits lines, keeps nested kinds and decodes entities", () => {
		const lines = hljsHtmlToLines('<span class="hljs-keyword">func</span> a() &lt;-<span class="hljs-string">"x\ny"</span>');
		expect(lines).toEqual([
			[
				{ kind: "keyword", text: "func" },
				{ kind: "plain", text: " a() <-" },
				{ kind: "string", text: '"x' },
			],
			[{ kind: "string", text: 'y"' }],
		]);
	});

	test("round-trips real highlight.js output to the same text", () => {
		const code = 'package main\n\nfunc main() {\n\tfmt.Println("a < b && c")\n}';
		const lines = hljsHtmlToLines(hljs.highlight(code, { language: "go" }).value);
		expect(lines.map((line) => line.map((t) => t.text).join("")).join("\n")).toBe(code);
		expect(lines.flat().some((t) => t.kind === "keyword")).toBe(true);
	});
});
