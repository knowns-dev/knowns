// Go encoding/json behaviour the HTTP server's request and response bodies depend on: the
// Decoder's "first value only" rule with Go's own syntax error text, UnmarshalTypeError text for
// the fields the handlers read, and the Encoder's HTML escaping plus trailing newline.

export class GoJsonError extends Error {}

function quoteChar(c: string): string {
  if (c === "'") return "'\\''";
  if (c === '"') return "'\"'";
  const code = c.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) {
    const named: Record<number, string> = {
      9: "\\t",
      10: "\\n",
      13: "\\r",
      8: "\\b",
      12: "\\f",
      7: "\\a",
      11: "\\v",
    };
    return `'${named[code] ?? `\\x${code.toString(16).padStart(2, "0")}`}'`;
  }
  return `'${c}'`;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);

/**
 * Scans the first JSON value of `text` the way json.Decoder does and returns [start, end) of it.
 * Empty (or whitespace-only) input is "EOF"; input that ends inside a value is "unexpected EOF".
 */
export function scanFirstValue(text: string): [number, number] {
  let i = 0;
  const skip = (): void => {
    while (i < text.length && isSpace(text[i] as string)) i++;
  };
  const eof = (): never => {
    throw new GoJsonError("unexpected EOF");
  };
  const bad = (ctx: string): never => {
    const c = String.fromCodePoint(text.codePointAt(i) ?? 0);
    throw new GoJsonError(`invalid character ${quoteChar(c)} ${ctx}`);
  };
  const str = (): void => {
    i++; // opening quote
    for (;;) {
      if (i >= text.length) eof();
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return;
      }
      if (c < " ") bad("in string literal");
      if (c === "\\") {
        i++;
        if (i >= text.length) eof();
        const e = text[i] as string;
        if (e === "u") {
          for (let k = 0; k < 4; k++) {
            i++;
            if (i >= text.length) eof();
            if (!isHex(text[i])) bad("in \\u hexadecimal character escape");
          }
        } else if (!'"\\/bfnrt'.includes(e)) bad("in string escape code");
      }
      i++;
    }
  };
  const literal = (word: string): void => {
    for (let k = 1; k < word.length; k++) {
      i++;
      if (i >= text.length) eof();
      if (text[i] !== word[k]) bad(`in literal ${word} (expecting '${word[k]}')`);
    }
    i++;
  };
  const num = (): void => {
    if (text[i] === "-") {
      i++;
      if (i >= text.length) eof();
      if (!isDigit(text[i])) bad("in numeric literal");
    }
    if (text[i] === "0") i++;
    else while (isDigit(text[i])) i++;
    if (text[i] === ".") {
      i++;
      if (i >= text.length) eof();
      if (!isDigit(text[i])) bad("after decimal point in numeric literal");
      while (isDigit(text[i])) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (i >= text.length) eof();
      if (!isDigit(text[i])) bad("in exponent of numeric literal");
      while (isDigit(text[i])) i++;
    }
  };
  const value = (): void => {
    skip();
    if (i >= text.length) eof();
    const c = text[i] as string;
    if (c === "{") {
      i++;
      skip();
      if (i >= text.length) eof();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        skip();
        if (i >= text.length) eof();
        if (text[i] !== '"') bad("looking for beginning of object key string");
        str();
        skip();
        if (i >= text.length) eof();
        if (text[i] !== ":") bad("after object key");
        i++;
        value();
        skip();
        if (i >= text.length) eof();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        bad("after object key:value pair");
      }
    } else if (c === "[") {
      i++;
      skip();
      if (i >= text.length) eof();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        skip();
        if (i >= text.length) eof();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        bad("after array element");
      }
    } else if (c === '"') str();
    else if (c === "t") literal("true");
    else if (c === "f") literal("false");
    else if (c === "n") literal("null");
    else if (c === "-" || isDigit(c)) num();
    else bad("looking for beginning of value");
  };
  skip();
  if (i >= text.length) throw new GoJsonError("EOF");
  const start = i;
  value();
  return [start, i];
}

/** json.NewDecoder(r.Body).Decode(&v): the first value, trailing bytes ignored. */
export function decodeFirstValue(text: string): unknown {
  const [start, end] = scanFirstValue(text);
  return JSON.parse(text.slice(start, end));
}

export type JsonKind = "null" | "bool" | "number" | "string" | "array" | "object";

export function jsonKind(v: unknown): JsonKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "boolean":
      return "bool";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

/** A Go type a handler field decodes into; drives the UnmarshalTypeError text. */
export type FieldType =
  | "string"
  | "bool"
  | "int"
  | "int64"
  | "float64"
  | "any"
  | "object"
  | "strings"
  | "stringMap"
  | { array: FieldType; goName: string }
  | { custom: (v: unknown) => boolean; goName: string; errorText?: (v: unknown) => string };

function goTypeName(t: FieldType): string {
  if (typeof t === "string") {
    switch (t) {
      case "strings":
        return "[]string";
      case "stringMap":
        return "map[string]string";
      case "any":
        return "interface {}";
      case "object":
        return "map[string]interface {}";
      default:
        return t;
    }
  }
  return t.goName;
}

function accepts(t: FieldType, v: unknown): boolean {
  const k = jsonKind(v);
  if (typeof t !== "string") {
    if ("array" in t)
      return k === "array" && (v as unknown[]).every((e) => e === null || accepts(t.array, e));
    return t.custom(v);
  }
  switch (t) {
    case "string":
      return k === "string";
    case "bool":
      return k === "bool";
    case "int":
    case "int64":
      return k === "number" && Number.isInteger(v);
    case "float64":
      return k === "number";
    case "any":
      return true;
    case "object":
      return k === "object";
    case "strings":
      return k === "array" && (v as unknown[]).every((e) => e === null || typeof e === "string");
    case "stringMap":
      return (
        k === "object" &&
        Object.values(v as object).every((e) => e === null || typeof e === "string")
      );
  }
}

/**
 * Decodes `value` into a Go struct named `struct` with the given JSON fields (others ignored, null
 * leaves the zero value). A type mismatch throws Go's UnmarshalTypeError text for the first field
 * in document order. Returns the accepted fields only.
 */
export function decodeStruct(
  value: unknown,
  struct: string,
  fields: Record<string, FieldType>,
): Record<string, unknown> {
  const k = jsonKind(value);
  if (k !== "object") {
    if (k === "null") return {};
    throw new GoJsonError(`json: cannot unmarshal ${k} into Go value of type routes.${struct}`);
  }
  const out: Record<string, unknown> = {};
  let firstErr: string | undefined;
  const lower = new Map(Object.keys(fields).map((f) => [f.toLowerCase(), f]));
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // encoding/json matches field names case-insensitively, exact match first.
    const field = key in fields ? key : lower.get(key.toLowerCase());
    if (field === undefined) continue;
    if (v === null) continue;
    const t = fields[field] as FieldType;
    if (!accepts(t, v)) {
      if (firstErr === undefined) {
        const kind = jsonKind(v);
        const shown =
          kind === "number" && (t === "int" || t === "int64") ? `number ${String(v)}` : kind;
        firstErr =
          typeof t !== "string" && "custom" in t && t.errorText
            ? t.errorText(v)
            : `json: cannot unmarshal ${shown} into Go struct field ${struct}.${field} of type ${goTypeName(t)}`;
      }
      continue;
    }
    out[field] = v;
  }
  if (firstErr !== undefined) throw new GoJsonError(firstErr);
  return out;
}

/** json.NewEncoder(w).Encode(v): compact, HTML-escaped, trailing newline. */
export function goEncode(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "null\n";
  return `${text
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")}\n`;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A time.Time field: JSON string in RFC 3339, else Go's time parse error. */
export const timeField: FieldType = {
  goName: "time.Time",
  custom: (v) => typeof v === "string" && RFC3339.test(v),
  errorText: (v) =>
    typeof v === "string"
      ? `parsing time ""${v}"" as ""2006-01-02T15:04:05Z07:00"": cannot parse "${v}"" as "2006"`
      : `json: cannot unmarshal ${jsonKind(v)} into Go value of type time.Time`,
};
