// Helpers that emulate how Go's encoding/json marshals structs: declared field order, omitempty
// rules, and unknown keys dropped. Used where a Go typed struct (not a generic map) is written.
export type JsonObject = Record<string, unknown>;

/**
 * How one struct field is emitted:
 *  - "str"   string with omitempty        - "int" int with omitempty     - "bool" bool with omitempty
 *  - "ptr"   pointer/any with omitempty (omitted only when null/undefined)
 *  - "list"  slice with omitempty          - "map" map with omitempty
 *  - "req"   always emitted (undefined becomes `fallback`)
 *  - {spec}  pointer to a nested struct (omitted when null/undefined)
 *  - {mapOf} map of nested structs (omitted when empty)
 */
export type FieldKind =
  | "str"
  | "int"
  | "bool"
  | "ptr"
  | "list"
  | "map"
  | { req: unknown }
  | { spec: Spec }
  | { mapOf: Spec };
export type Spec = readonly (readonly [key: string, kind: FieldKind])[];

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Marshal `src` the way Go marshals the struct described by `spec`. */
export function shapeStruct(src: JsonObject, spec: Spec): JsonObject {
  const out: JsonObject = {};
  for (const [key, kind] of spec) {
    const v = src[key];
    if (typeof kind === "string") {
      switch (kind) {
        case "str":
          if (typeof v === "string" && v !== "") out[key] = v;
          break;
        case "int":
          if (typeof v === "number" && v !== 0) out[key] = v;
          else if (isObject(v) && Object.hasOwn(v, "rawJSON")) out[key] = v;
          break;
        case "bool":
          if (v === true) out[key] = v;
          break;
        case "ptr":
          if (v !== undefined && v !== null) out[key] = v;
          break;
        case "list":
          if (Array.isArray(v) && v.length > 0) out[key] = v;
          break;
        case "map":
          if (isObject(v) && Object.keys(v).length > 0) out[key] = v;
          break;
      }
    } else if ("req" in kind) {
      out[key] = v === undefined ? kind.req : v;
    } else if ("spec" in kind) {
      if (isObject(v)) out[key] = shapeStruct(v, kind.spec);
    } else if (isObject(v) && Object.keys(v).length > 0) {
      const m: JsonObject = {};
      for (const [k, item] of Object.entries(v)) {
        m[k] = isObject(item) ? shapeStruct(item, kind.mapOf) : item;
      }
      out[key] = m;
    }
  }
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

/** A Go map: keys sorted by UTF-8 bytes, values untouched. Top level only. */
export function sortTopLevel(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(obj).sort(compareBytes)) out[k] = obj[k];
  return out;
}

/** Deep-convert JSON.rawJSON number holders into plain numbers (Go json.Unmarshal into int/float). */
export function plainNumbers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainNumbers);
  if (isObject(value)) {
    if (Object.hasOwn(value, "rawJSON") && Object.getPrototypeOf(value) === null) {
      return Number((value as { rawJSON: string }).rawJSON);
    }
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = plainNumbers(v);
    return out;
  }
  return value;
}

/** JSON null for a Go slice/map/string/pointer field decodes to its zero value: drop top-level nulls. */
export function dropNulls(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null) out[k] = v;
  return out;
}
