// Pure helpers of internal/lsp/queries.go (symbol lookup in source text). The Go code works on
// UTF-8 bytes; the byte-offset quirks are kept by running on latin1 "binary strings".
import { readFileSync } from "node:fs";
import { goFsError } from "../platform/goerror.ts";

const isLetterOrDigit = (code: number): boolean => {
  const ch = String.fromCharCode(code);
  return /\p{L}|\p{Nd}/u.test(ch);
};

/** isSymbolRune(rune(byte)) as Go evaluates it for a single byte of a line. */
function isSymbolByte(code: number): boolean {
  return code === 0x5f || isLetterOrDigit(code);
}

/** isSymbolRune for a real rune (used by codeOnlyLine neighbours, kept for parity). */
export function isSymbolRune(r: string): boolean {
  return r === "_" || /\p{L}|\p{Nd}/u.test(r);
}

/** utf16Col converts a byte offset into line (UTF-8 bytes) to a UTF-16 column. */
export function utf16Col(line: Uint8Array, byteOffsetIn: number): number {
  const byteOffset = Math.min(byteOffsetIn, line.length);
  let col = 0;
  let i = 0;
  while (i < byteOffset) {
    const b = line[i] as number;
    let size = 1;
    let cp = 0xfffd;
    if (b < 0x80) {
      cp = b;
    } else if (b >= 0xc2 && b <= 0xdf && cont(line, i + 1)) {
      size = 2;
      cp = ((b & 0x1f) << 6) | ((line[i + 1] as number) & 0x3f);
    } else if (b >= 0xe0 && b <= 0xef && cont(line, i + 1) && cont(line, i + 2)) {
      const c =
        ((b & 0x0f) << 12) |
        (((line[i + 1] as number) & 0x3f) << 6) |
        ((line[i + 2] as number) & 0x3f);
      if (c >= 0x800 && !(c >= 0xd800 && c <= 0xdfff)) {
        size = 3;
        cp = c;
      }
    } else if (
      b >= 0xf0 &&
      b <= 0xf4 &&
      cont(line, i + 1) &&
      cont(line, i + 2) &&
      cont(line, i + 3)
    ) {
      const c =
        ((b & 0x07) << 18) |
        (((line[i + 1] as number) & 0x3f) << 12) |
        (((line[i + 2] as number) & 0x3f) << 6) |
        ((line[i + 3] as number) & 0x3f);
      if (c >= 0x10000 && c <= 0x10ffff) {
        size = 4;
        cp = c;
      }
    }
    col += cp > 0xffff ? 2 : 1;
    i += size;
  }
  return col;
}

function cont(line: Uint8Array, i: number): boolean {
  const b = line[i];
  return b !== undefined && (b & 0xc0) === 0x80;
}

/** codeOnlyLine masks comments and string literals with spaces (rune for rune). */
export function codeOnlyLine(line: string, inBlockCommentIn: boolean): [string, boolean] {
  const runes = Array.from(line);
  const out = runes.map(() => " ");
  let inBlockComment = inBlockCommentIn;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i] as string;
    const next = runes[i + 1];
    if (inBlockComment) {
      if (next !== undefined && r === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (!escaped && r === quote) inString = false;
      escaped = !escaped && r === "\\" && quote !== "`";
      continue;
    }
    if (next !== undefined && r === "/" && next === "/") break;
    if (next !== undefined && r === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (r === '"' || r === "'" || r === "`") {
      inString = true;
      quote = r;
      escaped = false;
      continue;
    }
    out[i] = r;
  }
  return [out.join(""), inBlockComment];
}

function symbolBoundary(line: string, start: number, length: number): boolean {
  const beforeOK = start === 0 || !isSymbolByte(line.charCodeAt(start - 1));
  const end = start + length;
  const afterOK = end >= line.length || !isSymbolByte(line.charCodeAt(end));
  return beforeOK && afterOK;
}

function quoteMeta(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}

function binary(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/** FindSymbolPosition returns the 0-based line and UTF-16 column of the first code occurrence of query. */
export function findSymbolPosition(path: string, query: string): [number, number] {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (e) {
    throw goFsError("open", path, e);
  }
  const q = binary(query);
  const pattern = new RegExp(`\\b${quoteMeta(q)}\\b`, "g");
  const lines = data.toString("utf8").split("\n");
  let inBlockComment = false;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] as string;
    const [masked, nextInBlock] = codeOnlyLine(line, inBlockComment);
    inBlockComment = nextInBlock;
    const searchLine = binary(masked);
    pattern.lastIndex = 0;
    for (let m = pattern.exec(searchLine); m !== null; m = pattern.exec(searchLine)) {
      if (m[0].length === 0) pattern.lastIndex++;
      if (symbolBoundary(searchLine, m.index, q.length)) {
        return [lineNo, utf16Col(Buffer.from(line, "utf8"), m.index)];
      }
    }
  }
  throw new Error(`symbol ${JSON.stringify(query)} not found in ${path}`);
}

/** Snippet returns the trimmed text of a 0-based line, or "". */
export function snippet(path: string, line: number): string {
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = data.split("\n");
  if (line < 0 || line >= lines.length) return "";
  return (lines[line] as string).trim();
}

/** NameAt returns the identifier covering a 0-based byte column of a line. */
export function nameAt(path: string, line: number, col: number): string {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return "";
  }
  const lines = data.toString("latin1").split("\n");
  if (line < 0 || line >= lines.length) return "";
  const text = lines[line] as string;
  if (col < 0 || col >= text.length) return "";
  let start = col;
  let end = col;
  while (start > 0 && isSymbolByte(text.charCodeAt(start - 1))) start--;
  while (end < text.length && isSymbolByte(text.charCodeAt(end))) end++;
  return Buffer.from(text.slice(start, end), "latin1").toString("utf8");
}

/** Byte-offset column to UTF-16 for the given line of a file (Go: locations/Rename prologue). */
export function columnForLine(path: string, line: number, col: number): number {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return col;
  }
  const lines = data.toString("latin1").split("\n");
  if (line >= 0 && line < lines.length) {
    return utf16Col(Buffer.from(lines[line] as string, "latin1"), col);
  }
  return col;
}
