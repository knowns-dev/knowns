// Port of text/template/parse (parse.go + node.go, Go 1.26) with the function set the codegen
// engine registers. Errors are GoTemplateError with Go's exact text.
import { type Item, type ItemType, itemString, Lexer } from "./golex.ts";
import { goQuote, goUnquote, unquoteChar } from "./goquote.ts";
import { utf8Length } from "./govalue.ts";

export class GoTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoTemplateError";
  }
}

// --- nodes --------------------------------------------------------------------------------------

interface Base {
  pos: number;
  tr: Tree | null;
}

export interface ListNode extends Base {
  kind: "list";
  nodes: Node[];
}
export interface TextNode extends Base {
  kind: "text";
  text: string;
}
export interface CommentNode extends Base {
  kind: "comment";
  text: string;
}
export interface PipeNode extends Base {
  kind: "pipe";
  line: number;
  isAssign: boolean;
  decl: VariableNode[];
  cmds: CommandNode[];
}
export interface ActionNode extends Base {
  kind: "action";
  line: number;
  pipe: PipeNode;
}
export interface CommandNode extends Base {
  kind: "command";
  args: Node[];
}
export interface IdentifierNode extends Base {
  kind: "identifier";
  ident: string;
}
export interface VariableNode extends Base {
  kind: "variable";
  ident: string[];
}
export interface DotNode extends Base {
  kind: "dot";
}
export interface NilNode extends Base {
  kind: "nil";
}
export interface FieldNode extends Base {
  kind: "field";
  ident: string[];
}
export interface ChainNode extends Base {
  kind: "chain";
  node: Node;
  field: string[];
}
export interface BoolNode extends Base {
  kind: "bool";
  value: boolean;
}
export interface NumberNode extends Base {
  kind: "number";
  isInt: boolean;
  isUint: boolean;
  isFloat: boolean;
  isComplex: boolean;
  int64: bigint;
  uint64: bigint;
  float64: number;
  complex: { re: number; im: number };
  text: string;
}
export interface StringNode extends Base {
  kind: "string";
  quoted: string;
  text: string;
}
export interface EndNode extends Base {
  kind: "end";
}
export interface ElseNode extends Base {
  kind: "else";
  line: number;
}
export interface BranchNode extends Base {
  kind: "if" | "range" | "with";
  line: number;
  pipe: PipeNode;
  list: ListNode;
  elseList: ListNode | null;
}
export interface BreakNode extends Base {
  kind: "break";
  line: number;
}
export interface ContinueNode extends Base {
  kind: "continue";
  line: number;
}
export interface TemplateNode extends Base {
  kind: "template";
  line: number;
  name: string;
  pipe: PipeNode | null;
}

export type Node =
  | ListNode
  | TextNode
  | CommentNode
  | PipeNode
  | ActionNode
  | CommandNode
  | IdentifierNode
  | VariableNode
  | DotNode
  | NilNode
  | FieldNode
  | ChainNode
  | BoolNode
  | NumberNode
  | StringNode
  | EndNode
  | ElseNode
  | BranchNode
  | BreakNode
  | ContinueNode
  | TemplateNode;

/** Node.String(). */
export function nodeString(n: Node): string {
  switch (n.kind) {
    case "list":
      return n.nodes.map(nodeString).join("");
    case "text":
      return n.text;
    case "comment":
      return `{{${n.text}}}`;
    case "pipe": {
      let s = "";
      if (n.decl.length > 0) {
        s += n.decl.map(nodeString).join(", ");
        s += n.isAssign ? " = " : " := ";
      }
      s += n.cmds.map(nodeString).join(" | ");
      return s;
    }
    case "action":
      return `{{${nodeString(n.pipe)}}}`;
    case "command":
      return n.args
        .map((a) => (a.kind === "pipe" ? `(${nodeString(a)})` : nodeString(a)))
        .join(" ");
    case "identifier":
      return n.ident;
    case "variable":
      return n.ident.join(".");
    case "dot":
      return ".";
    case "nil":
      return "nil";
    case "field":
      return n.ident.map((id) => `.${id}`).join("");
    case "chain": {
      let s = n.node.kind === "pipe" ? `(${nodeString(n.node)})` : nodeString(n.node);
      for (const f of n.field) s += `.${f}`;
      return s;
    }
    case "bool":
      return n.value ? "true" : "false";
    case "number":
      return n.text;
    case "string":
      return n.quoted;
    case "end":
      return "{{end}}";
    case "else":
      return "{{else}}";
    case "if":
    case "range":
    case "with": {
      let s = `{{${n.kind} ${nodeString(n.pipe)}}}${nodeString(n.list)}`;
      if (n.elseList) s += `{{else}}${nodeString(n.elseList)}`;
      return `${s}{{end}}`;
    }
    case "break":
      return "{{break}}";
    case "continue":
      return "{{continue}}";
    case "template": {
      let s = `{{template ${goQuote(n.name)}`;
      if (n.pipe) s += ` ${nodeString(n.pipe)}`;
      return `${s}}}`;
    }
  }
}

// --- number parsing (strconv) --------------------------------------------------------------------

function underscoreOK(str: string): boolean {
  let saw = "^";
  let i = 0;
  let s = str;
  if (s.length >= 1 && (s[0] === "-" || s[0] === "+")) s = s.slice(1);
  let hex = false;
  const p = (s[1] ?? "").toLowerCase();
  if (s.length >= 2 && s[0] === "0" && (p === "b" || p === "o" || p === "x")) {
    i = 2;
    saw = "0";
    hex = p === "x";
  }
  for (; i < s.length; i++) {
    const c = s[i] ?? "";
    if ((c >= "0" && c <= "9") || (hex && c.toLowerCase() >= "a" && c.toLowerCase() <= "f")) {
      saw = "0";
      continue;
    }
    if (c === "_") {
      if (saw !== "0") return false;
      saw = "_";
      continue;
    }
    if (saw === "_") return false;
    saw = "!";
  }
  return saw !== "_";
}

/** strconv.ParseUint/ParseInt(text, 0, 64). Returns null on syntax or range error. */
function parseIntBase0(text: string, signed: boolean): bigint | null {
  let s = text;
  if (s === "") return null;
  let neg = false;
  if (signed && (s[0] === "+" || s[0] === "-")) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  let base = 10;
  const l1 = (s[1] ?? "").toLowerCase();
  if (s[0] === "0") {
    if (s.length >= 3 && l1 === "b") {
      base = 2;
      s = s.slice(2);
    } else if (s.length >= 3 && l1 === "o") {
      base = 8;
      s = s.slice(2);
    } else if (s.length >= 3 && l1 === "x") {
      base = 16;
      s = s.slice(2);
    } else {
      base = 8;
      s = s.slice(1);
    }
  }
  if (!underscoreOK(text.replace(/^[+-]/, ""))) {
    if (text.includes("_")) return null;
  }
  if (text.includes("_") && !underscoreOK(text)) return null;
  s = s.replaceAll("_", "");
  if (s === "") {
    // "0" alone: base 8 with empty remainder is the literal zero.
    return text.replace(/^[+-]/, "") === "0" ? 0n : null;
  }
  const re =
    base === 2 ? /^[01]+$/ : base === 8 ? /^[0-7]+$/ : base === 10 ? /^\d+$/ : /^[0-9a-fA-F]+$/;
  if (!re.test(s)) return null;
  const prefix = base === 16 ? "0x" : base === 8 ? "0o" : base === 2 ? "0b" : "";
  const v = BigInt(prefix + s);
  if (signed) {
    const limit = neg ? 1n << 63n : (1n << 63n) - 1n;
    if (v > limit) return null;
    return neg ? -v : v;
  }
  if (v >= 1n << 64n) return null;
  return v;
}

function parseGoFloat(text: string): number | null {
  let s = text;
  if (s.includes("_")) {
    if (!underscoreOK(s)) return null;
    s = s.replaceAll("_", "");
  }
  let sign = 1;
  let body = s;
  if (body[0] === "+" || body[0] === "-") {
    if (body[0] === "-") sign = -1;
    body = body.slice(1);
  }
  if (/^0[xX]/.test(body)) {
    const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(body);
    if (!m) return null;
    const ip = m[1] ?? "";
    const fp = m[2] ?? "";
    if (ip === "" && fp === "") return null;
    const mant = Number.parseInt(`${ip}${fp}` || "0", 16);
    const v = mant * 2 ** (Number.parseInt(m[3] ?? "0", 10) - 4 * fp.length);
    if (!Number.isFinite(v)) return null;
    return sign * v;
  }
  if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body)) return null;
  const v = Number(body);
  if (!Number.isFinite(v)) return null;
  return sign * v;
}

function newNumber(
  tr: Tree,
  pos: number,
  text: string,
  typ: ItemType,
): { node: NumberNode | null; err?: string } {
  const n: NumberNode = {
    kind: "number",
    tr,
    pos,
    isInt: false,
    isUint: false,
    isFloat: false,
    isComplex: false,
    int64: 0n,
    uint64: 0n,
    float64: 0,
    complex: { re: 0, im: 0 },
    text,
  };
  if (typ === "charConstant") {
    try {
      const { value, tail } = unquoteChar(text.slice(1), text[0] ?? "'");
      if (tail !== "'") return { node: null, err: `malformed character constant: ${text}` };
      n.int64 = BigInt(value);
      n.isInt = true;
      n.uint64 = BigInt(value);
      n.isUint = true;
      n.float64 = value;
      n.isFloat = true;
      return { node: n };
    } catch (e) {
      return { node: null, err: (e as Error).message };
    }
  }
  if (typ === "complex") {
    const c = parseComplex(text);
    if (!c) return { node: null, err: "expected complex number" };
    n.complex = c;
    n.isComplex = true;
    simplifyComplex(n);
    return { node: n };
  }
  if (text.length > 0 && text.endsWith("i")) {
    const f = parseGoFloat(text.slice(0, -1));
    if (f !== null) {
      n.isComplex = true;
      n.complex = { re: 0, im: f };
      simplifyComplex(n);
      return { node: n };
    }
  }
  const u = parseIntBase0(text, false);
  if (u !== null) {
    n.isUint = true;
    n.uint64 = u;
  }
  const i = parseIntBase0(text, true);
  if (i !== null) {
    n.isInt = true;
    n.int64 = i;
    if (i === 0n) {
      n.isUint = true;
      n.uint64 = u ?? 0n;
    }
  }
  if (n.isInt) {
    n.isFloat = true;
    n.float64 = Number(n.int64);
  } else if (n.isUint) {
    n.isFloat = true;
    n.float64 = Number(n.uint64);
  } else {
    const f = parseGoFloat(text);
    if (f !== null) {
      if (!/[.eEpP]/.test(text)) return { node: null, err: `integer overflow: ${goQuote(text)}` };
      n.isFloat = true;
      n.float64 = f;
      if (!n.isInt && Number.isInteger(f) && Math.abs(f) < 2 ** 63) {
        n.isInt = true;
        n.int64 = BigInt(f);
      }
      if (!n.isUint && Number.isInteger(f) && f >= 0 && f < 2 ** 64) {
        n.isUint = true;
        n.uint64 = BigInt(f);
      }
    }
  }
  if (!n.isInt && !n.isUint && !n.isFloat) {
    return { node: null, err: `illegal number syntax: ${goQuote(text)}` };
  }
  return { node: n };
}

function parseComplex(text: string): { re: number; im: number } | null {
  const m = /^([+-]?[^+-]+)([+-][^+-]*)i$/.exec(
    text.replace(/e[+-]/gi, (x) => x.replace(/[+-]/, "#")),
  );
  if (!m) return null;
  const re = parseGoFloat((m[1] ?? "").replaceAll("#", "-"));
  const im = parseGoFloat((m[2] ?? "").replaceAll("#", "-"));
  if (re === null || im === null) return null;
  return { re, im };
}

function simplifyComplex(n: NumberNode): void {
  n.isFloat = n.complex.im === 0;
  if (n.isFloat) {
    n.float64 = n.complex.re;
    n.isInt = Number.isInteger(n.float64) && Math.abs(n.float64) < 2 ** 63;
    if (n.isInt) n.int64 = BigInt(n.float64);
    n.isUint = Number.isInteger(n.float64) && n.float64 >= 0 && n.float64 < 2 ** 64;
    if (n.isUint) n.uint64 = BigInt(n.float64);
  }
}

// --- the tree -----------------------------------------------------------------------------------

const MAX_STACK_DEPTH = 10000;

export class Tree {
  root: ListNode | null = null;
  parseName = "";
  text = "";
  private lex: Lexer | null = null;
  private readonly token: Item[] = [
    { typ: "eof", pos: 0, val: "", line: 0 },
    { typ: "eof", pos: 0, val: "", line: 0 },
    { typ: "eof", pos: 0, val: "", line: 0 },
  ];
  private peekCount = 0;
  private vars: string[] = [];
  private treeSet: Map<string, Tree> | null = null;
  private actionLine = 0;
  private rangeDepth = 0;
  private stackDepth = 0;

  constructor(
    public name: string,
    private funcs: Set<string>,
  ) {}

  // --- token plumbing ---

  private lexer(): Lexer {
    if (!this.lex) throw new Error("parser has no lexer");
    return this.lex;
  }

  private tok(i: number): Item {
    return this.token[i] as Item;
  }

  private next(): Item {
    if (this.peekCount > 0) this.peekCount--;
    else this.token[0] = this.lexer().nextItem();
    return this.tok(this.peekCount);
  }

  private backup(): void {
    this.peekCount++;
  }

  private backup2(t1: Item): void {
    this.token[1] = t1;
    this.peekCount = 2;
  }

  private backup3(t2: Item, t1: Item): void {
    this.token[1] = t1;
    this.token[2] = t2;
    this.peekCount = 3;
  }

  private peek(): Item {
    if (this.peekCount > 0) return this.tok(this.peekCount - 1);
    this.peekCount = 1;
    this.token[0] = this.lexer().nextItem();
    return this.tok(0);
  }

  private nextNonSpace(): Item {
    let t: Item;
    do {
      t = this.next();
    } while (t.typ === "space");
    return t;
  }

  private peekNonSpace(): Item {
    const t = this.nextNonSpace();
    this.backup();
    return t;
  }

  // --- errors ---

  /** ErrorContext: "name:line:col" and the node text. */
  errorContext(n: Node): { location: string; context: string } {
    const pos = n.pos;
    const tree = n.tr ?? this;
    const text = tree.text.slice(0, pos);
    const nl = text.lastIndexOf("\n");
    let byteNum: number;
    if (nl === -1) byteNum = utf8Length(text);
    else byteNum = utf8Length(text.slice(nl + 1));
    const lineNum = 1 + (text.match(/\n/g)?.length ?? 0);
    return { location: `${tree.parseName}:${lineNum}:${byteNum}`, context: nodeString(n) };
  }

  private errorf(msg: string): never {
    this.root = null;
    throw new GoTemplateError(`template: ${this.parseName}:${this.tok(0).line}: ${msg}`);
  }

  private unexpected(token: Item, context: string): never {
    if (token.typ === "error") {
      let extra = "";
      if (this.actionLine !== 0 && this.actionLine !== token.line) {
        extra = ` in action started at ${this.parseName}:${this.actionLine}`;
        if (token.val.endsWith(" action")) extra = extra.slice(" in action".length);
      }
      this.errorf(`${itemString(token)}${extra}`);
    }
    this.errorf(`unexpected ${itemString(token)} in ${context}`);
  }

  private expect(expected: ItemType, context: string): Item {
    const token = this.nextNonSpace();
    if (token.typ !== expected) this.unexpected(token, context);
    return token;
  }

  private expectOneOf(e1: ItemType, e2: ItemType, context: string): Item {
    const token = this.nextNonSpace();
    if (token.typ !== e1 && token.typ !== e2) this.unexpected(token, context);
    return token;
  }

  // --- parse entry ---

  startParse(lex: Lexer, treeSet: Map<string, Tree>): void {
    this.root = null;
    this.lex = lex;
    this.vars = ["$"];
    this.treeSet = treeSet;
    this.stackDepth = 0;
    lex.options.emitComment = false;
    lex.options.breakOK = !this.funcs.has("break");
    lex.options.continueOK = !this.funcs.has("continue");
  }

  private stopParse(): void {
    this.lex = null;
    this.vars = [];
    this.treeSet = null;
  }

  parseText(text: string, treeSet: Map<string, Tree>): Tree {
    try {
      this.parseName = this.name;
      const lexer = new Lexer(this.name, text);
      this.startParse(lexer, treeSet);
      this.text = text;
      this.parse();
      this.add();
      this.stopParse();
      return this;
    } catch (e) {
      this.stopParse();
      throw e;
    }
  }

  private add(): void {
    const set = this.treeSet as Map<string, Tree>;
    const tree = set.get(this.name);
    if (!tree || isEmptyTree(tree.root)) {
      set.set(this.name, this);
      return;
    }
    if (!isEmptyTree(this.root)) {
      this.errorf(`template: multiple definition of template ${goQuote(this.name)}`);
    }
  }

  private newList(pos: number): ListNode {
    return { kind: "list", tr: this, pos, nodes: [] };
  }

  private parse(): void {
    this.root = this.newList(this.peek().pos);
    while (this.peek().typ !== "eof") {
      if (this.peek().typ === "leftDelim") {
        const delim = this.next();
        if (this.nextNonSpace().typ === "define") {
          const newT = new Tree("definition", this.funcs);
          newT.text = this.text;
          newT.parseName = this.parseName;
          newT.startParse(this.lexer(), this.treeSet as Map<string, Tree>);
          newT.parseDefinition();
          continue;
        }
        this.backup2(delim);
      }
      const n = this.textOrAction();
      if (n.kind === "end" || n.kind === "else") this.errorf(`unexpected ${nodeString(n)}`);
      this.root.nodes.push(n);
    }
  }

  private parseDefinition(): void {
    const context = "define clause";
    const name = this.expectOneOf("string", "rawString", context);
    try {
      this.name = goUnquote(name.val);
    } catch (e) {
      this.errorf((e as Error).message);
    }
    this.expect("rightDelim", context);
    const { list, end } = this.itemList();
    this.root = list;
    if (end.kind !== "end") this.errorf(`unexpected ${nodeString(end)} in ${context}`);
    this.add();
    this.stopParse();
  }

  private itemList(): { list: ListNode; end: Node } {
    const list = this.newList(this.peekNonSpace().pos);
    while (this.peekNonSpace().typ !== "eof") {
      const n = this.textOrAction();
      if (n.kind === "end" || n.kind === "else") return { list, end: n };
      list.nodes.push(n);
    }
    return this.errorf("unexpected EOF");
  }

  private textOrAction(): Node {
    const token = this.nextNonSpace();
    switch (token.typ) {
      case "text":
        return { kind: "text", tr: this, pos: token.pos, text: token.val };
      case "leftDelim": {
        this.actionLine = token.line;
        try {
          return this.action();
        } finally {
          this.actionLine = 0;
        }
      }
      case "comment":
        return { kind: "comment", tr: this, pos: token.pos, text: token.val };
      default:
        return this.unexpected(token, "input");
    }
  }

  private action(): Node {
    const token = this.nextNonSpace();
    switch (token.typ) {
      case "block":
        return this.blockControl();
      case "break":
        return this.breakControl(token.pos, token.line);
      case "continue":
        return this.continueControl(token.pos, token.line);
      case "else":
        return this.elseControl();
      case "end":
        return this.endControl();
      case "if":
        return this.parseBranch("if");
      case "range":
        return this.parseBranch("range");
      case "template":
        return this.templateControl();
      case "with":
        return this.parseBranch("with");
    }
    this.backup();
    const t = this.peek();
    return {
      kind: "action",
      tr: this,
      pos: t.pos,
      line: t.line,
      pipe: this.pipeline("command", "rightDelim"),
    };
  }

  private breakControl(pos: number, line: number): Node {
    const token = this.nextNonSpace();
    if (token.typ !== "rightDelim") this.unexpected(token, "{{break}}");
    if (this.rangeDepth === 0) this.errorf("{{break}} outside {{range}}");
    return { kind: "break", tr: this, pos, line };
  }

  private continueControl(pos: number, line: number): Node {
    const token = this.nextNonSpace();
    if (token.typ !== "rightDelim") this.unexpected(token, "{{continue}}");
    if (this.rangeDepth === 0) this.errorf("{{continue}} outside {{range}}");
    return { kind: "continue", tr: this, pos, line };
  }

  private newVariable(pos: number, ident: string): VariableNode {
    return { kind: "variable", tr: this, pos, ident: ident.split(".") };
  }

  private newField(pos: number, ident: string): FieldNode {
    return { kind: "field", tr: this, pos, ident: ident.slice(1).split(".") };
  }

  private pipeline(context: string, end: ItemType): PipeNode {
    const token = this.peekNonSpace();
    const pipe: PipeNode = {
      kind: "pipe",
      tr: this,
      pos: token.pos,
      line: token.line,
      isAssign: false,
      decl: [],
      cmds: [],
    };
    for (;;) {
      const v = this.peekNonSpace();
      if (v.typ !== "variable") break;
      this.next();
      const tokenAfterVariable = this.peek();
      const next = this.peekNonSpace();
      if (next.typ === "assign" || next.typ === "declare") {
        pipe.isAssign = next.typ === "assign";
        this.nextNonSpace();
        pipe.decl.push(this.newVariable(v.pos, v.val));
        this.vars.push(v.val);
      } else if (next.typ === "char" && next.val === ",") {
        this.nextNonSpace();
        pipe.decl.push(this.newVariable(v.pos, v.val));
        this.vars.push(v.val);
        if (context === "range" && pipe.decl.length < 2) {
          const t = this.peekNonSpace().typ;
          if (t === "variable" || t === "rightDelim" || t === "rightParen") continue;
          this.errorf("range can only initialize variables");
        }
        this.errorf(`too many declarations in ${context}`);
      } else if (tokenAfterVariable.typ === "space") {
        this.backup3(v, tokenAfterVariable);
      } else {
        this.backup2(v);
      }
      break;
    }
    for (;;) {
      const t = this.nextNonSpace();
      if (t.typ === end) {
        this.checkPipeline(pipe, context);
        return pipe;
      }
      switch (t.typ) {
        case "bool":
        case "charConstant":
        case "complex":
        case "dot":
        case "field":
        case "identifier":
        case "number":
        case "nil":
        case "rawString":
        case "string":
        case "variable":
        case "leftParen":
          this.backup();
          pipe.cmds.push(this.command());
          break;
        default:
          this.unexpected(t, context);
      }
    }
  }

  private checkPipeline(pipe: PipeNode, context: string): void {
    if (pipe.cmds.length === 0) this.errorf(`missing value for ${context}`);
    pipe.cmds.slice(1).forEach((c, i) => {
      const first = c.args[0];
      if (
        first &&
        (first.kind === "bool" ||
          first.kind === "dot" ||
          first.kind === "nil" ||
          first.kind === "number" ||
          first.kind === "string")
      ) {
        this.errorf(`non executable command in pipeline stage ${i + 2}`);
      }
    });
  }

  private parseBranch(kind: "if" | "range" | "with"): Node {
    const mark = this.vars.length;
    try {
      const pipe = this.pipeline(kind, "rightDelim");
      if (kind === "range") this.rangeDepth++;
      const r = this.itemList();
      const list = r.list;
      let next = r.end;
      if (kind === "range") this.rangeDepth--;
      let elseList: ListNode | null = null;
      if (next.kind === "else") {
        if (kind === "if" && this.peek().typ === "if") {
          this.next();
          elseList = this.newList(next.pos);
          elseList.nodes.push(this.parseBranch("if"));
        } else if (kind === "with" && this.peek().typ === "with") {
          this.next();
          elseList = this.newList(next.pos);
          elseList.nodes.push(this.parseBranch("with"));
        } else {
          const r2 = this.itemList();
          elseList = r2.list;
          next = r2.end;
          if (next.kind !== "end") this.errorf(`expected end; found ${nodeString(next)}`);
        }
      }
      return { kind, tr: this, pos: pipe.pos, line: pipe.line, pipe, list, elseList };
    } finally {
      this.vars = this.vars.slice(0, mark);
    }
  }

  private endControl(): Node {
    return { kind: "end", tr: this, pos: this.expect("rightDelim", "end").pos };
  }

  private elseControl(): Node {
    const peek = this.peekNonSpace();
    if (peek.typ === "if" || peek.typ === "with") {
      return { kind: "else", tr: this, pos: peek.pos, line: peek.line };
    }
    const token = this.expect("rightDelim", "else");
    return { kind: "else", tr: this, pos: token.pos, line: token.line };
  }

  private blockControl(): Node {
    const context = "block clause";
    const token = this.nextNonSpace();
    const name = this.parseTemplateName(token, context);
    const pipe = this.pipeline(context, "rightDelim");
    const block = new Tree(name, this.funcs);
    block.text = this.text;
    block.parseName = this.parseName;
    block.startParse(this.lexer(), this.treeSet as Map<string, Tree>);
    const r = block.itemList();
    block.root = r.list;
    if (r.end.kind !== "end") this.errorf(`unexpected ${nodeString(r.end)} in ${context}`);
    block.add();
    block.stopParse();
    return { kind: "template", tr: this, pos: token.pos, line: token.line, name, pipe };
  }

  private templateControl(): Node {
    const context = "template clause";
    const token = this.nextNonSpace();
    const name = this.parseTemplateName(token, context);
    let pipe: PipeNode | null = null;
    if (this.nextNonSpace().typ !== "rightDelim") {
      this.backup();
      pipe = this.pipeline(context, "rightDelim");
    }
    return { kind: "template", tr: this, pos: token.pos, line: token.line, name, pipe };
  }

  private parseTemplateName(token: Item, context: string): string {
    if (token.typ === "string" || token.typ === "rawString") {
      try {
        return goUnquote(token.val);
      } catch (e) {
        this.errorf((e as Error).message);
      }
    }
    return this.unexpected(token, context);
  }

  private command(): CommandNode {
    const cmd: CommandNode = { kind: "command", tr: this, pos: this.peekNonSpace().pos, args: [] };
    for (;;) {
      this.peekNonSpace();
      const operand = this.operand();
      if (operand) cmd.args.push(operand);
      const token = this.next();
      if (token.typ === "space") continue;
      if (token.typ === "rightDelim" || token.typ === "rightParen") this.backup();
      else if (token.typ !== "pipe") this.unexpected(token, "operand");
      break;
    }
    if (cmd.args.length === 0) this.errorf("empty command");
    return cmd;
  }

  private operand(): Node | null {
    let node = this.term();
    if (!node) return null;
    if (this.peek().typ === "field") {
      const chain: ChainNode = { kind: "chain", tr: this, pos: this.peek().pos, node, field: [] };
      while (this.peek().typ === "field") {
        const f = this.next().val;
        chain.field.push(f.slice(1));
      }
      switch (node.kind) {
        case "field":
          node = this.newField(chain.pos, nodeString(chain));
          break;
        case "variable":
          node = this.newVariable(chain.pos, nodeString(chain));
          break;
        case "bool":
        case "string":
        case "number":
        case "nil":
        case "dot":
          this.errorf(`unexpected . after term ${goQuote(nodeString(node))}`);
          break;
        default:
          node = chain;
      }
    }
    return node;
  }

  private term(): Node | null {
    const token = this.nextNonSpace();
    switch (token.typ) {
      case "identifier":
        if (!this.funcs.has(token.val)) this.errorf(`function ${goQuote(token.val)} not defined`);
        return { kind: "identifier", tr: this, pos: token.pos, ident: token.val };
      case "dot":
        return { kind: "dot", tr: this, pos: token.pos };
      case "nil":
        return { kind: "nil", tr: this, pos: token.pos };
      case "variable":
        return this.useVar(token.pos, token.val);
      case "field":
        return this.newField(token.pos, token.val);
      case "bool":
        return { kind: "bool", tr: this, pos: token.pos, value: token.val === "true" };
      case "charConstant":
      case "complex":
      case "number": {
        const r = newNumber(this, token.pos, token.val, token.typ);
        if (!r.node) this.errorf(r.err ?? "illegal number syntax");
        return r.node;
      }
      case "leftParen": {
        if (this.stackDepth >= MAX_STACK_DEPTH) this.errorf("max expression depth exceeded");
        this.stackDepth++;
        try {
          return this.pipeline("parenthesized pipeline", "rightParen");
        } finally {
          this.stackDepth--;
        }
      }
      case "string":
      case "rawString": {
        let s: string;
        try {
          s = goUnquote(token.val);
        } catch (e) {
          this.errorf((e as Error).message);
        }
        return { kind: "string", tr: this, pos: token.pos, quoted: token.val, text: s };
      }
    }
    this.backup();
    return null;
  }

  private useVar(pos: number, name: string): Node {
    const v = this.newVariable(pos, name);
    for (const varName of this.vars) if (varName === v.ident[0]) return v;
    return this.errorf(`undefined variable ${goQuote(v.ident[0] ?? "")}`);
  }
}

/** parse.IsEmptyTree. */
export function isEmptyTree(n: Node | null): boolean {
  if (n === null) return true;
  switch (n.kind) {
    case "comment":
      return true;
    case "list":
      return n.nodes.every(isEmptyTree);
    case "text":
      return n.text.trim() === "";
    case "action":
    case "if":
    case "range":
    case "template":
    case "with":
      return false;
    default:
      throw new Error(`unknown node: ${nodeString(n)}`);
  }
}

/** parse.Parse: parses text into the set of named trees (the root template is `name`). */
export function parseTemplate(name: string, text: string, funcs: Set<string>): Map<string, Tree> {
  const treeSet = new Map<string, Tree>();
  const t = new Tree(name, funcs);
  t.text = text;
  t.parseText(text, treeSet);
  return treeSet;
}
