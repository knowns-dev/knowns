// Go-compatible JSON primitives for the history layer.
//
// Record hashes are SHA-256 over `json.Marshal` output, so the byte stream has to match Go exactly:
// struct fields in declaration order, `map[string]any` keys sorted by UTF-8 bytes, HTML-escaped
// strings, numbers round-tripped through float64, and time.Time as RFC 3339 with the shortest
// fractional part.
import { createHash } from "node:crypto";
import { GO_ZERO_TIME } from "../../models/common.ts";

export type AnyMap = Record<string, unknown>;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256")
    .update(data as string)
    .digest("hex");
}

/**
 * Marks a subtree whose object keys are emitted sorted, as Go does for `map[string]any` (and for
 * anything that went through a JSON read). Everything not wrapped keeps insertion order, which is
 * how Go emits a struct.
 */
export class Sorted {
  constructor(readonly value: unknown) {}
}

const encoder = new TextEncoder();

function compareUtf8(a: string, b: string): number {
  // eslint-free fast path: pure ASCII sorts identically by UTF-16 code unit and by UTF-8 byte.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII probe
  if (/^[\x00-\x7f]*$/.test(a) && /^[\x00-\x7f]*$/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export function sortedKeys(obj: object): string[] {
  return Object.keys(obj).sort(compareUtf8);
}

function writeString(s: string, out: string[]): void {
  out.push(
    JSON.stringify(s)
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026")
      .replaceAll(" ", "\\u2028")
      .replaceAll(" ", "\\u2029"),
  );
}

function isRawJson(v: object): boolean {
  return Object.hasOwn(v, "rawJSON") && Object.getPrototypeOf(v) === null;
}

function write(value: unknown, sort: boolean, out: string[]): void {
  if (value instanceof Sorted) {
    write(value.value, true, out);
    return;
  }
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      writeString(value, out);
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error("json: unsupported value: non-finite number");
      out.push(String(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "bigint":
      out.push(value.toString());
      return;
    case "object": {
      if (isRawJson(value)) {
        out.push((value as { rawJSON: string }).rawJSON);
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((item, i) => {
          if (i > 0) out.push(",");
          write(item === undefined ? null : item, sort, out);
        });
        out.push("]");
        return;
      }
      const obj = value as AnyMap;
      const keys = sort ? sortedKeys(obj) : Object.keys(obj);
      out.push("{");
      let first = true;
      for (const key of keys) {
        const v = obj[key];
        if (v === undefined || typeof v === "function") continue;
        if (!first) out.push(",");
        first = false;
        writeString(key, out);
        out.push(":");
        write(v, sort, out);
      }
      out.push("}");
      return;
    }
    default:
      out.push("null");
  }
}

/** json.Marshal. Pass `sort` for `map[string]any` semantics, or wrap subtrees in `Sorted`. */
export function goMarshal(value: unknown, sort = false): string {
  const out: string[] = [];
  write(value, sort, out);
  return out.join("");
}

/** A JSON round trip as Go's decoder sees it: every number a float64, objects as plain maps. */
export function normalizeAny<T = unknown>(value: T): T {
  return JSON.parse(goMarshal(value, true)) as T;
}

/** Deep clone through JSON (Go's cloneMap/cloneHistoryValue only ever see JSON-shaped data). */
export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(goMarshal(value, false)) as T;
}

/** JSON.parse that keeps nothing but plain float64 numbers (what encoding/json gives `any`). */
export function parseGoAny(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Canonical RFC 3339 form Go's `time.Time` marshals to: trailing fractional zeros dropped, at most
 * nine digits, a zero offset written as `Z`. Strings that are not RFC 3339 are returned unchanged.
 */
export function goTime(ts: string | undefined): string {
  if (ts === undefined || ts === "") return GO_ZERO_TIME;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) return ts;
  const frac = (m[2] ?? "").slice(0, 9).replace(/0+$/, "");
  const zone = m[3] === "+00:00" || m[3] === "-00:00" ? "Z" : (m[3] as string);
  return `${m[1]}${frac === "" ? "" : `.${frac}`}${zone}`;
}

/** time.Now().UTC() as Go marshals it. */
export function goNow(date: Date = new Date()): string {
  return goTime(date.toISOString());
}

export function isGoZeroTime(ts: string | undefined): boolean {
  return ts === undefined || ts === "" || goTime(ts) === GO_ZERO_TIME;
}

/** Milliseconds since epoch, or NaN. */
export function timeMs(ts: string | undefined): number {
  return ts === undefined ? Number.NaN : Date.parse(ts);
}

/** reflect.DeepEqual over JSON-shaped values, where a nil slice differs from an empty one. */
export function goDeepEqual(a: unknown, b: unknown): boolean {
  const nilA = a === null || a === undefined;
  const nilB = b === null || b === undefined;
  if (nilA || nilB) return nilA && nilB;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => goDeepEqual(item, b[i]));
  }
  if (typeof a === "object") {
    const x = a as AnyMap;
    const y = b as AnyMap;
    const kx = Object.keys(x).filter((k) => x[k] !== undefined);
    const ky = Object.keys(y).filter((k) => y[k] !== undefined);
    if (kx.length !== ky.length) return false;
    return kx.every((k) => Object.hasOwn(y, k) && goDeepEqual(x[k], y[k]));
  }
  return a === b;
}

export function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) if (v !== undefined && v !== "") return v;
  return "";
}

export function firstPositive(...values: (number | undefined)[]): number {
  for (const v of values) if (v !== undefined && v > 0) return v;
  return 0;
}
