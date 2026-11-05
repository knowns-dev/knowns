// A small emitter for the YAML the Hermes writer produces, in the shape gopkg.in/yaml.v3 gives a
// map[string]any: sorted keys, four-space indent, sequences indented under their key. Parsing uses
// Bun.YAML. Comments in an existing file are dropped (as with yaml.v3 round trips), and unusual
// scalars (multi-line strings, timestamps) are emitted conservatively rather than reproduced.

const RESERVED = /^(?:~|null|true|false|yes|no|on|off|y|n)$/i;
const NUMBER =
  /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) return true;
  }
  return false;
}

function plainSafe(s: string): boolean {
  if (s === "" || s !== s.trim()) return false;
  if (RESERVED.test(s) || NUMBER.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/^-[^\s-]/.test(s) && !/^[-?:][^\s]/.test(s))
    return false;
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/: |:$| #/.test(s) || s.includes("\n") || hasControl(s)) return false;
  return true;
}

function scalarString(s: string): string {
  if (plainSafe(s)) return s;
  if (RESERVED.test(s) || NUMBER.test(s) || s === "") return JSON.stringify(s);
  if (s.includes("\n") || hasControl(s)) return JSON.stringify(s);
  return `'${s.replaceAll("'", "''")}'`;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return scalarString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function isMapValue(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function emit(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (isMapValue(value)) {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const lines: string[] = [];
    for (const k of keys) {
      const v = value[k];
      const key = scalarString(k);
      if (isMapValue(v) && Object.keys(v).length > 0) {
        lines.push(`${pad}${key}:`, ...emit(v, indent + 4));
      } else if (Array.isArray(v) && v.length > 0) {
        lines.push(`${pad}${key}:`, ...emit(v, indent + 4));
      } else if (isMapValue(v)) {
        lines.push(`${pad}${key}: {}`);
      } else if (Array.isArray(v)) {
        lines.push(`${pad}${key}: []`);
      } else {
        lines.push(`${pad}${key}: ${scalar(v)}`);
      }
    }
    return lines;
  }
  if (Array.isArray(value)) {
    const lines: string[] = [];
    for (const item of value) {
      if (isMapValue(item) && Object.keys(item).length > 0) {
        const inner = emit(item, indent + 2);
        lines.push(`${pad}- ${(inner[0] as string).slice(indent + 2)}`, ...inner.slice(1));
      } else if (Array.isArray(item) && item.length > 0) {
        const inner = emit(item, indent + 2);
        lines.push(`${pad}- ${(inner[0] as string).slice(indent + 2)}`, ...inner.slice(1));
      } else if (isMapValue(item)) {
        lines.push(`${pad}- {}`);
      } else if (Array.isArray(item)) {
        lines.push(`${pad}- []`);
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return lines;
  }
  return [`${pad}${scalar(value)}`];
}

/** yaml.Marshal of a map[string]any. */
export function marshalYaml(value: Record<string, unknown>): string {
  if (Object.keys(value).length === 0) return "{}\n";
  return `${emit(value, 0).join("\n")}\n`;
}

/** yaml.Unmarshal into a map[string]any; an empty document is an empty map. */
export function unmarshalYaml(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const v: unknown = Bun.YAML.parse(text);
  if (v === null || v === undefined) return {};
  if (!isMapValue(v)) {
    throw new Error("yaml: unmarshal errors:\n  cannot unmarshal into map[string]interface {}");
  }
  return v;
}
