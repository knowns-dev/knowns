export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "literal" | "type" | "function" | "tag" | "attr" | "variable" | "inserted" | "deleted";

export interface CodeToken {
  kind: TokenKind;
  text: string;
  /** A colour of your own (any CSS colour), for a custom highlighter whose themes are not our kinds. It wins over `kind`. */
  color?: string;
  /** The same token's colour in dark mode. Without it `color` is used in both. */
  darkColor?: string;
}

/** One entry per line of code, each a list of coloured runs. This is also what a `highlight` slot returns. */
export type CodeLines = CodeToken[][];

/** Longest code the built-in tokenizer colours. Beyond it the code is shown plain, so a huge paste never blocks the page. */
export const MAX_HIGHLIGHT = 60_000;

const ALIASES: Record<string, Lang> = {
  js: "js", jsx: "jsx", ts: "js", tsx: "jsx", mjs: "js", cjs: "js", javascript: "js", typescript: "js", node: "js",
  json: "json", jsonc: "json", json5: "json",
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash", console: "bash", terminal: "bash",
  css: "css", scss: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
  py: "python", python: "python",
  yaml: "yaml", yml: "yaml",
  diff: "diff", patch: "diff",
};
type Lang = "js" | "jsx" | "json" | "bash" | "css" | "html" | "python" | "yaml" | "diff";

/** Names shown in the header for the languages above. Unknown languages are shown as typed. */
const LABELS: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", json: "JSON", jsonc: "JSON",
  bash: "Bash", sh: "Shell", shell: "Shell", zsh: "Zsh", console: "Console", terminal: "Terminal", css: "CSS", scss: "SCSS", html: "HTML", xml: "XML",
  svg: "SVG", py: "Python", python: "Python", yaml: "YAML", yml: "YAML", diff: "Diff", patch: "Patch", text: "Text", txt: "Text", plain: "Text",
};

export const languageLabel = (language: string | undefined) => (language ? LABELS[language.toLowerCase()] ?? language : undefined);

const KEYWORDS: Record<"js" | "python" | "bash" | "css", Set<string>> = {
  js: new Set(
    ("abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield")
      .split(" "),
  ),
  python: new Set(
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self match case".split(" "),
  ),
  bash: new Set("if then else elif fi for while until do done case esac in function select time export local readonly return exit".split(" ")),
  css: new Set([]),
};
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "True", "False", "None"]);

type Rule = [RegExp, TokenKind | ((m: RegExpExecArray, ctx: Ctx) => TokenKind)];
interface Ctx {
  /** Previous non-space character before this match, "" at the start of a line. */
  prev: string;
  /** The character right before this match (any kind), "" at the very start. */
  raw: string;
  atLineStart: boolean;
  depth: number;
  inTag: boolean;
  atCommand: boolean;
  after: string;
}

const sticky = (source: string) => new RegExp(source, "y");
const STR_DQ = `"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?`;
const STR_SQ = `'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?`;
const STR_BT = "`(?:\\\\[\\s\\S]|[^`\\\\])*`?";
const NUM = `\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?)\\b`;
const IDENT = `[A-Za-z_$][\\w$]*`;

const identKind = (kw: Set<string>) => (m: RegExpExecArray, c: Ctx): TokenKind => {
  const w = m[0];
  if (kw.has(w)) return "keyword";
  if (LITERALS.has(w)) return "literal";
  if (/^\s*\(/.test(c.after)) return "function";
  if (/^[A-Z]/.test(w) && w.length > 1) return "type";
  return "plain";
};

const RULES: Record<Exclude<Lang, "diff">, Rule[]> = {
  js: [
    [sticky(`//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)`), "comment"],
    [sticky(`${STR_DQ}|${STR_SQ}|${STR_BT}`), "string"],
    [sticky(NUM), "number"],
    [sticky(IDENT), identKind(KEYWORDS.js)],
  ],
  jsx: [
    [sticky(`//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)`), "comment"],
    // <Tag and </Tag, not comparisons or generics: it needs a name and a space, slash or > after it.
    [sticky(`</?(?:[A-Za-z][\\w.]*)?(?=[\\s/>])`), (_m, c) => (c.prev === "" || !/[\w$)\]]/.test(c.prev) ? "tag" : "plain")],
    [sticky(`${STR_DQ}|${STR_SQ}|${STR_BT}`), "string"],
    [sticky(NUM), "number"],
    [sticky(IDENT), identKind(KEYWORDS.js)],
  ],
  json: [
    [sticky(`//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)`), "comment"],
    [sticky(`"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?`), (_m, c) => (/^\s*:/.test(c.after) ? "attr" : "string")],
    [sticky(`-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`), "number"],
    [sticky(`\\b(?:true|false|null)\\b`), "literal"],
  ],
  bash: [
    [sticky(`#[^\\n]*`), (_m, c) => (c.raw === "" || /\s/.test(c.raw) ? "comment" : "plain")],
    [sticky(`${STR_DQ}|${STR_SQ}`), "string"],
    [sticky(`\\$(?:\\{[^}\\n]*\\}|[A-Za-z_]\\w*|[@#?*$!0-9])`), "variable"],
    [sticky(`--?[A-Za-z][\\w-]*(?:=)?`), (_m, c) => (c.raw === "" || /\s/.test(c.raw) ? "attr" : "plain")],
    [sticky(NUM), "number"],
    [sticky(`[A-Za-z_][\\w.:/@-]*`), (m, c) => (KEYWORDS.bash.has(m[0]) ? "keyword" : c.atCommand ? "function" : "plain")],
  ],
  css: [
    [sticky(`/\\*[\\s\\S]*?(?:\\*/|$)`), "comment"],
    [sticky(`${STR_DQ}|${STR_SQ}`), "string"],
    [sticky(`@[\\w-]+`), "keyword"],
    [sticky(`--[\\w-]+`), "variable"],
    [sticky(`#[\\da-fA-F]{3,8}\\b`), "number"],
    [sticky(`-?(?:\\d*\\.)?\\d+(?:px|rem|em|%|vh|vw|dvh|ch|s|ms|deg|fr)?\\b`), (_m, c) => (c.depth > 0 ? "number" : "plain")],
    [sticky(`[\\w-]+(?=\\s*:)`), (_m, c) => (c.depth > 0 ? "attr" : "type")],
    [sticky(`[.#][\\w-]+`), "type"],
    [sticky(`[A-Za-z][\\w-]*(?=\\s*\\()`), "function"],
  ],
  html: [
    [sticky(`<!--[\\s\\S]*?(?:-->|$)`), "comment"],
    [sticky(`</?[A-Za-z][\\w:.-]*`), "tag"],
    [sticky(`${STR_DQ}|${STR_SQ}`), (_m, c) => (c.inTag ? "string" : "plain")],
    [sticky(`[\\w:@.-]+(?=\\s*=)`), (_m, c) => (c.inTag ? "attr" : "plain")],
  ],
  python: [
    [sticky(`#[^\\n]*`), "comment"],
    [sticky(`(?:[rRbBfFuU]{0,2})(?:"""[\\s\\S]*?(?:"""|$)|'''[\\s\\S]*?(?:'''|$))`), "string"],
    [sticky(`(?:[rRbBfFuU]{0,2})(?:${STR_DQ}|${STR_SQ})`), "string"],
    [sticky(`@[A-Za-z_][\\w.]*`), "function"],
    [sticky(NUM), "number"],
    [sticky(`[A-Za-z_]\\w*`), (m, c) => (KEYWORDS.python.has(m[0]) ? "keyword" : LITERALS.has(m[0]) ? "literal" : /^\s*\(/.test(c.after) ? "function" : /^[A-Z]/.test(m[0]) && m[0].length > 1 ? "type" : "plain")],
  ],
  yaml: [
    [sticky(`#[^\\n]*`), (_m, c) => (c.raw === "" || /\s/.test(c.raw) ? "comment" : "plain")],
    [sticky(`${STR_DQ}|${STR_SQ}`), (_m, c) => (/^\s*:(?:\s|$)/.test(c.after) ? "attr" : "string")],
    [sticky(`[A-Za-z_][\\w.-]*(?=\\s*:(?:\\s|$))`), "attr"],
    [sticky(`-?\\d+(?:\\.\\d+)?\\b`), "number"],
    [sticky(`\\b(?:true|false|null|yes|no|on|off)\\b`), "literal"],
    [sticky(`[&*][\\w-]+`), "variable"],
  ],
};

/** Resolves a language name or alias to one the built-in tokenizer knows, or undefined (shown plain). */
export function resolveLanguage(language: string | undefined): Lang | undefined {
  return language ? ALIASES[language.toLowerCase()] : undefined;
}

/** Splits tokens that contain newlines, so every line owns its runs. */
function toLines(tokens: CodeToken[]): CodeLines {
  const lines: CodeLines = [[]];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ kind: t.kind, text: part });
    });
  }
  return lines;
}

/** Plain lines, no colour. */
export function plainLines(code: string): CodeLines {
  return code.split("\n").map((l) => (l ? [{ kind: "plain" as const, text: l }] : []));
}

/** The built-in tokenizer: code in, one list of coloured runs per line out. Synchronous, so it runs the same in RSC, the browser and a Worker. */
export function tokenize(code: string, language?: string): CodeLines {
  const text = code.replace(/\r\n?/g, "\n");
  const lang = resolveLanguage(language);
  if (!lang || text.length > MAX_HIGHLIGHT) return plainLines(text);
  if (lang === "diff") {
    return text.split("\n").map((l) => {
      const kind: TokenKind = /^(\+\+\+|---)/.test(l) ? "keyword" : l.startsWith("+") ? "inserted" : l.startsWith("-") ? "deleted" : l.startsWith("@@") ? "keyword" : "plain";
      return l ? [{ kind, text: l }] : [];
    });
  }
  const rules = RULES[lang];
  const out: CodeToken[] = [];
  const push = (kind: TokenKind, s: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += s;
    else out.push({ kind, text: s });
  };
  const ctx: Ctx = { prev: "", raw: "", atLineStart: true, depth: 0, inTag: false, atCommand: true, after: "" };
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const [re, kindOf] of rules) {
      re.lastIndex = i;
      ctx.raw = text[i - 1] ?? "";
      const m = re.exec(text);
      if (!m || m[0] === "") continue;
      ctx.after = text.slice(i + m[0].length, i + m[0].length + 24);
      const kind = typeof kindOf === "function" ? kindOf(m, ctx) : kindOf;
      push(kind, m[0]);
      i += m[0].length;
      if (/\S/.test(m[0])) {
        ctx.prev = m[0].slice(-1);
        ctx.atLineStart = false;
        if (lang === "bash") ctx.atCommand = kind === "keyword" && /^(?:then|else|elif|do|if|while|until|time)$/.test(m[0]);
        if (lang === "html" && kind === "tag") ctx.inTag = true;
      }
      matched = true;
      break;
    }
    if (matched) continue;
    const ch = text[i++];
    push("plain", ch);
    if (ch === "\n") {
      if (lang === "bash") ctx.atCommand = ctx.prev !== "\\";
      ctx.prev = "";
      ctx.atLineStart = true;
    } else if (/\S/.test(ch)) {
      ctx.prev = ch;
      ctx.atLineStart = false;
      if (lang === "css") ctx.depth = Math.max(0, ctx.depth + (ch === "{" ? 1 : ch === "}" ? -1 : 0));
      if (lang === "html" && ch === ">") ctx.inTag = false;
      if (lang === "bash") ctx.atCommand = ch === "|" || ch === ";" || ch === "&" || ch === "(" || (ch === "\\" ? ctx.atCommand : false);
    }
  }
  return toLines(out);
}

/** Colours for each token kind. Tailwind palette steps picked for 4.5:1 text on the muted code surface in light and dark. */
export const TOKEN_CLASS: Record<Exclude<TokenKind, "plain" | "inserted" | "deleted">, string> = {
  comment: "text-muted-foreground italic",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  keyword: "text-violet-700 dark:text-violet-300",
  literal: "text-violet-700 dark:text-violet-300",
  type: "text-sky-700 dark:text-sky-300",
  function: "text-blue-700 dark:text-blue-300",
  tag: "text-rose-700 dark:text-rose-300",
  attr: "text-amber-800 dark:text-amber-200",
  variable: "text-teal-700 dark:text-teal-300",
};

/**
 * Which lines to highlight: a number, a list, or a string such as "1,3-5" or "8-" (to the end).
 * Out-of-range and malformed parts are ignored. Returns 1-based line numbers.
 */
export function parseLineSpec(spec: number | number[] | string | undefined, total: number): Set<number> {
  const out = new Set<number>();
  if (spec === undefined || total < 1) return out;
  const add = (a: number, b: number) => {
    for (let n = Math.max(1, a); n <= Math.min(total, b); n++) out.add(n);
  };
  if (typeof spec === "number") add(spec, spec);
  else if (Array.isArray(spec)) spec.forEach((n) => Number.isInteger(n) && add(n, n));
  else {
    for (const part of spec.split(",")) {
      const m = /^\s*(\d+)\s*(?:(-)\s*(\d*))?\s*$/.exec(part);
      if (!m) continue;
      const a = Number(m[1]);
      add(a, m[2] ? (m[3] ? Number(m[3]) : total) : a);
    }
  }
  return out;
}

/**
 * How many lines to show. `collapseAfter` is the limit; a block that is only a line or two over the limit stays open,
 * since "Show 1 more line" saves nothing.
 */
export function visibleCount(total: number, collapseAfter: number | undefined, expanded: boolean): { shown: number; hidden: number; collapsible: boolean } {
  if (!collapseAfter || collapseAfter < 1 || total <= collapseAfter + 2) return { shown: total, hidden: 0, collapsible: false };
  return expanded ? { shown: total, hidden: 0, collapsible: true } : { shown: collapseAfter, hidden: total - collapseAfter, collapsible: true };
}

/** Width in `ch` of the line-number gutter. */
export const gutterWidth = (total: number) => Math.max(2, String(total).length) + 1;

/** Code with the trailing newlines trimmed, which template literals nearly always carry. */
export const trimCode = (code: string) => code.replace(/^\n+/, "").replace(/\s+$/, "");
