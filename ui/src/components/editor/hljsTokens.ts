import type { CodeLines, TokenKind } from "@/ui/components/ui/knowns/code-block/code-block-utils";

/**
 * highlight.js scope classes mapped onto the Knowns UI code-block token kinds, so a language the
 * built-in tokenizer does not colour (go, rust, sql, ...) still gets the same palette.
 */
const SCOPE_KIND: Record<string, TokenKind> = {
	comment: "comment",
	quote: "comment",
	doctag: "comment",
	string: "string",
	regexp: "string",
	char: "string",
	number: "number",
	literal: "literal",
	symbol: "literal",
	bullet: "literal",
	keyword: "keyword",
	built_in: "keyword",
	"meta-keyword": "keyword",
	meta: "keyword",
	selector: "keyword",
	"selector-tag": "tag",
	type: "type",
	class: "type",
	"title.class": "type",
	"title.class.inherited": "type",
	function: "function",
	"title.function": "function",
	"title.function.invoke": "function",
	title: "function",
	section: "function",
	tag: "tag",
	name: "tag",
	attr: "attr",
	attribute: "attr",
	property: "attr",
	"selector-attr": "attr",
	"selector-class": "attr",
	"selector-id": "attr",
	variable: "variable",
	"variable.language": "keyword",
	"template-variable": "variable",
	params: "variable",
	subst: "variable",
	addition: "inserted",
	deletion: "deleted",
};

/** "hljs-title function_" -> "title.function"; unknown scopes fall back to their first part. */
export function kindForScope(className: string): TokenKind | null {
	const parts = className
		.split(/\s+/)
		.filter(Boolean)
		.map((p) => p.replace(/^hljs-/, "").replace(/_+$/, ""));
	if (parts.length === 0) return null;
	const joined = parts.join(".");
	return SCOPE_KIND[joined] ?? SCOPE_KIND[parts[0]!] ?? null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#x27": "'", "#39": "'" };

function decode(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
		const known = ENTITIES[name.toLowerCase()];
		if (known) return known;
		if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
		return match;
	});
}

/**
 * Turns highlight.js HTML (nested `<span class="hljs-...">`) into code-block tokens, one array per
 * line. A span without a known scope keeps the kind of the span around it.
 */
export function hljsHtmlToLines(html: string): CodeLines {
	const lines: CodeLines = [[]];
	const stack: TokenKind[] = [];
	const push = (raw: string) => {
		if (!raw) return;
		const kind = stack[stack.length - 1] ?? "plain";
		const pieces = decode(raw).split("\n");
		pieces.forEach((piece, index) => {
			if (index > 0) lines.push([]);
			if (!piece) return;
			const line = lines[lines.length - 1]!;
			const last = line[line.length - 1];
			if (last && last.kind === kind) last.text += piece;
			else line.push({ kind, text: piece });
		});
	};
	const tag = /<span class="([^"]*)">|<\/span>/g;
	let at = 0;
	for (let m = tag.exec(html); m; m = tag.exec(html)) {
		push(html.slice(at, m.index));
		if (m[0] === "</span>") stack.pop();
		else stack.push(kindForScope(m[1] ?? "") ?? stack[stack.length - 1] ?? "plain");
		at = m.index + m[0].length;
	}
	push(html.slice(at));
	return lines;
}
