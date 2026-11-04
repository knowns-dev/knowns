// Port of the part of text/template (exec.go + funcs.go, Go 1.26) the codegen engine reaches. The
// data is a map[string]interface{} of strings and bools, the user functions are the case helpers
// plus the engine's own `not`, and the rest are Go's builtins.
import { compareStrings, sprint, sprintf, sprintln } from "./gofmt.ts";
import { type BranchNode, type Node, nodeString, type PipeNode, type Tree } from "./goparse.ts";
import { goQuote, isPrint } from "./goquote.ts";
import { GoComplex, GoMap, GoUint8, type GoValue, kindOf, typeName } from "./govalue.ts";
import * as helpers from "./helpers.ts";

export class GoExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoExecError";
  }
}

/** An error returned by a template function (the `error` result). */
class FuncError extends Error {}

const MISSING = Symbol("missingVal");
type Final = GoValue | typeof MISSING;
type ParamType = "string" | "iface" | "rv";

const typeStr: Record<ParamType, string> = {
  string: "string",
  iface: "interface {}",
  rv: "reflect.Value",
};

interface FuncDef {
  params: ParamType[];
  variadic?: ParamType;
  impl: (args: GoValue[]) => GoValue;
}

// --- helpers on values --------------------------------------------------------------------------

function isTrue(v: GoValue): boolean {
  switch (kindOf(v)) {
    case "invalid":
      return false;
    case "string":
      return (v as string).length > 0;
    case "bool":
      return v as boolean;
    case "int":
      return (v as bigint) !== 0n;
    case "float64":
      return (v as number) !== 0;
    case "uint":
      return (v as GoUint8).n !== 0;
    case "complex": {
      const c = v as GoComplex;
      return c.re !== 0 || c.im !== 0;
    }
    case "map":
      return (v as GoMap).entries.size > 0;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function indexArg(index: GoValue, cap: number): number {
  let x: bigint;
  switch (kindOf(index)) {
    case "int":
      x = index as bigint;
      break;
    case "uint":
      x = BigInt((index as GoUint8).n);
      break;
    case "invalid":
      throw new FuncError("cannot index slice/array with nil");
    default:
      throw new FuncError(`cannot index slice/array with type ${typeName(index)}`);
  }
  if (x < 0n || x > BigInt(cap)) throw new FuncError(`index out of range: ${x}`);
  return Number(x);
}

function funcIndex(args: GoValue[]): GoValue {
  let item = args[0];
  const indexes = args.slice(1);
  if (item === undefined || item === null) throw new FuncError("index of untyped nil");
  for (const index of indexes) {
    // a missing map key leaves a nil interface{} behind
    if (item === undefined) throw new FuncError("index of nil pointer");
    switch (kindOf(item)) {
      case "string": {
        const bytes = encoder.encode(item as string);
        const x = indexArg(index, bytes.length);
        if (x >= bytes.length) throw new FuncError("reflect: string index out of range");
        item = new GoUint8(bytes[x] ?? 0);
        break;
      }
      case "map": {
        if (index === undefined || index === null) {
          throw new FuncError("value is nil; should be of type string");
        }
        if (typeof index !== "string") {
          throw new FuncError(`value has type ${typeName(index)}; should be string`);
        }
        item = (item as GoMap).entries.get(index);
        break;
      }
      default:
        throw new FuncError(`can't index item of type ${typeName(item)}`);
    }
  }
  return item;
}

function funcSlice(args: GoValue[]): GoValue {
  const item = args[0];
  const indexes = args.slice(1);
  if (item === undefined || item === null) throw new FuncError("slice of untyped nil");
  if (indexes.length > 3) throw new FuncError(`too many slice indexes: ${indexes.length}`);
  if (typeof item !== "string") throw new FuncError(`can't slice item of type ${typeName(item)}`);
  if (indexes.length === 3) throw new FuncError("cannot 3-index slice a string");
  const bytes = encoder.encode(item);
  const cap = bytes.length;
  const idx = [0, cap];
  indexes.forEach((index, i) => {
    idx[i] = indexArg(index, cap);
  });
  const [a = 0, b = cap] = idx;
  if (a > b) throw new FuncError(`invalid slice index: ${a} > ${b}`);
  return decoder.decode(bytes.slice(a, b));
}

function funcLen(args: GoValue[]): GoValue {
  const item = args[0];
  switch (kindOf(item)) {
    case "string":
      return BigInt(byteLength(item as string));
    case "map":
      return BigInt((item as GoMap).entries.size);
    default:
      throw new FuncError(`len of type ${typeName(item)}`);
  }
}

type BasicKind = "invalid" | "bool" | "complex" | "int" | "float" | "string" | "uint";

function basicKind(v: GoValue): BasicKind {
  switch (kindOf(v)) {
    case "bool":
      return "bool";
    case "int":
      return "int";
    case "uint":
      return "uint";
    case "float64":
      return "float";
    case "complex":
      return "complex";
    case "string":
      return "string";
    default:
      return "invalid";
  }
}

const ERR_BAD_COMPARISON = "invalid type for comparison";

function uintOf(v: GoValue): bigint {
  return BigInt((v as GoUint8).n);
}

function funcEq(args: GoValue[]): GoValue {
  const arg1 = args[0];
  const rest = args.slice(1);
  if (rest.length === 0) throw new FuncError("missing argument for comparison");
  const k1 = basicKind(arg1);
  for (const arg of rest) {
    const k2 = basicKind(arg);
    let truth = false;
    if (k1 !== k2) {
      if (k1 === "int" && k2 === "uint") {
        truth = (arg1 as bigint) >= 0n && (arg1 as bigint) === uintOf(arg);
      } else if (k1 === "uint" && k2 === "int") {
        truth = (arg as bigint) >= 0n && uintOf(arg1) === (arg as bigint);
      } else if (arg1 !== undefined && arg1 !== null && arg !== undefined && arg !== null) {
        throw new FuncError(
          `incompatible types for comparison: ${typeName(arg1)} and ${typeName(arg)}`,
        );
      }
    } else {
      switch (k1) {
        case "bool":
          truth = arg1 === arg;
          break;
        case "complex": {
          const a = arg1 as GoComplex;
          const b = arg as GoComplex;
          truth = a.re === b.re && a.im === b.im;
          break;
        }
        case "float":
        case "int":
        case "string":
          truth = arg1 === arg;
          break;
        case "uint":
          truth = uintOf(arg1) === uintOf(arg);
          break;
        default: {
          const nil1 = arg1 === undefined || arg1 === null;
          const nilA = arg === undefined || arg === null;
          if (!nil1 && !nilA && kindOf(arg1) !== kindOf(arg)) {
            throw new FuncError(
              `non-comparable types ${sprint([arg1])}: ${typeName(arg1)}, ${typeName(arg)}: ${sprint([arg])}`,
            );
          }
          if (nil1 || nilA) truth = nilA === nil1;
          else throw new FuncError(`non-comparable type ${sprint([arg])}: ${typeName(arg)}`);
        }
      }
    }
    if (truth) return true;
  }
  return false;
}

function lt(arg1: GoValue, arg2: GoValue): boolean {
  const k1 = basicKind(arg1);
  if (k1 === "invalid") throw new FuncError(ERR_BAD_COMPARISON);
  const k2 = basicKind(arg2);
  if (k2 === "invalid") throw new FuncError(ERR_BAD_COMPARISON);
  if (k1 !== k2) {
    if (k1 === "int" && k2 === "uint")
      return (arg1 as bigint) < 0n || (arg1 as bigint) < uintOf(arg2);
    if (k1 === "uint" && k2 === "int")
      return (arg2 as bigint) >= 0n && uintOf(arg1) < (arg2 as bigint);
    throw new FuncError(
      `incompatible types for comparison: ${typeName(arg1)} and ${typeName(arg2)}`,
    );
  }
  switch (k1) {
    case "bool":
    case "complex":
      throw new FuncError(ERR_BAD_COMPARISON);
    case "float":
      return (arg1 as number) < (arg2 as number);
    case "int":
      return (arg1 as bigint) < (arg2 as bigint);
    case "string":
      return compareStrings(arg1 as string, arg2 as string) < 0;
    case "uint":
      return uintOf(arg1) < uintOf(arg2);
    default:
      throw new Error("invalid kind");
  }
}

function le(arg1: GoValue, arg2: GoValue): boolean {
  if (lt(arg1, arg2)) return true;
  return funcEq([arg1, arg2]) as boolean;
}

function htmlEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\u0000":
        out += "\ufffd";
        break;
      case '"':
        out += "&#34;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function jsEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const r = ch.codePointAt(0) ?? 0;
    const special = "\\'\"<>&=".includes(ch) || r < 0x20 || r >= 0x80;
    if (!special) {
      out += ch;
      continue;
    }
    if (r < 0x80) {
      switch (ch) {
        case "\\":
          out += "\\\\";
          break;
        case "'":
          out += "\\'";
          break;
        case '"':
          out += '\\"';
          break;
        case "<":
          out += "\\u003C";
          break;
        case ">":
          out += "\\u003E";
          break;
        case "&":
          out += "\\u0026";
          break;
        case "=":
          out += "\\u003D";
          break;
        default:
          out += `\\u00${(r >> 4).toString(16).toUpperCase()}${(r & 15).toString(16).toUpperCase()}`;
      }
    } else if (isPrint(ch)) out += ch;
    else out += `\\u${r.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

function queryEscape(s: string): string {
  let out = "";
  for (const b of encoder.encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (c === " ") out += "+";
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** evalArgs: the single-string fast path, else printable values joined by Sprint. */
function evalArgs(args: GoValue[]): string {
  if (args.length === 1 && typeof args[0] === "string") return args[0];
  const mapped = args.map((a): GoValue => (a === null || a === undefined ? "<no value>" : a));
  return sprint(mapped);
}

function notImpl(args: GoValue[]): GoValue {
  const v = args[0];
  if (v === null || v === undefined) return true;
  if (typeof v === "boolean") return !v;
  if (typeof v === "string") return v === "" || v === "false" || v === "0";
  if (typeof v === "bigint") return v === 0n;
  if (typeof v === "number") return sprint([v]) === "0";
  return false;
}

const userFuncs: Record<string, FuncDef> = {
  camelCase: { params: ["string"], impl: (a) => helpers.camelCase(a[0] as string) },
  pascalCase: { params: ["string"], impl: (a) => helpers.pascalCase(a[0] as string) },
  kebabCase: { params: ["string"], impl: (a) => helpers.kebabCase(a[0] as string) },
  snakeCase: { params: ["string"], impl: (a) => helpers.snakeCase(a[0] as string) },
  upperCase: { params: ["string"], impl: (a) => helpers.upperCase(a[0] as string) },
  lowerCase: { params: ["string"], impl: (a) => helpers.lowerCase(a[0] as string) },
  startCase: { params: ["string"], impl: (a) => helpers.startCase(a[0] as string) },
  not: { params: ["iface"], impl: notImpl },
};

const builtins: Record<string, FuncDef> = {
  and: { params: ["rv"], variadic: "rv", impl: () => undefined },
  or: { params: ["rv"], variadic: "rv", impl: () => undefined },
  call: { params: ["rv"], variadic: "rv", impl: () => undefined },
  html: { params: [], variadic: "iface", impl: (a) => htmlEscape(evalArgs(a)) },
  js: { params: [], variadic: "iface", impl: (a) => jsEscape(evalArgs(a)) },
  urlquery: { params: [], variadic: "iface", impl: (a) => queryEscape(evalArgs(a)) },
  index: { params: ["rv"], variadic: "rv", impl: funcIndex },
  slice: { params: ["rv"], variadic: "rv", impl: funcSlice },
  len: { params: ["rv"], impl: funcLen },
  print: { params: [], variadic: "iface", impl: (a) => sprint(a) },
  printf: {
    params: ["string"],
    variadic: "iface",
    impl: (a) => sprintf(a[0] as string, a.slice(1)),
  },
  println: { params: [], variadic: "iface", impl: (a) => sprintln(a) },
  eq: { params: ["rv"], variadic: "rv", impl: funcEq },
  ne: { params: ["rv", "rv"], impl: (a) => !(funcEq([a[0], a[1]]) as boolean) },
  lt: { params: ["rv", "rv"], impl: (a) => lt(a[0], a[1]) },
  le: { params: ["rv", "rv"], impl: (a) => le(a[0], a[1]) },
  gt: { params: ["rv", "rv"], impl: (a) => !le(a[0], a[1]) },
  ge: { params: ["rv", "rv"], impl: (a) => !lt(a[0], a[1]) },
};

/** The function names the parser accepts (user functions plus builtins). */
export const FUNCTION_NAMES = new Set<string>([
  ...Object.keys(userFuncs),
  ...Object.keys(builtins),
]);

// --- the executor -------------------------------------------------------------------------------

class WalkBreak {}
class WalkContinue {}

interface Variable {
  name: string;
  value: GoValue;
}

class State {
  node: Node | null = null;
  vars: Variable[];
  depth = 0;

  constructor(
    readonly trees: Map<string, Tree>,
    public tmplName: string,
    private readonly out: { text: string },
    dot: GoValue,
  ) {
    this.vars = [{ name: "$", value: dot }];
  }

  private fork(tmplName: string, dot: GoValue): State {
    const s = new State(this.trees, tmplName, this.out, dot);
    s.depth = this.depth + 1;
    return s;
  }

  errorf(msg: string): never {
    if (this.node === null) {
      throw new GoExecError(`template: ${this.tmplName}: ${msg}`);
    }
    const tree = this.trees.get(this.tmplName);
    const { location, context } = (this.node.tr ?? tree)?.errorContext(this.node) ?? {
      location: "",
      context: nodeString(this.node),
    };
    throw new GoExecError(
      `template: ${location}: executing ${goQuote(this.tmplName)} at <${context}>: ${msg}`,
    );
  }

  private at(n: Node): void {
    this.node = n;
  }

  private mark(): number {
    return this.vars.length;
  }

  private pop(mark: number): void {
    this.vars.length = mark;
  }

  private setVar(name: string, value: GoValue): void {
    for (let i = this.vars.length - 1; i >= 0; i--) {
      const v = this.vars[i];
      if (v && v.name === name) {
        v.value = value;
        return;
      }
    }
    this.errorf(`undefined variable: ${name}`);
  }

  private setTopVar(n: number, value: GoValue): void {
    const v = this.vars[this.vars.length - n];
    if (v) v.value = value;
  }

  private varValue(name: string): GoValue {
    for (let i = this.vars.length - 1; i >= 0; i--) {
      const v = this.vars[i];
      if (v && v.name === name) return v.value;
    }
    return this.errorf(`undefined variable: ${name}`);
  }

  walk(dot: GoValue, node: Node): void {
    this.at(node);
    switch (node.kind) {
      case "action": {
        const val = this.evalPipeline(dot, node.pipe);
        if (node.pipe.decl.length === 0) this.printValue(node, val);
        return;
      }
      case "break":
        throw new WalkBreak();
      case "comment":
        return;
      case "continue":
        throw new WalkContinue();
      case "if":
        this.walkIfOrWith("if", dot, node);
        return;
      case "list":
        for (const n of node.nodes) this.walk(dot, n);
        return;
      case "range":
        this.walkRange(dot, node);
        return;
      case "template":
        this.walkTemplate(dot, node);
        return;
      case "text":
        this.out.text += node.text;
        return;
      case "with":
        this.walkIfOrWith("with", dot, node);
        return;
      default:
        this.errorf(`unknown node: ${nodeString(node)}`);
    }
  }

  private walkIfOrWith(typ: "if" | "with", dot: GoValue, node: BranchNode): void {
    const mark = this.mark();
    try {
      const val = this.evalPipeline(dot, node.pipe);
      if (isTrue(val)) {
        this.walk(typ === "with" ? val : dot, node.list);
      } else if (node.elseList) {
        this.walk(dot, node.elseList);
      }
    } finally {
      this.pop(mark);
    }
  }

  private walkRange(dot: GoValue, r: BranchNode): void {
    this.at(r);
    const outerMark = this.mark();
    try {
      const val = this.evalPipeline(dot, r.pipe);
      const mark = this.mark();
      const decl = r.pipe.decl;
      const oneIteration = (index: GoValue, elem: GoValue): void => {
        if (decl.length > 0) {
          const d0 = decl[0]?.ident[0] ?? "";
          if (r.pipe.isAssign) {
            this.setVar(d0, decl.length > 1 ? index : elem);
          } else this.setTopVar(1, elem);
        }
        if (decl.length > 1) {
          if (r.pipe.isAssign) this.setVar(decl[1]?.ident[0] ?? "", elem);
          else this.setTopVar(2, index);
        }
        try {
          this.walk(elem, r.list);
        } catch (e) {
          if (!(e instanceof WalkContinue)) throw e;
        } finally {
          this.pop(mark);
        }
      };
      switch (kindOf(val)) {
        case "int":
        case "uint": {
          if (decl.length > 1) {
            this.errorf(`can't use ${sprint([val])} to iterate over more than one variable`);
          }
          const n = typeof val === "bigint" ? val : BigInt((val as GoUint8).n);
          let ran = false;
          for (let i = 0n; i < n; i++) {
            ran = true;
            oneIteration(undefined, typeof val === "bigint" ? i : new GoUint8(Number(i)));
          }
          if (ran) return;
          break;
        }
        case "map": {
          const m = (val as GoMap).entries;
          if (m.size === 0) break;
          for (const k of [...m.keys()].sort(compareStrings)) oneIteration(k, m.get(k));
          return;
        }
        case "invalid":
          break;
        default:
          this.errorf(`range can't iterate over ${sprint([val])}`);
      }
      if (r.elseList) this.walk(dot, r.elseList);
    } catch (e) {
      if (!(e instanceof WalkBreak)) throw e;
    } finally {
      this.pop(outerMark);
    }
  }

  private walkTemplate(dot: GoValue, t: Node & { kind: "template" }): void {
    this.at(t);
    const tmpl = this.trees.get(t.name);
    if (!tmpl) this.errorf(`template ${goQuote(t.name)} not defined`);
    if (this.depth === 100000) this.errorf("exceeded maximum template depth (100000)");
    const newDot = t.pipe ? this.evalPipeline(dot, t.pipe) : undefined;
    const ns = this.fork(t.name, newDot);
    if (tmpl.root) ns.walk(newDot, tmpl.root);
  }

  // --- evaluation ---

  evalPipeline(dot: GoValue, pipe: PipeNode | null): GoValue {
    if (pipe === null) return undefined;
    this.at(pipe);
    let value: Final = MISSING;
    for (const cmd of pipe.cmds) {
      value = this.evalCommand(dot, cmd, value);
    }
    const result = value === MISSING ? undefined : value;
    for (const variable of pipe.decl) {
      const name = variable.ident[0] ?? "";
      if (pipe.isAssign) this.setVar(name, result);
      else this.vars.push({ name, value: result });
    }
    return result;
  }

  private notAFunction(args: Node[], final: Final): void {
    if (args.length > 1 || final !== MISSING) {
      this.errorf(`can't give argument to non-function ${nodeString(args[0] as Node)}`);
    }
  }

  private evalCommand(dot: GoValue, cmd: Node & { kind: "command" }, final: Final): GoValue {
    const firstWord = cmd.args[0] as Node;
    switch (firstWord.kind) {
      case "field":
        return this.evalFieldNode(dot, firstWord, cmd.args, final);
      case "chain":
        return this.evalChainNode(dot, firstWord, cmd.args, final);
      case "identifier":
        return this.evalFunction(dot, firstWord.ident, cmd, cmd.args, final);
      case "pipe":
        this.notAFunction(cmd.args, final);
        return this.evalPipeline(dot, firstWord);
      case "variable":
        return this.evalVariableNode(firstWord, cmd.args, final);
    }
    this.at(firstWord);
    this.notAFunction(cmd.args, final);
    switch (firstWord.kind) {
      case "bool":
        return firstWord.value;
      case "dot":
        return dot;
      case "nil":
        return this.errorf("nil is not a command");
      case "number":
        return this.idealConstant(firstWord);
      case "string":
        return firstWord.text;
    }
    return this.errorf(`can't evaluate command ${goQuote(nodeString(firstWord))}`);
  }

  private idealConstant(c: Node & { kind: "number" }): GoValue {
    this.at(c);
    if (c.isComplex) return new GoComplex(c.complex.re, c.complex.im);
    const isHex =
      c.text.length > 2 &&
      c.text[0] === "0" &&
      /[xX]/.test(c.text[1] ?? "") &&
      !/[pP]/.test(c.text);
    const isRune = c.text.length > 0 && c.text[0] === "'";
    if (c.isFloat && !isHex && !isRune && /[.eEpP]/.test(c.text)) return c.float64;
    if (c.isInt) return c.int64;
    if (c.isUint) this.errorf(`${c.text} overflows int`);
    return undefined;
  }

  private evalFieldNode(
    dot: GoValue,
    field: Node & { kind: "field" },
    args: Node[],
    final: Final,
  ): GoValue {
    this.at(field);
    return this.evalFieldChain(dot, field.ident, args, final);
  }

  private evalChainNode(
    dot: GoValue,
    chain: Node & { kind: "chain" },
    args: Node[],
    final: Final,
  ): GoValue {
    this.at(chain);
    if (chain.field.length === 0) this.errorf("internal error: no fields in evalChainNode");
    if (chain.node.kind === "nil") {
      this.errorf(`indirection through explicit nil in ${nodeString(chain)}`);
    }
    const pipe = this.evalArg(dot, null, chain.node);
    return this.evalFieldChain(pipe, chain.field, args, final);
  }

  private evalVariableNode(
    variable: Node & { kind: "variable" },
    args: Node[],
    final: Final,
  ): GoValue {
    this.at(variable);
    const value = this.varValue(variable.ident[0] ?? "");
    if (variable.ident.length === 1) {
      this.notAFunction(args, final);
      return value;
    }
    return this.evalFieldChain(value, variable.ident.slice(1), args, final);
  }

  private evalFieldChain(receiver: GoValue, ident: string[], args: Node[], final: Final): GoValue {
    const n = ident.length;
    let recv = receiver;
    for (let i = 0; i < n - 1; i++) {
      recv = this.evalField(ident[i] as string, [], MISSING, recv, i > 0);
    }
    return this.evalField(ident[n - 1] as string, args, final, recv, n > 1);
  }

  private evalFunction(dot: GoValue, name: string, cmd: Node, args: Node[], final: Final): GoValue {
    this.at(cmd.kind === "command" ? (cmd.args[0] as Node) : cmd);
    const user = userFuncs[name];
    const builtin = builtins[name];
    const def = user ?? builtin;
    if (!def) this.errorf(`${goQuote(name)} is not a defined function`);
    return this.evalCall(dot, def, user === undefined, cmd, name, args, final);
  }

  private evalField(
    fieldName: string,
    args: Node[],
    final: Final,
    receiver: GoValue,
    fromMapIndex: boolean,
  ): GoValue {
    if (receiver === undefined) return undefined;
    const hasArgs = args.length > 1 || final !== MISSING;
    if (receiver instanceof GoMap) {
      if (hasArgs) this.errorf(`${fieldName} is not a method but has arguments`);
      return receiver.entries.get(fieldName);
    }
    return this.errorf(
      `can't evaluate field ${fieldName} in type ${fromMapIndex ? "interface {}" : typeName(receiver)}`,
    );
  }

  private evalCall(
    dot: GoValue,
    def: FuncDef,
    isBuiltin: boolean,
    node: Node,
    name: string,
    argsIn: Node[],
    final: Final,
  ): GoValue {
    // evalCommand passes the whole command (function name first); evalArg passes none.
    const args = node.kind === "command" && argsIn === node.args ? argsIn.slice(1) : argsIn;
    const numParams = def.params.length + (def.variadic ? 1 : 0);
    let numIn = args.length;
    if (final !== MISSING) numIn++;
    let numFixed = args.length;
    if (def.variadic) {
      numFixed = numParams - 1;
      if (numIn < numFixed) {
        this.errorf(
          `wrong number of args for ${name}: want at least ${numParams - 1} got ${args.length}`,
        );
      }
    } else if (numIn !== numParams) {
      this.errorf(`wrong number of args for ${name}: want ${numParams} got ${numIn}`);
    }
    const paramAt = (i: number): ParamType => def.params[i] ?? (def.variadic as ParamType);

    if (isBuiltin && (name === "and" || name === "or")) {
      let v: GoValue;
      for (const arg of args) {
        v = this.evalArg(dot, "rv", arg);
        if (isTrue(v) === (name === "or")) return v;
      }
      if (final !== MISSING) v = this.validateType(final, "rv");
      return v;
    }

    const argv: GoValue[] = new Array(numIn);
    let i = 0;
    for (; i < numFixed && i < args.length; i++) {
      argv[i] = this.evalArg(dot, paramAt(i), args[i] as Node);
    }
    if (def.variadic) {
      for (; i < args.length; i++) argv[i] = this.evalArg(dot, def.variadic, args[i] as Node);
    }
    if (final !== MISSING) {
      let t: ParamType = paramAt(numParams - 1);
      if (def.variadic) {
        if (numIn - 1 < numFixed) t = paramAt(numIn - 1);
        else t = def.variadic;
      }
      argv[i] = this.validateType(final, t);
    }

    let result: GoValue;
    try {
      if (isBuiltin && name === "call") {
        const calleeName =
          args.length === 0
            ? sprint([final === MISSING ? undefined : final])
            : nodeString(args[0] as Node);
        result = callBuiltin(calleeName, argv);
      } else {
        result = def.impl(argv);
      }
    } catch (e) {
      if (e instanceof FuncError) {
        this.at(node);
        this.errorf(`error calling ${name}: ${e.message}`);
      }
      throw e;
    }
    return result;
  }

  private validateType(value: GoValue, typ: ParamType | null): GoValue {
    if (value === undefined) {
      if (typ === null || typ === "rv") return undefined;
      if (typ === "iface") return null;
      return this.errorf(`invalid value; expected ${typeStr[typ]}`);
    }
    if (typ === "string" && typeof value !== "string") {
      this.errorf(`wrong type for value; expected string; got ${typeName(value)}`);
    }
    return value;
  }

  private evalArg(dot: GoValue, typ: ParamType | null, n: Node): GoValue {
    this.at(n);
    switch (n.kind) {
      case "dot":
        return this.validateType(dot, typ);
      case "nil":
        if (typ === "iface") return null;
        if (typ === "rv") return undefined;
        return this.errorf(`cannot assign nil to ${typ === null ? "<nil>" : typeStr[typ]}`);
      case "field":
        return this.validateType(this.evalFieldNode(dot, n, [n], MISSING), typ);
      case "variable":
        return this.validateType(this.evalVariableNode(n, [], MISSING), typ);
      case "pipe":
        return this.validateType(this.evalPipeline(dot, n), typ);
      case "identifier":
        return this.validateType(this.evalFunction(dot, n.ident, n, [], MISSING), typ);
      case "chain":
        return this.validateType(this.evalChainNode(dot, n, [], MISSING), typ);
    }
    if (typ === null) throw new Error("runtime error: nil type in evalArg");
    switch (typ) {
      case "string":
        this.at(n);
        if (n.kind === "string") return n.text;
        return this.errorf(`expected string; found ${nodeString(n)}`);
      case "iface":
      case "rv":
        return this.evalEmptyInterface(dot, n);
    }
  }

  private evalEmptyInterface(dot: GoValue, n: Node): GoValue {
    this.at(n);
    switch (n.kind) {
      case "bool":
        return n.value;
      case "dot":
        return dot;
      case "field":
        return this.evalFieldNode(dot, n, [], MISSING);
      case "identifier":
        return this.evalFunction(dot, n.ident, n, [], MISSING);
      case "nil":
        return this.errorf("evalEmptyInterface: nil (can't happen)");
      case "number":
        return this.idealConstant(n);
      case "string":
        return n.text;
      case "variable":
        return this.evalVariableNode(n, [], MISSING);
      case "pipe":
        return this.evalPipeline(dot, n);
    }
    return this.errorf(`can't handle assignment of ${nodeString(n)} to empty interface argument`);
  }

  private printValue(n: Node, v: GoValue): void {
    this.at(n);
    if (v === undefined) {
      this.out.text += "<no value>";
      return;
    }
    this.out.text += sprint([v]);
  }
}

function callBuiltin(name: string, argv: GoValue[]): GoValue {
  const fn = argv[0];
  if (fn === undefined || fn === null) throw new FuncError("call of nil");
  throw new FuncError(`non-function ${name} of type ${typeName(fn)}`);
}

/** Executes the root template `name` of `trees` with `data`, returning the output text. */
export function executeTemplate(trees: Map<string, Tree>, name: string, data: GoMap): string {
  const out = { text: "" };
  const state = new State(trees, name, out, data);
  const tree = trees.get(name);
  if (!tree?.root) {
    return state.errorf(`${goQuote(name)} is an incomplete or empty template`);
  }
  state.walk(data, tree.root);
  return out.text;
}
