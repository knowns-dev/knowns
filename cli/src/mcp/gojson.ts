// Go encoding/json emulation for the MCP wire. mcp-go marshals tool definitions, results and
// responses through maps (keys sorted by UTF-8 bytes) and a few fixed-order structs, and escapes
// <, >, & and the line separators; handlers use json.MarshalIndent(v, "", "  ").
import { goJsonStringify, sortKeysDeep } from "../storage/core/util.ts";

export { sortKeysDeep };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export type Args = Record<string, unknown>;

/** json.Marshal(v): compact, HTML-escaped. Key order is the insertion order of `v`. */
export function marshal(value: unknown): string {
  return goJsonStringify(value, 0);
}

/** json.MarshalIndent(v, "", "  "). */
export function marshalIndent(value: unknown): string {
  return goJsonStringify(value, 2);
}

/** A Go map[string]any at the top level: keys sorted by UTF-8 bytes, values untouched. */
export function goMap<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort(compareBytes)) out[k] = obj[k];
  return out;
}

const enc = new TextEncoder();
export function compareBytes(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Go's %v for a value decoded from JSON (map[string]any, []any, float64, string, bool, nil). */
export function goSprintV(v: unknown): string {
  if (v === null || v === undefined) return "<nil>";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return goFloat64V(v);
  if (Array.isArray(v)) return `[${v.map(goSprintV).join(" ")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `map[${Object.keys(o)
      .sort(compareBytes)
      .map((k) => `${k}:${goSprintV(o[k])}`)
      .join(" ")}]`;
  }
  return String(v);
}

/** strconv.FormatFloat(f, 'g', -1, 64): %v of a float64 (shortest, exponent at <1e-4 or >=1e21). */
export function goFloat64V(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (f === Infinity) return "+Inf";
  if (f === -Infinity) return "-Inf";
  if (f === 0) return Object.is(f, -0) ? "-0" : "0";
  // %v uses %g with the shortest representation: exponent form when exp < -4 || exp >= 21.
  const s = f.toExponential(); // shortest digits, "d.ddde+X"
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return String(f);
  const sign = m[1] ?? "";
  const digits = (m[2] ?? "") + (m[3] ?? "");
  const e10 = Number(m[4]);
  if (e10 < -4 || e10 >= 21) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const ee = Math.abs(e10) < 10 ? `0${Math.abs(e10)}` : `${Math.abs(e10)}`;
    return `${sign}${mant}e${e10 < 0 ? "-" : "+"}${ee}`;
  }
  if (e10 >= 0) {
    if (digits.length <= e10 + 1) return sign + digits + "0".repeat(e10 + 1 - digits.length);
    return `${sign}${digits.slice(0, e10 + 1)}.${digits.slice(e10 + 1)}`;
  }
  return `${sign}0.${"0".repeat(-e10 - 1)}${digits}`;
}
