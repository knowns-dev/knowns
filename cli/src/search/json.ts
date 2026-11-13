// encoding/json output compatible with Go: HTML characters and U+2028/U+2029 are escaped, map keys
// are sorted, and float32 values print with the shortest digits that round-trip as float32.

function escapeHtml(s: string): string {
  return s
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort(byteCompare)) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** json.Marshal for values whose maps Go would sort (payloads). Struct field order is the caller's. */
export function goJson(value: unknown, opts: { sortMaps?: boolean; indent?: number } = {}): string {
  const v = opts.sortMaps ? sortKeys(value) : value;
  return escapeHtml(JSON.stringify(v, null, opts.indent));
}

/** strconv.AppendFloat(x, 'f'|'e', -1, 32) as encoding/json writes a float32. */
export function float32Json(x: number): string {
  const f = Math.fround(x);
  if (!Number.isFinite(f)) throw new Error(`unsupported value: ${String(f)}`);
  if (f === 0) return Object.is(f, -0) ? "-0" : "0";
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(f.toPrecision(p));
    if (Math.fround(candidate) === f) return String(candidate).replace(/e([+-])0+(\d)/, "e$1$2");
  }
  return String(f);
}

export function float32ArrayJson(v: ArrayLike<number>): string {
  const parts: string[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) parts[i] = float32Json(v[i] as number);
  return `[${parts.join(",")}]`;
}
