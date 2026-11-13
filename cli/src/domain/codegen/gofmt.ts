// A port of the subset of Go's fmt that the template engine reaches: Sprint, Sprintln, Sprintf
// (print, println, printf, and the executor's value printing) over the value kinds in govalue.ts.
//
// Not ported: explicit argument indexes (%[2]d), %#v for maps, %x/%b/%p on floats and complex,
// %w. Fixed-precision floats are rounded from the exact binary expansion, half to even, like Go;
// shortest formatting relies on JS's shortest round-trip digits (identical digits to Go).
import { canBackquote, formatSharpU, goQuote, goQuoteRune } from "./goquote.ts";
import {
  type GoComplex,
  type GoMap,
  type GoUint8,
  type GoValue,
  kindOf,
  runeCount,
  typeName,
} from "./govalue.ts";

// --- floats -------------------------------------------------------------------------------------

interface Digits {
  /** Significant digits, no trailing zeros ("" for zero). */
  d: string;
  /** Decimal point position: value = 0.d * 10^dp. */
  dp: number;
}

function digitsFromExp(s: string): Digits {
  // s looks like "1.2345e+21" or "5e-7"
  const [mant = "0", exp = "0"] = s.split("e");
  const d = mant.replace(".", "").replace(/0+$/, "");
  return { d, dp: Number.parseInt(exp, 10) + 1 };
}

function shortestDigits(v: number): Digits {
  if (v === 0) return { d: "", dp: 0 };
  return digitsFromExp(v.toExponential());
}

/** The exact decimal expansion of a finite positive double. */
function exactDigits(a: number): Digits {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, a);
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e: number;
  if (expBits === 0) {
    e = -1074;
  } else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  let digits: string;
  let dp: number;
  if (e >= 0) {
    digits = (mant << BigInt(e)).toString();
    dp = digits.length;
  } else {
    const k = -e;
    digits = (mant * 5n ** BigInt(k)).toString();
    dp = digits.length - k;
  }
  return { d: digits.replace(/0+$/, ""), dp };
}

/** Rounds to n significant digits, half to even (decimal.Round). */
function roundDigits(dg: Digits, n: number): Digits {
  if (n < 0 || dg.d.length === 0) return n < 0 ? { d: "", dp: 0 } : dg;
  if (n >= dg.d.length) return dg;
  const head = dg.d.slice(0, n);
  const rest = dg.d.slice(n);
  const first = rest.charCodeAt(0) - 48;
  const lastOdd = head.length > 0 && (head.charCodeAt(head.length - 1) - 48) % 2 === 1;
  const up = first > 5 || (first === 5 && (rest.length > 1 || lastOdd));
  if (!up) return { d: head.replace(/0+$/, ""), dp: head === "" ? 0 : dg.dp };
  if (head === "") return { d: "1", dp: dg.dp + 1 };
  const inc = (BigInt(head) + 1n).toString();
  const carried = inc.length > head.length;
  return { d: inc.replace(/0+$/, ""), dp: dg.dp + (carried ? 1 : 0) };
}

function sigDigits(v: number, n: number): Digits {
  if (v === 0) return { d: "", dp: 0 };
  return roundDigits(exactDigits(v), Math.max(n, 0));
}

function expString(exp: number, upper: boolean): string {
  const sign = exp < 0 ? "-" : "+";
  const a = Math.abs(exp);
  return `${upper ? "E" : "e"}${sign}${a < 10 ? `0${a}` : String(a)}`;
}

function fmtE(neg: boolean, dg: Digits, prec: number, upper: boolean): string {
  let s = neg ? "-" : "";
  const first = dg.d.length > 0 ? dg.d[0] : "0";
  s += first;
  if (prec > 0) {
    s += ".";
    const rest = dg.d.slice(1, 1 + prec);
    s += rest.padEnd(prec, "0");
  }
  const exp = dg.d.length === 0 ? 0 : dg.dp - 1;
  return s + expString(exp, upper);
}

function fmtF(neg: boolean, dg: Digits, prec: number): string {
  let s = neg ? "-" : "";
  if (dg.dp > 0) {
    const intPart = dg.d.slice(0, dg.dp).padEnd(dg.dp, "0");
    s += intPart;
  } else s += "0";
  if (prec > 0) {
    s += ".";
    for (let i = 0; i < prec; i++) {
      const j = dg.dp + i;
      s += j >= 0 && j < dg.d.length ? dg.d[j] : "0";
    }
  }
  return s;
}

/** strconv.FormatFloat(v, verb, prec, 64) for verbs e E f g G; prec -1 is shortest. */
export function formatFloat(v: number, verb: string, prec: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Number.POSITIVE_INFINITY) return "+Inf";
  if (v === Number.NEGATIVE_INFINITY) return "-Inf";
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);
  const lower = verb.toLowerCase();
  const upper = verb === "E" || verb === "G";
  if (lower === "f") {
    if (prec < 0) {
      return fmtF(
        neg,
        shortestDigits(a),
        Math.max(shortestDigits(a).d.length - shortestDigits(a).dp, 0),
      );
    }
    const dg = a === 0 ? { d: "", dp: 0 } : roundDigits(exactDigits(a), exactDigits(a).dp + prec);
    return fmtF(neg, dg, prec);
  }
  if (lower === "e") {
    const dg = prec < 0 ? shortestDigits(a) : sigDigits(a, prec + 1);
    const p = prec < 0 ? Math.max(dg.d.length - 1, 0) : prec;
    return fmtE(neg, dg, p, upper);
  }
  // g
  const shortest = prec < 0;
  let p = prec;
  if (p === 0) p = 1;
  const dg = shortest ? shortestDigits(a) : sigDigits(a, p);
  let eprec = p;
  if (eprec > dg.d.length && dg.d.length >= dg.dp) eprec = dg.d.length;
  if (shortest) eprec = 6;
  const exp = dg.d.length === 0 ? 0 : dg.dp - 1;
  if (exp < -4 || exp >= eprec) {
    const q = shortest || p > dg.d.length ? dg.d.length : p;
    return fmtE(neg, dg, Math.max(q - 1, 0), upper);
  }
  return fmtF(neg, dg, Math.max(dg.d.length - dg.dp, 0));
}

// --- the printer --------------------------------------------------------------------------------

interface Flags {
  sharp: boolean;
  zero: boolean;
  plus: boolean;
  minus: boolean;
  space: boolean;
  sharpV: boolean;
  plusV: boolean;
  wid: number;
  widPresent: boolean;
  prec: number;
  precPresent: boolean;
}

function clearFlags(): Flags {
  return {
    sharp: false,
    zero: false,
    plus: false,
    minus: false,
    space: false,
    sharpV: false,
    plusV: false,
    wid: 0,
    widPresent: false,
    prec: 0,
    precPresent: false,
  };
}

const LDIGITS = "0123456789abcdefx";
const UDIGITS = "0123456789ABCDEFX";

class Printer {
  buf = "";
  f: Flags = clearFlags();
  erroring = false;

  private padding(n: number): string {
    if (n <= 0) return "";
    return (this.f.zero && !this.f.minus ? "0" : " ").repeat(n);
  }

  pad(s: string): void {
    if (!this.f.widPresent || this.f.wid === 0) {
      this.buf += s;
      return;
    }
    const width = this.f.wid - runeCount(s);
    if (!this.f.minus) this.buf += this.padding(width) + s;
    else this.buf += s + this.padding(width);
  }

  private truncate(s: string): string {
    if (!this.f.precPresent) return s;
    let n = this.f.prec;
    let out = "";
    for (const ch of s) {
      n--;
      if (n < 0) return out;
      out += ch;
    }
    return s;
  }

  fmtS(s: string): void {
    this.pad(this.truncate(s));
  }

  fmtQ(s: string): void {
    s = this.truncate(s);
    if (this.f.sharp && canBackquote(s)) {
      this.pad(`\`${s}\``);
      return;
    }
    this.pad(goQuote(s, this.f.plus));
  }

  fmtSx(s: string, digits: string): void {
    const bytes = new TextEncoder().encode(s);
    let length = bytes.length;
    if (this.f.precPresent && this.f.prec < length) length = this.f.prec;
    let out = "";
    for (let i = 0; i < length; i++) {
      if (this.f.space && i > 0) out += " ";
      if (this.f.sharp && (this.f.space || i === 0)) out += digits[16] === "x" ? "0x" : "0X";
      const c = bytes[i] ?? 0;
      out += digits.charAt(c >> 4) + digits.charAt(c & 15);
    }
    this.pad(out);
  }

  fmtBoolean(v: boolean): void {
    this.pad(v ? "true" : "false");
  }

  fmtInteger(value: bigint, base: number, signed: boolean, verb: string, digits: string): void {
    const negative = signed && value < 0n;
    let u = negative ? -value : value;
    if (!signed && u < 0n) u += 1n << 64n;
    let prec = 0;
    if (this.f.precPresent) {
      prec = this.f.prec;
      if (prec === 0 && u === 0n) {
        const old = this.f.zero;
        this.f.zero = false;
        this.buf += this.padding(this.f.wid);
        this.f.zero = old;
        return;
      }
    } else if (this.f.zero && !this.f.minus && this.f.widPresent) {
      prec = this.f.wid;
      if (negative || this.f.plus || this.f.space) prec--;
    }
    let s = u.toString(base);
    if (digits === UDIGITS) s = s.toUpperCase();
    while (s.length < prec) s = `0${s}`;
    if (this.f.sharp) {
      if (base === 2) s = `0b${s}`;
      else if (base === 8) {
        if (s[0] !== "0") s = `0${s}`;
      } else if (base === 16) s = (digits === UDIGITS ? "0X" : "0x") + s;
    }
    if (verb === "O") s = `0o${s}`;
    if (negative) s = `-${s}`;
    else if (this.f.plus) s = `+${s}`;
    else if (this.f.space) s = ` ${s}`;
    const old = this.f.zero;
    this.f.zero = false;
    this.pad(s);
    this.f.zero = old;
  }

  fmtC(c: bigint): void {
    let r = c;
    if (r > 0x10ffffn || r < 0n) r = 0xfffdn;
    const n = Number(r);
    const ch = n >= 0xd800 && n <= 0xdfff ? "�" : String.fromCodePoint(n);
    this.pad(ch);
  }

  fmtQc(c: bigint): void {
    let r = c;
    if (r > 0x10ffffn || r < 0n) r = 0xfffdn;
    this.pad(goQuoteRune(Number(r), this.f.plus));
  }

  fmtUnicode(u: bigint): void {
    let s = `U+${u
      .toString(16)
      .toUpperCase()
      .padStart(this.f.precPresent && this.f.prec > 4 ? this.f.prec : 4, "0")}`;
    if (this.f.sharp && u <= 0x10ffffn) {
      const n = Number(u);
      const ch = n >= 0xd800 && n <= 0xdfff ? "" : String.fromCodePoint(n);
      if (ch !== "" && formatSharpU(n).includes("'")) s += ` '${ch}'`;
    }
    const old = this.f.zero;
    this.f.zero = false;
    this.pad(s);
    this.f.zero = old;
  }

  fmtFloat(v: number, verb: string, prec: number): void {
    if (this.f.precPresent) prec = this.f.prec;
    let num = formatFloat(v, verb, prec);
    if (num[0] === "-" || num[0] === "+") {
      // keep
    } else num = `+${num}`;
    if (this.f.space && num[0] === "+" && !this.f.plus) num = ` ${num.slice(1)}`;
    if (num[1] === "I" || num[1] === "N") {
      const old = this.f.zero;
      this.f.zero = false;
      if (num[1] === "N" && !this.f.space && !this.f.plus) num = num.slice(1);
      this.pad(num);
      this.f.zero = old;
      return;
    }
    if (this.f.sharp && verb !== "b") {
      let digits = 0;
      if (verb === "v" || verb === "g" || verb === "G" || verb === "x") {
        digits = prec;
        if (digits === -1) digits = 6;
      }
      let tail = "";
      let hasPoint = false;
      let sawNonzero = false;
      let body = num;
      for (let i = 1; i < body.length; i++) {
        const c = body[i];
        if (c === ".") hasPoint = true;
        else if (c === "e" || c === "E") {
          tail = body.slice(i);
          body = body.slice(0, i);
          break;
        } else {
          if (c !== "0") sawNonzero = true;
          if (sawNonzero) digits--;
        }
      }
      if (!hasPoint) {
        if (body.length === 2 && body[1] === "0") digits--;
        body += ".";
      }
      while (digits > 0) {
        body += "0";
        digits--;
      }
      num = body + tail;
    }
    if (this.f.plus || num[0] !== "+") {
      if (this.f.zero && !this.f.minus && this.f.widPresent && this.f.wid > num.length) {
        this.buf += num[0] + this.padding(this.f.wid - num.length) + num.slice(1);
        return;
      }
      this.pad(num);
      return;
    }
    this.pad(num.slice(1));
  }

  fmtComplex(c: GoComplex, verb: string): void {
    if (!"vbgGxXfFeE".includes(verb)) {
      this.badVerb(verb, c);
      return;
    }
    const oldPlus = this.f.plus;
    this.buf += "(";
    this.floatVerb(c.re, verb);
    this.f.plus = true;
    this.floatVerb(c.im, verb);
    this.buf += "i)";
    this.f.plus = oldPlus;
  }

  floatVerb(v: number, verb: string): void {
    switch (verb) {
      case "v":
        this.fmtFloat(v, "g", -1);
        break;
      case "g":
      case "G":
        this.fmtFloat(v, verb, -1);
        break;
      case "f":
      case "e":
      case "E":
        this.fmtFloat(v, verb, 6);
        break;
      case "F":
        this.fmtFloat(v, "f", 6);
        break;
      default:
        this.badVerb(verb, v);
    }
  }

  badVerb(verb: string, arg: GoValue): void {
    this.erroring = true;
    this.buf += `%!${verb}(`;
    if (arg !== null && arg !== undefined) {
      this.buf += typeName(arg);
      this.buf += "=";
      this.printArg(arg, "v");
    } else this.buf += "<nil>";
    this.buf += ")";
    this.erroring = false;
  }

  printArg(arg: GoValue, verb: string): void {
    if (arg === null || arg === undefined) {
      if (verb === "T" || verb === "v") this.pad("<nil>");
      else this.badVerb(verb, null);
      return;
    }
    if (verb === "T") {
      this.fmtS(typeName(arg));
      return;
    }
    if (verb === "p") {
      this.badVerb(verb, arg);
      return;
    }
    switch (kindOf(arg)) {
      case "bool":
        if (verb === "t" || verb === "v") this.fmtBoolean(arg as boolean);
        else this.badVerb(verb, arg);
        return;
      case "float64":
        this.floatVerb(arg as number, verb);
        return;
      case "complex":
        this.fmtComplex(arg as GoComplex, verb);
        return;
      case "int":
        this.intVerb(arg as bigint, true, verb, arg);
        return;
      case "uint":
        this.intVerb(BigInt((arg as GoUint8).n), false, verb, arg);
        return;
      case "string":
        this.stringVerb(arg as string, verb, arg);
        return;
      case "map":
        this.mapVerb(arg as GoMap, verb);
        return;
    }
  }

  private intVerb(v: bigint, signed: boolean, verb: string, arg: GoValue): void {
    switch (verb) {
      case "v":
        if (this.f.sharpV && !signed) {
          const old = this.f.sharp;
          this.f.sharp = true;
          this.fmtInteger(v, 16, false, verb, LDIGITS);
          this.f.sharp = old;
        } else this.fmtInteger(v, 10, signed, verb, LDIGITS);
        return;
      case "d":
        this.fmtInteger(v, 10, signed, verb, LDIGITS);
        return;
      case "b":
        this.fmtInteger(v, 2, signed, verb, LDIGITS);
        return;
      case "o":
      case "O":
        this.fmtInteger(v, 8, signed, verb, LDIGITS);
        return;
      case "x":
        this.fmtInteger(v, 16, signed, verb, LDIGITS);
        return;
      case "X":
        this.fmtInteger(v, 16, signed, verb, UDIGITS);
        return;
      case "c":
        this.fmtC(v);
        return;
      case "q":
        this.fmtQc(v);
        return;
      case "U":
        this.fmtUnicode(v);
        return;
      default:
        this.badVerb(verb, arg);
    }
  }

  private stringVerb(s: string, verb: string, arg: GoValue): void {
    switch (verb) {
      case "v":
        if (this.f.sharpV) this.fmtQ(s);
        else this.fmtS(s);
        return;
      case "s":
        this.fmtS(s);
        return;
      case "x":
        this.fmtSx(s, LDIGITS);
        return;
      case "X":
        this.fmtSx(s, UDIGITS);
        return;
      case "q":
        this.fmtQ(s);
        return;
      default:
        this.badVerb(verb, arg);
    }
  }

  private mapVerb(m: GoMap, verb: string): void {
    if (this.f.sharpV) {
      this.buf += "map[string]interface {}{";
      const keys = [...m.entries.keys()].sort(compareStrings);
      keys.forEach((k, i) => {
        if (i > 0) this.buf += ", ";
        this.printArg(k, verb);
        this.buf += ":";
        this.printArg(m.entries.get(k), verb);
      });
      this.buf += "}";
      return;
    }
    this.buf += "map[";
    const keys = [...m.entries.keys()].sort(compareStrings);
    keys.forEach((k, i) => {
      if (i > 0) this.buf += " ";
      this.printArg(k, verb);
      this.buf += ":";
      this.printArg(m.entries.get(k), verb);
    });
    this.buf += "]";
  }
}

/** Go compares strings bytewise (UTF-8); this orders by code point, which is the same order. */
export function compareStrings(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = (x.value as string).codePointAt(0) ?? 0;
    const cy = (y.value as string).codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** fmt.Sprint. */
export function sprint(args: GoValue[]): string {
  const p = new Printer();
  let prevString = false;
  args.forEach((arg, i) => {
    const isString = typeof arg === "string";
    if (i > 0 && !isString && !prevString) p.buf += " ";
    p.f = clearFlags();
    p.printArg(arg, "v");
    prevString = isString;
  });
  return p.buf;
}

/** fmt.Sprintln. */
export function sprintln(args: GoValue[]): string {
  const p = new Printer();
  args.forEach((arg, i) => {
    if (i > 0) p.buf += " ";
    p.f = clearFlags();
    p.printArg(arg, "v");
  });
  return `${p.buf}\n`;
}

/** fmt.Sprintf. */
export function sprintf(format: string, a: GoValue[]): string {
  const p = new Printer();
  const chars = [...format];
  const end = chars.length;
  let argNum = 0;
  let i = 0;
  const parsenum = (): { num: number; present: boolean } => {
    let num = 0;
    let present = false;
    while (i < end) {
      const c = chars[i] ?? "";
      if (c < "0" || c > "9") break;
      if (num > 1e6) return { num: 0, present: false };
      num = num * 10 + (c.charCodeAt(0) - 48);
      present = true;
      i++;
    }
    return { num, present };
  };
  const intFromArg = (): { num: number; present: boolean } => {
    const arg = a[argNum];
    if (argNum < a.length) {
      argNum++;
      if (typeof arg === "bigint") {
        const n = Number(arg);
        if (Math.abs(n) <= 1e6) return { num: n, present: true };
        return { num: 0, present: false };
      }
      return { num: 0, present: false };
    }
    return { num: 0, present: false };
  };
  while (i < end) {
    const start = i;
    while (i < end && chars[i] !== "%") i++;
    if (i > start) p.buf += chars.slice(start, i).join("");
    if (i >= end) break;
    i++;
    p.f = clearFlags();
    flags: for (; i < end; i++) {
      switch (chars[i]) {
        case "#":
          p.f.sharp = true;
          break;
        case "0":
          p.f.zero = true;
          break;
        case "+":
          p.f.plus = true;
          break;
        case "-":
          p.f.minus = true;
          break;
        case " ":
          p.f.space = true;
          break;
        default:
          break flags;
      }
    }
    if (chars[i] === "*") {
      i++;
      const r = intFromArg();
      p.f.wid = r.num;
      p.f.widPresent = r.present;
      if (!r.present) p.buf += "%!(BADWIDTH)";
      if (p.f.wid < 0) {
        p.f.wid = -p.f.wid;
        p.f.minus = true;
        p.f.zero = false;
      }
    } else {
      const r = parsenum();
      p.f.wid = r.num;
      p.f.widPresent = r.present;
    }
    if (i + 1 < end && chars[i] === ".") {
      i++;
      if (chars[i] === "*") {
        i++;
        const r = intFromArg();
        p.f.prec = r.num;
        p.f.precPresent = r.present;
        if (p.f.prec < 0) {
          p.f.prec = 0;
          p.f.precPresent = false;
        }
        if (!p.f.precPresent) p.buf += "%!(BADPREC)";
      } else {
        const r = parsenum();
        p.f.prec = r.num;
        p.f.precPresent = true;
        if (!r.present) p.f.prec = 0;
      }
    }
    if (i >= end) {
      p.buf += "%!(NOVERB)";
      break;
    }
    const verb = chars[i] ?? "";
    i++;
    if (verb === "%") {
      p.buf += "%";
    } else if (argNum >= a.length) {
      p.buf += `%!${verb}(MISSING)`;
    } else {
      if (verb === "v") {
        p.f.sharpV = p.f.sharp;
        p.f.sharp = false;
        p.f.plusV = p.f.plus;
        p.f.plus = false;
      }
      p.printArg(a[argNum], verb);
      argNum++;
    }
  }
  if (argNum < a.length) {
    p.f = clearFlags();
    p.buf += "%!(EXTRA ";
    a.slice(argNum).forEach((arg, idx) => {
      if (idx > 0) p.buf += ", ";
      if (arg === null || arg === undefined) p.buf += "<nil>";
      else {
        p.buf += typeName(arg);
        p.buf += "=";
        p.printArg(arg, "v");
      }
    });
    p.buf += ")";
  }
  return p.buf;
}

/** fmt.Sprint of a single value. */
export function sprintValue(v: GoValue): string {
  return sprint([v]);
}
