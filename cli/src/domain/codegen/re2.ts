// A translator from Go's RE2 regexp syntax to a JS RegExp (always in unicode mode) and Go's
// Regexp.ReplaceAll with its `$1` / `${name}` expansion. The `modify` template action is the only
// user of the translated expressions.
//
// Known divergences: the `i` flag is only supported as a leading (?i) (JS has no scoped flag);
// \S inside a character class and \pN/\p{Name} classes follow JS semantics; error messages are
// those of the common syntax errors only.
import { isDigit, isLetter } from "./goquote.ts";

export class RegexpSyntaxError extends Error {
  constructor(code: string, arg: string) {
    super(`error parsing regexp: ${code}: ${goBacktick(arg)}`);
  }
}

function goBacktick(s: string): string {
  return `\`${s}\``;
}

export interface CompiledRegexp {
  source: string;
  re: RegExp;
  /** Group names by index (index 0 is the whole match, "" for unnamed groups). */
  names: string[];
}

const POSIX: Record<string, string> = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  ascii: "\\u{0}-\\u{7F}",
  blank: "\\t ",
  cntrl: "\\u{0}-\\u{1F}\\u{7F}",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\t\\n\\v\\f\\r ",
  upper: "A-Z",
  word: "0-9A-Za-z_",
  xdigit: "0-9A-Fa-f",
};

function cp(c: number): string {
  return `\\u{${c.toString(16)}}`;
}

interface Flags {
  m: boolean;
  s: boolean;
  U: boolean;
}

class Translator {
  private i = 0;
  private readonly names: string[] = [""];
  private ignoreCase = false;

  constructor(private readonly pat: string) {}

  translate(): CompiledRegexp {
    // leading (?i) / (?flags) is hoisted into JS flags when it contains i
    let flags: Flags = { m: false, s: false, U: false };
    const lead = /^\(\?([imsU]+)\)/.exec(this.pat);
    if (lead) {
      const f = lead[1] ?? "";
      if (f.includes("i")) {
        this.ignoreCase = true;
      }
    }
    const out = this.parseAlternation(flags, 0);
    if (this.i < this.pat.length) {
      // only an unmatched ')' stops the top-level parse
      throw new RegexpSyntaxError("unexpected )", this.pat);
    }
    flags = { m: false, s: false, U: false };
    const source = out;
    let re: RegExp;
    try {
      re = new RegExp(source, `u${this.ignoreCase ? "i" : ""}`);
    } catch (e) {
      throw new RegexpSyntaxError(`unsupported by this build (${(e as Error).message})`, this.pat);
    }
    return { source, re, names: this.names };
  }

  private parseAlternation(flagsIn: Flags, depth: number): string {
    let flags = { ...flagsIn };
    const alts: string[] = [];
    let cur = "";
    let canRepeat = false;
    let lastWasQuant = false;
    const pat = this.pat;
    while (this.i < pat.length) {
      const c = pat[this.i] as string;
      if (c === "|") {
        alts.push(cur);
        cur = "";
        canRepeat = false;
        lastWasQuant = false;
        this.i++;
        continue;
      }
      if (c === ")") {
        if (depth === 0) throw new RegexpSyntaxError("unexpected )", pat);
        break;
      }
      if (c === "*" || c === "+" || c === "?" || (c === "{" && this.looksLikeRepeat())) {
        const start = this.i;
        if (!canRepeat) {
          if (lastWasQuant) {
            throw new RegexpSyntaxError(
              "invalid nested repetition operator",
              pat.slice(this.quantStart, this.afterQuant(start)),
            );
          }
          const op = c === "{" ? this.readRepeat() : c;
          throw new RegexpSyntaxError("missing argument to repetition operator", op);
        }
        let q = c;
        if (c === "{") q = this.readRepeat();
        else this.i++;
        let lazy = false;
        if (pat[this.i] === "?") {
          lazy = true;
          this.i++;
        }
        if (flags.U) lazy = !lazy;
        cur += q + (lazy ? "?" : "");
        canRepeat = false;
        lastWasQuant = true;
        this.quantStart = start;
        continue;
      }
      lastWasQuant = false;
      switch (c) {
        case "(": {
          const g = this.parseGroup(flags, depth);
          if (g.flagsOnly) {
            flags = g.flags;
            canRepeat = false;
          } else {
            cur += g.text;
            canRepeat = true;
          }
          break;
        }
        case "[":
          cur += this.parseClass();
          canRepeat = true;
          break;
        case ".":
          this.i++;
          cur += flags.s ? "[\\s\\S]" : "[^\\n]";
          canRepeat = true;
          break;
        case "^":
          this.i++;
          cur += flags.m ? "(?<![^\\n])" : "^";
          canRepeat = false;
          break;
        case "$":
          this.i++;
          cur += flags.m ? "(?![^\\n])" : "$";
          canRepeat = false;
          break;
        case "\\": {
          const r = this.parseEscape(false);
          cur += r.text;
          canRepeat = r.repeatable;
          break;
        }
        default: {
          const code = pat.codePointAt(this.i) ?? 0;
          this.i += code > 0xffff ? 2 : 1;
          cur += cp(code);
          canRepeat = true;
        }
      }
    }
    alts.push(cur);
    return alts.join("|");
  }

  private quantStart = 0;

  private afterQuant(start: number): number {
    let j = start + 1;
    if (this.pat[start] === "{") {
      j = this.pat.indexOf("}", start) + 1;
    }
    if (this.pat[j] === "?") j++;
    return j;
  }

  private looksLikeRepeat(): boolean {
    return /^\{\d+(,\d*)?\}/.test(this.pat.slice(this.i));
  }

  private readRepeat(): string {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.pat.slice(this.i));
    if (!m) throw new RegexpSyntaxError("invalid repeat count", this.pat.slice(this.i));
    const lo = Number.parseInt(m[1] ?? "0", 10);
    const hi = m[2] === undefined ? lo : m[3] === "" ? -1 : Number.parseInt(m[3] ?? "0", 10);
    if (lo > 1000 || hi > 1000 || (hi >= 0 && lo > hi)) {
      throw new RegexpSyntaxError("invalid repeat count", m[0]);
    }
    this.i += m[0].length;
    return m[0];
  }

  private parseGroup(
    flagsIn: Flags,
    depth: number,
  ): { text: string; flagsOnly: boolean; flags: Flags } {
    const pat = this.pat;
    const start = this.i;
    this.i++; // (
    let open = "(";
    let flags = { ...flagsIn };
    if (pat[this.i] === "?") {
      const rest = pat.slice(this.i);
      const named = /^\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
      const plain = /^\?:/.exec(rest);
      const fl = /^\?([imsU]*)(?:-([imsU]*))?([:)])/.exec(rest);
      if (named) {
        this.i += named[0].length;
        open = `(?<${named[1]}>`;
        this.names.push(named[1] ?? "");
      } else if (plain) {
        this.i += 2;
        open = "(?:";
      } else if (fl && (fl[1] || fl[2])) {
        const m = fl;
        this.i += m[0].length;
        const on = m[1] ?? "";
        const off = m[2] ?? "";
        if (on.includes("i") && !(start === 0 && m[3] === ")")) {
          throw new RegexpSyntaxError("flag i is only supported at the start of the pattern", m[0]);
        }
        flags = {
          m: (flags.m || on.includes("m")) && !off.includes("m"),
          s: (flags.s || on.includes("s")) && !off.includes("s"),
          U: (flags.U || on.includes("U")) && !off.includes("U"),
        };
        if (m[3] === ")") return { text: "", flagsOnly: true, flags };
        open = "(?:";
      } else {
        throw new RegexpSyntaxError(
          "invalid or unsupported Perl syntax",
          pat.slice(this.i - 1, this.i + 2),
        );
      }
    } else {
      this.names.push("");
    }
    const inner = this.parseAlternation(flags, depth + 1);
    if (pat[this.i] !== ")") {
      throw new RegexpSyntaxError("missing closing )", pat);
    }
    this.i++;
    return { text: `${open}${inner})`, flagsOnly: false, flags: flagsIn };
  }

  private parseEscape(inClass: boolean): { text: string; repeatable: boolean; cp?: number } {
    const pat = this.pat;
    const start = this.i;
    this.i++; // backslash
    if (this.i >= pat.length)
      throw new RegexpSyntaxError("trailing backslash at end of expression", "");
    const c = pat[this.i] as string;
    this.i++;
    const lit = (code: number) => ({ text: cp(code), repeatable: true, cp: code });
    switch (c) {
      case "a":
        return lit(7);
      case "f":
        return lit(12);
      case "n":
        return lit(10);
      case "r":
        return lit(13);
      case "t":
        return lit(9);
      case "v":
        return lit(11);
      case "d":
      case "D":
      case "w":
      case "W":
        return { text: `\\${c}`, repeatable: true };
      case "s":
        return { text: inClass ? "\\t\\n\\f\\r " : "[\\t\\n\\f\\r ]", repeatable: true };
      case "S":
        return { text: inClass ? "\\S" : "[^\\t\\n\\f\\r ]", repeatable: true };
      case "b":
      case "B":
        if (inClass)
          throw new RegexpSyntaxError("invalid escape sequence", pat.slice(start, this.i));
        return { text: `\\${c}`, repeatable: false };
      case "A":
        if (inClass)
          throw new RegexpSyntaxError("invalid escape sequence", pat.slice(start, this.i));
        return { text: "^", repeatable: false };
      case "z":
        if (inClass)
          throw new RegexpSyntaxError("invalid escape sequence", pat.slice(start, this.i));
        return { text: "$", repeatable: false };
      case "p":
      case "P": {
        let name: string;
        if (pat[this.i] === "{") {
          const end = pat.indexOf("}", this.i);
          if (end < 0)
            throw new RegexpSyntaxError("invalid character class range", pat.slice(start));
          name = pat.slice(this.i + 1, end);
          this.i = end + 1;
        } else {
          name = pat[this.i] ?? "";
          this.i++;
        }
        let neg = c === "P";
        if (name.startsWith("^")) {
          neg = !neg;
          name = name.slice(1);
        }
        return { text: `\\${neg ? "P" : "p"}{${name}}`, repeatable: true };
      }
      case "Q": {
        const end = pat.indexOf("\\E", this.i);
        const body = end < 0 ? pat.slice(this.i) : pat.slice(this.i, end);
        this.i = end < 0 ? pat.length : end + 2;
        let text = "";
        for (const ch of body) text += cp(ch.codePointAt(0) ?? 0);
        return { text: inClass ? text : `(?:${text})`, repeatable: true };
      }
      case "x": {
        let code: number;
        if (pat[this.i] === "{") {
          const end = pat.indexOf("}", this.i);
          const hex = end < 0 ? "" : pat.slice(this.i + 1, end);
          if (!/^[0-9a-fA-F]+$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) {
            throw new RegexpSyntaxError(
              "invalid escape sequence",
              pat.slice(start, end < 0 ? pat.length : end + 1),
            );
          }
          code = Number.parseInt(hex, 16);
          this.i = end + 1;
        } else {
          const hex = pat.slice(this.i, this.i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
            throw new RegexpSyntaxError("invalid escape sequence", pat.slice(start, this.i + 2));
          }
          code = Number.parseInt(hex, 16);
          this.i += 2;
        }
        return lit(code);
      }
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        if (c !== "0" && !/^[0-7]/.test(pat[this.i] ?? "")) {
          throw new RegexpSyntaxError("invalid escape sequence", pat.slice(start, this.i));
        }
        let code = Number.parseInt(c, 8);
        for (let n = 0; n < 2 && /^[0-7]/.test(pat[this.i] ?? ""); n++) {
          code = code * 8 + Number.parseInt(pat[this.i] as string, 8);
          this.i++;
        }
        return lit(code);
      }
    }
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x80 && !/[A-Za-z0-9_]/.test(c)) return lit(code);
    throw new RegexpSyntaxError("invalid escape sequence", pat.slice(start, this.i));
  }

  private parseClass(): string {
    const pat = this.pat;
    const start = this.i;
    this.i++; // [
    let neg = false;
    if (pat[this.i] === "^") {
      neg = true;
      this.i++;
    }
    let body = "";
    let first = true;
    for (;;) {
      if (this.i >= pat.length) throw new RegexpSyntaxError("missing closing ]", pat.slice(start));
      const c = pat[this.i] as string;
      if (c === "]" && !first) {
        this.i++;
        break;
      }
      first = false;
      // POSIX class
      const px = /^\[:(\^?)([a-z]+):\]/.exec(pat.slice(this.i));
      if (px) {
        const set = POSIX[px[2] ?? ""];
        if (!set) throw new RegexpSyntaxError("invalid character class range", px[0]);
        this.i += px[0].length;
        if (px[1] === "^") {
          // negated POSIX class inside a class: approximate through a lookup of the complement
          throw new RegexpSyntaxError("negated POSIX class is not supported", px[0]);
        }
        body += set;
        continue;
      }
      const lo = this.classAtom();
      if (pat[this.i] === "-" && pat[this.i + 1] !== "]" && this.i + 1 < pat.length) {
        const dash = this.i;
        this.i++;
        const hi = this.classAtom();
        if (lo.cp === undefined || hi.cp === undefined) {
          throw new RegexpSyntaxError("invalid character class range", pat.slice(start, this.i));
        }
        if (hi.cp < lo.cp) {
          throw new RegexpSyntaxError("invalid character class range", pat.slice(dash - 1, this.i));
        }
        body += `${cp(lo.cp)}-${cp(hi.cp)}`;
      } else {
        body += lo.text;
      }
    }
    return `[${neg ? "^" : ""}${body}]`;
  }

  private classAtom(): { text: string; cp?: number } {
    const pat = this.pat;
    if (pat[this.i] === "\\") {
      const r = this.parseEscape(true);
      return r.cp === undefined ? { text: r.text } : { text: r.text, cp: r.cp };
    }
    const code = pat.codePointAt(this.i) ?? 0;
    this.i += code > 0xffff ? 2 : 1;
    return { text: cp(code), cp: code };
  }
}

/** regexp.Compile. Throws RegexpSyntaxError with Go's message for the common errors. */
export function compileRegexp(pattern: string): CompiledRegexp {
  return new Translator(pattern).translate();
}

// --- ReplaceAll ---------------------------------------------------------------------------------

function extract(str: string): { name: string; num: number; rest: string } | null {
  if (str === "") return null;
  let s = str;
  let brace = false;
  if (s[0] === "{") {
    brace = true;
    s = s.slice(1);
  }
  let i = 0;
  for (const ch of s) {
    if (!isLetter(ch) && !isDigit(ch) && ch !== "_") break;
    i += ch.length;
  }
  if (i === 0) return null;
  const name = s.slice(0, i);
  if (brace) {
    if (i >= s.length || s[i] !== "}") return null;
    i++;
  }
  let num = 0;
  for (let k = 0; k < name.length; k++) {
    const c = name[k] as string;
    if (c < "0" || c > "9" || num >= 1e8) {
      num = -1;
      break;
    }
    num = num * 10 + (c.charCodeAt(0) - 48);
  }
  if (name[0] === "0" && name.length > 1) num = -1;
  return { name, num, rest: s.slice(i) };
}

function expand(template: string, m: RegExpExecArray, names: string[]): string {
  let dst = "";
  let t = template;
  while (t.length > 0) {
    const at = t.indexOf("$");
    if (at < 0) break;
    dst += t.slice(0, at);
    t = t.slice(at + 1);
    if (t !== "" && t[0] === "$") {
      dst += "$";
      t = t.slice(1);
      continue;
    }
    const ex = extract(t);
    if (!ex) {
      dst += "$";
      continue;
    }
    t = ex.rest;
    if (ex.num >= 0) {
      const g = m[ex.num];
      if (ex.num < m.length && g !== undefined) dst += g;
    } else {
      for (let i = 0; i < names.length; i++) {
        if (names[i] === ex.name && i < m.length && m[i] !== undefined) {
          dst += m[i];
          break;
        }
      }
    }
  }
  return dst + t;
}

/** Regexp.ReplaceAll (replacement text goes through Expand). */
export function replaceAll(c: CompiledRegexp, src: string, repl: string): string {
  const re = new RegExp(c.re.source, `${c.re.flags.replace("g", "")}g`);
  let buf = "";
  let searchPos = 0;
  let lastMatchEnd = 0;
  while (searchPos <= src.length) {
    re.lastIndex = searchPos;
    const m = re.exec(src);
    if (!m) break;
    const a0 = m.index;
    const a1 = a0 + m[0].length;
    buf += src.slice(lastMatchEnd, a0);
    if (a1 > lastMatchEnd || a0 === 0) buf += expand(repl, m, c.names);
    lastMatchEnd = a1;
    const width = searchPos < src.length ? ((src.codePointAt(searchPos) ?? 0) > 0xffff ? 2 : 1) : 0;
    if (searchPos + width > a1) searchPos += width;
    else if (searchPos + 1 > a1) searchPos++;
    else searchPos = a1;
  }
  buf += src.slice(lastMatchEnd);
  return buf;
}
