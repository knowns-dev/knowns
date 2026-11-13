// strconv.Quote / strconv.Unquote / unicode predicates, as the Go template engine uses them.

const PRINT_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const LETTER_RE = /^\p{L}$/u;
const DIGIT_RE = /^\p{Nd}$/u;
const UPPER_RE = /^\p{Lu}$/u;
const LOWER_RE = /^\p{Ll}$/u;

/** unicode.IsPrint. */
export function isPrint(ch: string): boolean {
  if (ch === " ") return true;
  return PRINT_RE.test(ch);
}
/** unicode.IsLetter. */
export function isLetter(ch: string): boolean {
  return LETTER_RE.test(ch);
}
/** unicode.IsDigit. */
export function isDigit(ch: string): boolean {
  return DIGIT_RE.test(ch);
}
/** unicode.IsUpper. */
export function isUpper(ch: string): boolean {
  return UPPER_RE.test(ch);
}
/** unicode.IsLower. */
export function isLower(ch: string): boolean {
  return LOWER_RE.test(ch);
}
/** unicode.IsSpace. */
export function isUnicodeSpace(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 9 && c <= 13) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

function escapeRune(ch: string, quote: string, asciiOnly: boolean): string {
  const r = ch.codePointAt(0) ?? 0;
  if (ch === quote || ch === "\\") return `\\${ch}`;
  if (asciiOnly) {
    if (r < 0x80 && isPrint(ch)) return ch;
  } else if (isPrint(ch)) {
    return ch;
  }
  switch (ch) {
    case "\x07":
      return "\\a";
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    case "\v":
      return "\\v";
  }
  if (r < 0x20 || r === 0x7f) return `\\x${hex(r, 2)}`;
  if (r >= 0xd800 && r <= 0xdfff) return "�";
  if (r < 0x10000) return `\\u${hex(r, 4)}`;
  return `\\U${hex(r, 8)}`;
}

/** strconv.Quote (asciiOnly: strconv.QuoteToASCII). */
export function goQuote(s: string, asciiOnly = false): string {
  let out = '"';
  for (const ch of s) out += escapeRune(ch, '"', asciiOnly);
  return `${out}"`;
}

/** strconv.QuoteRune (asciiOnly: QuoteRuneToASCII). */
export function goQuoteRune(r: number, asciiOnly = false): string {
  let cp = r;
  if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return `'${escapeRune(String.fromCodePoint(cp), "'", asciiOnly)}'`;
}

/** strconv.CanBackquote. */
export function canBackquote(s: string): boolean {
  for (const ch of s) {
    const r = ch.codePointAt(0) ?? 0;
    if (ch === "﻿") return false;
    if (r < 0x20 && ch !== "\t") return false;
    if (ch === "`" || r === 0x7f) return false;
  }
  return true;
}

/** `%#U` formatting of a rune: U+0023 '#'. */
export function formatSharpU(r: number): string {
  let s = `U+${r.toString(16).toUpperCase().padStart(4, "0")}`;
  if (r >= 0 && r <= 0x10ffff && !(r >= 0xd800 && r <= 0xdfff)) {
    const ch = String.fromCodePoint(r);
    if (isPrint(ch)) s += ` '${ch}'`;
  }
  return s;
}

export class SyntaxError_ extends Error {
  constructor() {
    super("invalid syntax");
  }
}

interface UnquotedChar {
  value: number;
  tail: string;
}

/** strconv.UnquoteChar (the subset reachable from the template lexer). Throws SyntaxError_. */
export function unquoteChar(s: string, quote: string): UnquotedChar {
  if (s.length === 0) throw new SyntaxError_();
  const first = s.codePointAt(0) ?? 0;
  const firstCh = String.fromCodePoint(first);
  if (firstCh === quote && (quote === "'" || quote === '"')) throw new SyntaxError_();
  if (firstCh !== "\\") return { value: first, tail: s.slice(firstCh.length) };
  if (s.length <= 1) throw new SyntaxError_();
  const c = s[1] ?? "";
  let rest = s.slice(2);
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    "\\": 92,
  };
  if (c in simple) return { value: simple[c] as number, tail: rest };
  if (c === "x" || c === "u" || c === "U") {
    const n = c === "x" ? 2 : c === "u" ? 4 : 8;
    if (rest.length < n) throw new SyntaxError_();
    const digits = rest.slice(0, n);
    if (!/^[0-9a-fA-F]+$/.test(digits)) throw new SyntaxError_();
    const v = Number.parseInt(digits, 16);
    rest = rest.slice(n);
    if (c !== "x" && (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff))) throw new SyntaxError_();
    return { value: v, tail: rest };
  }
  if (c >= "0" && c <= "7") {
    if (rest.length < 2) throw new SyntaxError_();
    const digits = c + rest.slice(0, 2);
    if (!/^[0-7]{3}$/.test(digits)) throw new SyntaxError_();
    const v = Number.parseInt(digits, 8);
    if (v > 255) throw new SyntaxError_();
    return { value: v, tail: rest.slice(2) };
  }
  if ((c === "'" && quote === "'") || (c === '"' && quote === '"')) {
    return { value: c.charCodeAt(0), tail: rest };
  }
  throw new SyntaxError_();
}

/** strconv.Unquote. Throws SyntaxError_ ("invalid syntax"). */
export function goUnquote(s: string): string {
  const n = s.length;
  if (n < 2) throw new SyntaxError_();
  const quote = s[0] ?? "";
  if (quote !== s[n - 1]) throw new SyntaxError_();
  const body = s.slice(1, n - 1);
  if (quote === "`") {
    if (body.includes("`")) throw new SyntaxError_();
    return body.includes("\r") ? body.replaceAll("\r", "") : body;
  }
  if (quote !== '"' && quote !== "'") throw new SyntaxError_();
  if (body.includes("\n")) throw new SyntaxError_();
  let out = "";
  let rest = body;
  let count = 0;
  while (rest.length > 0) {
    const { value, tail } = unquoteChar(rest, quote);
    rest = tail;
    // \x and octal escapes denote bytes; the template lexer only needs the common case, so bytes
    // >= 0x80 produced by those escapes are mapped to the code point (Go would emit raw bytes).
    out += String.fromCodePoint(value);
    count++;
    if (quote === "'" && (rest.length !== 0 || count !== 1)) throw new SyntaxError_();
  }
  if (quote === "'" && count !== 1) throw new SyntaxError_();
  return out;
}
