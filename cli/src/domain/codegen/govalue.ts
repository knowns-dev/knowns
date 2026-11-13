// Values the Go text/template executor sees in the codegen engine. The data is always a
// map[string]interface{} holding strings and bools; everything else (int, float64, uint8,
// complex128) only arises from constants and builtin results.

/** A Go uint8, produced by `index "abc" 1`. */
export class GoUint8 {
  constructor(readonly n: number) {}
}

/** A Go complex128. */
export class GoComplex {
  constructor(
    readonly re: number,
    readonly im: number,
  ) {}
}

/** A map[string]interface{}. */
export class GoMap {
  constructor(readonly entries: Map<string, GoValue>) {}
}

/**
 * undefined is the invalid reflect.Value (a missing map key); null is a nil interface{} handed to a
 * function parameter; bigint is Go `int`; number is float64.
 */
export type GoValue =
  | undefined
  | null
  | string
  | boolean
  | bigint
  | number
  | GoUint8
  | GoComplex
  | GoMap;

export type GoKind = "invalid" | "string" | "bool" | "int" | "float64" | "uint" | "complex" | "map";

export function kindOf(v: GoValue): GoKind {
  if (v === undefined || v === null) return "invalid";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (typeof v === "number") return "float64";
  if (v instanceof GoUint8) return "uint";
  if (v instanceof GoComplex) return "complex";
  return "map";
}

/** reflect.Type.String() of the value's type. */
export function typeName(v: GoValue): string {
  switch (kindOf(v)) {
    case "string":
      return "string";
    case "bool":
      return "bool";
    case "int":
      return "int";
    case "float64":
      return "float64";
    case "uint":
      return "uint8";
    case "complex":
      return "complex128";
    case "map":
      return "map[string]interface {}";
    default:
      return "<nil>";
  }
}

/** Number of Unicode code points (Go's utf8.RuneCountInString). */
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** UTF-8 byte length of a JS string (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}
