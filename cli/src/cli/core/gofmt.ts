/**
 * Small ports of the Go standard library behaviours whose exact text leaks into user-visible
 * output: strconv parsing errors, %q quoting, time.ParseDuration and Duration.String.
 * Flag parsing reproduces pflag's messages, so these have to match Go, not "something similar".
 */

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** strconv.Quote. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\x07":
        out += "\\a";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\v":
        out += "\\v";
        continue;
    }
    if (ch === " " || PRINTABLE.test(ch)) out += ch;
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}

/** fmt's %#q for one string: a raw string when it can be back-quoted, strconv.Quote otherwise. */
export function goBackquote(s: string): string {
  // strconv.CanBackquote: no control characters other than tab, no back quote, no BOM.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is exactly the Go rule
  const canBackquote = !/[\u0000-\u0008\u000a-\u001f\u007f`﻿]/.test(s);
  return canBackquote ? `\`${s}\`` : goQuote(s);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function numError(fn: string, input: string, why: string): string {
  return `strconv.${fn}: parsing ${goQuote(input)}: ${why}`;
}

/** strconv.ParseBool. */
export function parseGoBool(s: string): ParseResult<boolean> {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(s)) return { ok: true, value: true };
  if (["0", "f", "F", "FALSE", "false", "False"].includes(s)) return { ok: true, value: false };
  return { ok: false, error: numError("ParseBool", s, "invalid syntax") };
}

/** Go's underscoreOK: underscores are only legal between digits or after a base prefix. */
function underscoreOK(input: string): boolean {
  let s = input;
  let saw = "^";
  let i = 0;
  if (s.length >= 1 && (s[0] === "-" || s[0] === "+")) s = s.slice(1);
  let hex = false;
  if (s.length >= 2 && s[0] === "0" && "bBoOxX".includes(s[1] ?? "")) {
    i = 2;
    saw = "0";
    hex = (s[1] ?? "").toLowerCase() === "x";
  }
  for (; i < s.length; i++) {
    const c = s[i] ?? "";
    if ((c >= "0" && c <= "9") || (hex && /[a-fA-F]/.test(c))) {
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

const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

/** strconv.ParseInt(s, base, 64) for base 0 or 10; `fn` is the name Go reports in the error. */
export function parseGoInt(s: string, base: 0 | 10 = 0, fn = "ParseInt"): ParseResult<bigint> {
  const syntax = { ok: false as const, error: numError(fn, s, "invalid syntax") };
  if (s === "") return syntax;
  let rest = s;
  let neg = false;
  if (rest[0] === "+" || rest[0] === "-") {
    neg = rest[0] === "-";
    rest = rest.slice(1);
  }
  let radix = 10;
  let underscores = false;
  if (base === 0) {
    if (rest[0] === "0") {
      const p = (rest[1] ?? "").toLowerCase();
      if (rest.length >= 3 && p === "b") {
        radix = 2;
        rest = rest.slice(2);
      } else if (rest.length >= 3 && p === "o") {
        radix = 8;
        rest = rest.slice(2);
      } else if (rest.length >= 3 && p === "x") {
        radix = 16;
        rest = rest.slice(2);
      } else {
        radix = 8;
        rest = rest.slice(1);
        if (rest === "") rest = "0";
      }
    }
    underscores = true;
  }
  if (rest === "") return syntax;
  if (rest.includes("_")) {
    if (!underscores || !underscoreOK(s)) return syntax;
    rest = rest.replaceAll("_", "");
  }
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, radix);
  let n = 0n;
  const r = BigInt(radix);
  for (const ch of rest.toLowerCase()) {
    const d = digits.indexOf(ch);
    if (d < 0) return syntax;
    n = n * r + BigInt(d);
  }
  const v = neg ? -n : n;
  if (v > INT64_MAX || v < INT64_MIN) {
    return { ok: false, error: numError(fn, s, "value out of range") };
  }
  return { ok: true, value: v };
}

/** strconv.ParseFloat for the forms a flag value realistically takes. */
export function parseGoFloat(s: string): ParseResult<number> {
  const t = s.replaceAll("_", "");
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && !s.startsWith("_")) {
    const v = Number(t);
    if (!Number.isFinite(v))
      return { ok: false, error: numError("ParseFloat", s, "value out of range") };
    return { ok: true, value: v };
  }
  const lower = s.toLowerCase();
  if (["inf", "+inf", "infinity", "+infinity"].includes(lower))
    return { ok: true, value: Infinity };
  if (["-inf", "-infinity"].includes(lower)) return { ok: true, value: -Infinity };
  if (lower === "nan") return { ok: true, value: Number.NaN };
  return { ok: false, error: numError("ParseFloat", s, "invalid syntax") };
}

const UNIT_NS: Record<string, number> = {
  ns: 1,
  us: 1e3,
  µs: 1e3,
  μs: 1e3,
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
};

/** time.ParseDuration; returns nanoseconds. */
export function parseGoDuration(orig: string): ParseResult<number> {
  const invalid = { ok: false as const, error: `time: invalid duration ${goQuote(orig)}` };
  let s = orig;
  let neg = false;
  if (s !== "") {
    const c = s[0];
    if (c === "-" || c === "+") {
      neg = c === "-";
      s = s.slice(1);
    }
  }
  if (s === "0") return { ok: true, value: 0 };
  if (s === "") return invalid;
  let total = 0;
  while (s !== "") {
    const m = /^(\d*)(\.\d*)?/.exec(s);
    const whole = m?.[1] ?? "";
    const frac = m?.[2] ?? "";
    if (whole === "" && (frac === "" || frac === ".")) return invalid;
    s = s.slice((m?.[0] ?? "").length);
    const um = /^[^\d.]+/.exec(s);
    if (!um) {
      return { ok: false, error: `time: missing unit in duration ${goQuote(orig)}` };
    }
    const unit = um[0];
    s = s.slice(unit.length);
    const mult = UNIT_NS[unit];
    if (mult === undefined) {
      return {
        ok: false,
        error: `time: unknown unit ${goQuote(unit)} in duration ${goQuote(orig)}`,
      };
    }
    total += Number(`${whole || "0"}${frac}`) * mult;
  }
  return { ok: true, value: Math.round(neg ? -total : total) };
}

/** time.Duration.String for a nanosecond count. */
export function formatGoDuration(ns: number): string {
  if (ns === 0) return "0s";
  const neg = ns < 0;
  let u = Math.abs(ns);
  let out: string;
  const trim = (n: number): string => {
    const s = n.toFixed(9).replace(/\.?0+$/, "");
    return s === "" ? "0" : s;
  };
  if (u < 1e3) out = `${u}ns`;
  else if (u < 1e6) out = `${trim(u / 1e3)}µs`;
  else if (u < 1e9) out = `${trim(u / 1e6)}ms`;
  else {
    const h = Math.floor(u / 3600e9);
    u -= h * 3600e9;
    const m = Math.floor(u / 60e9);
    u -= m * 60e9;
    const sec = `${trim(u / 1e9)}s`;
    out = h > 0 ? `${h}h${m}m${sec}` : m > 0 ? `${m}m${sec}` : sec;
  }
  return neg ? `-${out}` : out;
}

/** Levenshtein distance as cobra computes it for "Did you mean" suggestions (ASCII-lowered). */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const d: number[][] = Array.from({ length: s.length + 1 }, (_, i) => {
    const row = new Array<number>(t.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  const row0 = d[0];
  if (row0) for (let j = 0; j <= t.length; j++) row0[j] = j;
  for (let j = 1; j <= t.length; j++) {
    for (let i = 1; i <= s.length; i++) {
      const cur = d[i];
      const prev = d[i - 1];
      if (!cur || !prev) continue;
      if (s[i - 1] === t[j - 1]) cur[j] = prev[j - 1] ?? 0;
      else cur[j] = Math.min(prev[j] ?? 0, cur[j - 1] ?? 0, prev[j - 1] ?? 0) + 1;
    }
  }
  return d[s.length]?.[t.length] ?? 0;
}

/** json.MarshalIndent(v, "", "  ") text: Go escapes <, > and & and the line separators. */
export function goJSONIndent(v: unknown): string {
  return JSON.stringify(v, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}
