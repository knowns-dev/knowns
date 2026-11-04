// Port of text/template/parse/lex.go (Go 1.26). Positions are JS string indexes; the parser
// converts to UTF-8 byte offsets only for error locations.
import { formatSharpU, goQuote, isDigit, isLetter, isPrint } from "./goquote.ts";
import { utf8Length } from "./govalue.ts";

export type ItemType =
  | "error"
  | "bool"
  | "char"
  | "charConstant"
  | "comment"
  | "complex"
  | "assign"
  | "declare"
  | "eof"
  | "field"
  | "identifier"
  | "leftDelim"
  | "leftParen"
  | "number"
  | "pipe"
  | "rawString"
  | "rightDelim"
  | "rightParen"
  | "space"
  | "string"
  | "text"
  | "variable"
  // keywords
  | "block"
  | "break"
  | "continue"
  | "dot"
  | "define"
  | "else"
  | "end"
  | "if"
  | "nil"
  | "range"
  | "template"
  | "with";

export interface Item {
  typ: ItemType;
  pos: number;
  val: string;
  line: number;
}

const KEYWORDS: Record<string, ItemType> = {
  ".": "dot",
  block: "block",
  break: "break",
  continue: "continue",
  define: "define",
  else: "else",
  end: "end",
  if: "if",
  range: "range",
  nil: "nil",
  template: "template",
  with: "with",
};

const KEYWORD_TYPES = new Set<ItemType>([
  "block",
  "break",
  "continue",
  "dot",
  "define",
  "else",
  "end",
  "if",
  "nil",
  "range",
  "template",
  "with",
]);

/** item.String(): how the parser prints a token in "unexpected ..." errors. */
export function itemString(i: Item): string {
  if (i.typ === "eof") return "EOF";
  if (i.typ === "error") return i.val;
  if (KEYWORD_TYPES.has(i.typ)) return `<${i.val}>`;
  if (utf8Length(i.val) > 10) {
    // %.10q: the string truncated to 10 runes, then quoted
    return `${goQuote([...i.val].slice(0, 10).join(""))}...`;
  }
  return goQuote(i.val);
}

const LEFT_DELIM = "{{";
const RIGHT_DELIM = "}}";
const LEFT_COMMENT = "/*";
const RIGHT_COMMENT = "*/";
const SPACE_CHARS = " \t\r\n";
const TRIM_MARKER_LEN = 2;

export const EOF = null;
type Rune = string | null;

export function isSpace(r: Rune): boolean {
  return r === " " || r === "\t" || r === "\r" || r === "\n";
}

export function isAlphaNumeric(r: Rune): boolean {
  return r !== null && (r === "_" || isLetter(r) || isDigit(r));
}

function hasLeftTrimMarker(s: string): boolean {
  return s.length >= 2 && s[0] === "-" && isSpace(s[1] ?? null);
}

function hasRightTrimMarker(s: string): boolean {
  return s.length >= 2 && isSpace(s[0] ?? null) && s[1] === "-";
}

function trimRightSpace(s: string): string {
  let e = s.length;
  while (e > 0 && SPACE_CHARS.includes(s[e - 1] ?? "\u0000")) e--;
  return s.slice(0, e);
}

function trimLeftLength(s: string): number {
  let i = 0;
  while (i < s.length && SPACE_CHARS.includes(s[i] ?? "\u0000")) i++;
  return i;
}

type State = (() => State | null) | null;

export class Lexer {
  input: string;
  pos = 0;
  start = 0;
  atEOF = false;
  parenDepth = 0;
  line = 1;
  startLine = 1;
  item: Item = { typ: "eof", pos: 0, val: "EOF", line: 1 };
  insideAction = false;
  readonly options = { emitComment: false, breakOK: false, continueOK: false };

  constructor(
    readonly name: string,
    input: string,
  ) {
    this.input = input;
  }

  private next(): Rune {
    if (this.pos >= this.input.length) {
      this.atEOF = true;
      return EOF;
    }
    const cp = this.input.codePointAt(this.pos) ?? 0;
    const ch = String.fromCodePoint(cp);
    this.pos += ch.length;
    if (ch === "\n") this.line++;
    return ch;
  }

  private peek(): Rune {
    const r = this.next();
    this.backup();
    return r;
  }

  private backup(): void {
    if (!this.atEOF && this.pos > 0) {
      let w = 1;
      const lo = this.input.charCodeAt(this.pos - 1);
      if (lo >= 0xdc00 && lo <= 0xdfff && this.pos >= 2) {
        const hi = this.input.charCodeAt(this.pos - 2);
        if (hi >= 0xd800 && hi <= 0xdbff) w = 2;
      }
      this.pos -= w;
      if (this.input[this.pos] === "\n") this.line--;
    }
  }

  private thisItem(t: ItemType): Item {
    const i: Item = {
      typ: t,
      pos: this.start,
      val: this.input.slice(this.start, this.pos),
      line: this.startLine,
    };
    this.start = this.pos;
    this.startLine = this.line;
    return i;
  }

  private emit(t: ItemType): State {
    return this.emitItem(this.thisItem(t));
  }

  private emitItem(i: Item): State {
    this.item = i;
    return null;
  }

  private ignore(): void {
    this.line += countNewlines(this.input.slice(this.start, this.pos));
    this.start = this.pos;
    this.startLine = this.line;
  }

  private accept(valid: string): boolean {
    const r = this.next();
    if (r !== null && valid.includes(r)) return true;
    this.backup();
    return false;
  }

  private acceptRun(valid: string): void {
    for (;;) {
      const r = this.next();
      if (r === null || !valid.includes(r)) break;
    }
    this.backup();
  }

  private errorf(msg: string): State {
    this.item = { typ: "error", pos: this.start, val: msg, line: this.startLine };
    this.start = 0;
    this.pos = 0;
    this.input = "";
    return null;
  }

  nextItem(): Item {
    this.item = { typ: "eof", pos: this.pos, val: "EOF", line: this.startLine };
    let state: State = this.insideAction ? () => this.lexInsideAction() : () => this.lexText();
    while (state !== null) {
      state = state();
    }
    return this.item;
  }

  // --- states ---

  private lexText(): State {
    const x = this.input.indexOf(LEFT_DELIM, this.pos);
    if (x >= 0) {
      if (x > this.pos) {
        this.pos = x;
        let trimLength = 0;
        const delimEnd = this.pos + LEFT_DELIM.length;
        if (hasLeftTrimMarker(this.input.slice(delimEnd))) {
          const seg = this.input.slice(this.start, this.pos);
          trimLength = seg.length - trimRightSpace(seg).length;
        }
        this.pos -= trimLength;
        this.line += countNewlines(this.input.slice(this.start, this.pos));
        const i = this.thisItem("text");
        this.pos += trimLength;
        this.ignore();
        if (i.val.length > 0) return this.emitItem(i);
      }
      return () => this.lexLeftDelim();
    }
    this.pos = this.input.length;
    if (this.pos > this.start) {
      this.line += countNewlines(this.input.slice(this.start, this.pos));
      return this.emit("text");
    }
    return this.emit("eof");
  }

  private atRightDelim(): { delim: boolean; trim: boolean } {
    const rest = this.input.slice(this.pos);
    if (hasRightTrimMarker(rest) && rest.slice(TRIM_MARKER_LEN).startsWith(RIGHT_DELIM)) {
      return { delim: true, trim: true };
    }
    if (rest.startsWith(RIGHT_DELIM)) return { delim: true, trim: false };
    return { delim: false, trim: false };
  }

  private lexLeftDelim(): State {
    this.pos += LEFT_DELIM.length;
    const trimSpace = hasLeftTrimMarker(this.input.slice(this.pos));
    const afterMarker = trimSpace ? TRIM_MARKER_LEN : 0;
    if (this.input.slice(this.pos + afterMarker).startsWith(LEFT_COMMENT)) {
      this.pos += afterMarker;
      this.ignore();
      return () => this.lexComment();
    }
    const i = this.thisItem("leftDelim");
    this.insideAction = true;
    this.pos += afterMarker;
    this.ignore();
    this.parenDepth = 0;
    return this.emitItem(i);
  }

  private lexComment(): State {
    this.pos += LEFT_COMMENT.length;
    const x = this.input.indexOf(RIGHT_COMMENT, this.pos);
    if (x < 0) return this.errorf("unclosed comment");
    this.pos = x + RIGHT_COMMENT.length;
    const { delim, trim } = this.atRightDelim();
    if (!delim) return this.errorf("comment ends before closing delimiter");
    this.line += countNewlines(this.input.slice(this.start, this.pos));
    const i = this.thisItem("comment");
    if (trim) this.pos += TRIM_MARKER_LEN;
    this.pos += RIGHT_DELIM.length;
    if (trim) this.pos += trimLeftLength(this.input.slice(this.pos));
    this.ignore();
    if (this.options.emitComment) return this.emitItem(i);
    return () => this.lexText();
  }

  private lexRightDelim(): State {
    const { trim } = this.atRightDelim();
    if (trim) {
      this.pos += TRIM_MARKER_LEN;
      this.ignore();
    }
    this.pos += RIGHT_DELIM.length;
    const i = this.thisItem("rightDelim");
    if (trim) {
      this.pos += trimLeftLength(this.input.slice(this.pos));
      this.ignore();
    }
    this.insideAction = false;
    return this.emitItem(i);
  }

  private lexInsideAction(): State {
    const { delim } = this.atRightDelim();
    if (delim) {
      if (this.parenDepth === 0) return () => this.lexRightDelim();
      return this.errorf("unclosed left paren");
    }
    const r = this.next();
    if (r === null) return this.errorf("unclosed action");
    if (isSpace(r)) {
      this.backup();
      return () => this.lexSpace();
    }
    switch (r) {
      case "=":
        return this.emit("assign");
      case ":":
        if (this.next() !== "=") return this.errorf("expected :=");
        return this.emit("declare");
      case "|":
        return this.emit("pipe");
      case '"':
        return () => this.lexQuote();
      case "`":
        return () => this.lexRawQuote();
      case "$":
        return () => this.lexVariable();
      case "'":
        return () => this.lexChar();
      case ".": {
        if (this.pos < this.input.length) {
          const c = this.input[this.pos] ?? "";
          if (c < "0" || c > "9") return () => this.lexField();
        }
        this.backup();
        return () => this.lexNumber();
      }
      case "+":
      case "-":
        this.backup();
        return () => this.lexNumber();
      case "(":
        this.parenDepth++;
        return this.emit("leftParen");
      case ")":
        this.parenDepth--;
        if (this.parenDepth < 0) return this.errorf("unexpected right paren");
        return this.emit("rightParen");
    }
    if (r >= "0" && r <= "9") {
      this.backup();
      return () => this.lexNumber();
    }
    if (isAlphaNumeric(r)) {
      this.backup();
      return () => this.lexIdentifier();
    }
    const cp = r.codePointAt(0) ?? 0;
    if (cp <= 0x7f && isPrint(r)) return this.emit("char");
    return this.errorf(`unrecognized character in action: ${formatSharpU(cp)}`);
  }

  private lexSpace(): State {
    let numSpaces = 0;
    for (;;) {
      const r = this.peek();
      if (!isSpace(r)) break;
      this.next();
      numSpaces++;
    }
    const tail = this.input.slice(this.pos - 1);
    if (
      hasRightTrimMarker(tail) &&
      this.input.slice(this.pos - 1 + TRIM_MARKER_LEN).startsWith(RIGHT_DELIM)
    ) {
      this.backup();
      if (numSpaces === 1) return () => this.lexRightDelim();
    }
    return this.emit("space");
  }

  private lexIdentifier(): State {
    for (;;) {
      const r = this.next();
      if (isAlphaNumeric(r)) continue;
      this.backup();
      const word = this.input.slice(this.start, this.pos);
      if (!this.atTerminator()) return this.errorf(`bad character ${formatSharpU(runeOf(r))}`);
      const kw = KEYWORDS[word];
      if (kw !== undefined && KEYWORD_TYPES.has(kw)) {
        if (
          (kw === "break" && !this.options.breakOK) ||
          (kw === "continue" && !this.options.continueOK)
        ) {
          return this.emit("identifier");
        }
        return this.emit(kw);
      }
      if (word.startsWith(".")) return this.emit("field");
      if (word === "true" || word === "false") return this.emit("bool");
      return this.emit("identifier");
    }
  }

  private lexField(): State {
    return this.lexFieldOrVariable("field");
  }

  private lexVariable(): State {
    if (this.atTerminator()) return this.emit("variable");
    return this.lexFieldOrVariable("variable");
  }

  private lexFieldOrVariable(typ: "field" | "variable"): State {
    if (this.atTerminator()) {
      if (typ === "variable") return this.emit("variable");
      return this.emit("dot");
    }
    let r: Rune;
    for (;;) {
      r = this.next();
      if (!isAlphaNumeric(r)) {
        this.backup();
        break;
      }
    }
    if (!this.atTerminator()) return this.errorf(`bad character ${formatSharpU(runeOf(r))}`);
    return this.emit(typ);
  }

  private atTerminator(): boolean {
    const r = this.peek();
    if (isSpace(r)) return true;
    if (r === EOF || r === "." || r === "," || r === "|" || r === ":" || r === ")" || r === "(") {
      return true;
    }
    return this.input.slice(this.pos).startsWith(RIGHT_DELIM);
  }

  private lexChar(): State {
    for (;;) {
      const r = this.next();
      if (r === "\\") {
        const r2 = this.next();
        if (r2 !== EOF && r2 !== "\n") continue;
        return this.errorf("unterminated character constant");
      }
      if (r === EOF || r === "\n") return this.errorf("unterminated character constant");
      if (r === "'") break;
    }
    return this.emit("charConstant");
  }

  private lexNumber(): State {
    if (!this.scanNumber()) {
      return this.errorf(`bad number syntax: ${goQuote(this.input.slice(this.start, this.pos))}`);
    }
    const sign = this.peek();
    if (sign === "+" || sign === "-") {
      if (!this.scanNumber() || this.input[this.pos - 1] !== "i") {
        return this.errorf(`bad number syntax: ${goQuote(this.input.slice(this.start, this.pos))}`);
      }
      return this.emit("complex");
    }
    return this.emit("number");
  }

  private scanNumber(): boolean {
    this.accept("+-");
    let digits = "0123456789_";
    if (this.accept("0")) {
      if (this.accept("xX")) digits = "0123456789abcdefABCDEF_";
      else if (this.accept("oO")) digits = "01234567_";
      else if (this.accept("bB")) digits = "01_";
    }
    this.acceptRun(digits);
    if (this.accept(".")) this.acceptRun(digits);
    if (digits.length === 11 && this.accept("eE")) {
      this.accept("+-");
      this.acceptRun("0123456789_");
    }
    if (digits.length === 23 && this.accept("pP")) {
      this.accept("+-");
      this.acceptRun("0123456789_");
    }
    this.accept("i");
    if (isAlphaNumeric(this.peek())) {
      this.next();
      return false;
    }
    return true;
  }

  private lexQuote(): State {
    for (;;) {
      const r = this.next();
      if (r === "\\") {
        const r2 = this.next();
        if (r2 !== EOF && r2 !== "\n") continue;
        return this.errorf("unterminated quoted string");
      }
      if (r === EOF || r === "\n") return this.errorf("unterminated quoted string");
      if (r === '"') break;
    }
    return this.emit("string");
  }

  private lexRawQuote(): State {
    for (;;) {
      const r = this.next();
      if (r === EOF) return this.errorf("unterminated raw quoted string");
      if (r === "`") break;
    }
    return this.emit("rawString");
  }
}

function runeOf(r: Rune): number {
  return r === null ? 0xfffd : (r.codePointAt(0) ?? 0xfffd);
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}
