// Helpers shared by the entity stores: the hand-rolled YAML scalar rules of the Go stores, Go time
// parsing/formatting, and lenient frontmatter coercion (yaml.v3 decodes scalars into typed structs
// loosely: an integer into a string field becomes its text, null becomes the zero value).
import { readdirSync, statSync } from "node:fs";
import { GO_ZERO_TIME } from "../../models/common.ts";

// --- Go time ----------------------------------------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedTime {
  /** Instant in unix milliseconds (sub-millisecond digits truncated, as Go's formatISO does). */
  ms: number;
  /** Fractional-second digits as written (no trailing zero trimming). */
  frac: string;
}

/** parseISO: the layouts Go tries (RFC 3339 with or without fractional seconds). */
export function parseIso(s: string): ParsedTime | undefined {
  const m = TS_RE.exec(s);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se, frac = "", zone] = m as unknown as string[];
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(se);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const utc = Date.UTC(Number(y), month - 1, day, hour, minute, second);
  if (new Date(utc).getUTCDate() !== day) return undefined; // 30 February and friends
  let offsetMin = 0;
  if (zone !== "Z") {
    const sign = zone?.startsWith("-") ? -1 : 1;
    offsetMin = sign * (Number(zone?.slice(1, 3)) * 60 + Number(zone?.slice(4, 6)));
  }
  const ms = utc - offsetMin * 60_000 + Number(`0.${frac || "0"}`.slice(0, 5)) * 1000;
  return { ms: Math.floor(ms + 1e-6), frac };
}

/** time.Time.Format("2006-01-02T15:04:05.000Z") in UTC. */
export function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** formatISO of a stored timestamp string: zero or unparseable values become "now". */
export function formatIso(value: string | undefined, now: () => number = Date.now): string {
  if (value === undefined || value === "" || value === GO_ZERO_TIME) return isoMs(now());
  const parsed = parseIso(value);
  return parsed ? isoMs(parsed.ms) : isoMs(now());
}

/** json.Marshal of a time.Time: RFC 3339 in UTC with trailing fractional zeros trimmed. */
export function goTimeJson(value: string | undefined): string {
  if (value === undefined || value === "") return GO_ZERO_TIME;
  const parsed = parseIso(value);
  if (!parsed) return GO_ZERO_TIME;
  const d = new Date(parsed.ms);
  // Keep sub-millisecond digits when the source had them in UTC; otherwise milliseconds only.
  const base = d.toISOString().slice(0, 19);
  let frac = d.toISOString().slice(20, 23);
  if (parsed.frac.length > 3) frac = parsed.frac.padEnd(9, "0").slice(0, 9);
  frac = frac.replace(/0+$/, "");
  return `${base}${frac === "" ? "" : `.${frac}`}Z`;
}

/** A timestamp parsed from frontmatter: normalised, or Go's zero time when unparseable/empty. */
export function readTime(s: string): string {
  return s === "" ? GO_ZERO_TIME : goTimeJson(s);
}

/** parseOptionalISO: undefined when empty; an error when set but unparseable. */
export function readOptionalTime(s: string, label: string): string | undefined {
  if (s === "") return undefined;
  if (!parseIso(s)) throw new Error(`parse ${label}: cannot parse time "${s}"`);
  return goTimeJson(s);
}

export function isZeroTime(value: string | undefined): boolean {
  return value === undefined || value === "" || value === GO_ZERO_TIME;
}

// --- YAML scalar rules (taskStore.yamlScalar and friends) -------------------------------------

/** isNumericString: ASCII digits only. */
export function isNumericString(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

const QUOTE_TRIGGERS = ":#{}[]&*!|>'\"%@`";

export function needsYamlQuoting(s: string): boolean {
  if (s === "") return true;
  if (s === "true" || s === "false" || s === "null" || s === "~") return true;
  if (isNumericString(s)) return true;
  for (const ch of s) if (QUOTE_TRIGGERS.includes(ch)) return true;
  if (s.startsWith(" ") || s.endsWith(" ")) return true;
  if (s.startsWith("-") || s.startsWith("?")) return true;
  return false;
}

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** strconv.Quote. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\x07") out += "\\a";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\v") out += "\\v";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x80 || PRINTABLE.test(ch)) out += ch;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}

/** yamlScalar: a YAML-safe scalar for a string. Brackets use double quotes, others single. */
export function yamlScalar(s: string): string {
  if (needsYamlQuoting(s)) {
    if (s.includes("[") || s.includes("]")) return goQuote(s);
    return `'${s.replaceAll("'", "''")}'`;
  }
  return s;
}

/** writeYAMLStringList: `key: []` or a block list of yamlScalar values. */
export function yamlStringList(key: string, values: readonly string[] | undefined | null): string {
  if (!values || values.length === 0) return `${key}: []\n`;
  return `${key}:\n${values.map((v) => `  - ${yamlScalar(v)}\n`).join("")}`;
}

// --- lenient coercion of parsed YAML ----------------------------------------------------------

export type Yaml = Record<string, unknown>;

/** yaml.v3 into a string field: scalars become their text, null/missing become "". */
export function asStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  throw new Error("cannot decode YAML value into a string");
}

export function asStrList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("cannot decode YAML value into a string list");
  return v.map(asStr);
}

export function asInt(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v)) return Number(v);
  throw new Error("cannot decode YAML value into an int");
}

/** Parse a YAML mapping (an empty or non-mapping document is an empty mapping). */
export function parseYamlMap(text: string): Yaml {
  const v = Bun.YAML.parse(text) as unknown;
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error("cannot decode YAML document into a mapping");
  }
  return v as Yaml;
}

// --- misc -------------------------------------------------------------------------------------

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** normalizeStringSlice: nil/empty becomes undefined. */
export function nonEmpty(list: string[]): string[] | undefined {
  return list.length === 0 ? undefined : list;
}

export function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** os.ReadDir: entries sorted by name; a missing directory is an empty list. */
export function readDirSorted(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (e) {
    if (isNotFound(e) || (e as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw e;
  }
}
