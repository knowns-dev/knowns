// Port of internal/storage/util.go: atomic writes, Go-compatible JSON, frontmatter and section
// helpers shared by every entity store.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcceptanceCriterion } from "../../models/task.ts";

// --- text helpers ------------------------------------------------------------------------------

export const UTF8_BOM = "﻿";

/** Strip a leading UTF-8 byte order mark (Windows PowerShell writes one). */
export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/** Go's unicode.IsSpace set (note: includes U+0085, excludes U+FEFF, unlike JS trim). */
const GO_SPACE =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, "g");

/** strings.TrimSpace. */
export function goTrimSpace(s: string): string {
  return s.replace(GO_TRIM, "");
}

// --- JSON --------------------------------------------------------------------------------------

/**
 * encoding/json.MarshalIndent(v, "", "  ") for values that came from JSON or plain objects: Go
 * escapes <, >, & and U+2028/U+2029 inside strings as \u00XX, which JSON.stringify does not.
 * Key order is insertion order (Go struct order); use writeCanonicalJson for sorted keys.
 */
export function goJsonStringify(value: unknown, indent: number | string | undefined = 2): string {
  const text = JSON.stringify(value, null, indent);
  if (text === undefined) return "null";
  return text
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** Recursively sort object keys (Go marshals map[string]any sorted by key). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object" && !isRawJson(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort(compareUtf8)) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function isRawJson(value: object): boolean {
  return Object.hasOwn(value, "rawJSON") && Object.getPrototypeOf(value) === null;
}

/** Compare strings by UTF-8 bytes, which is how Go sorts map keys. */
function compareUtf8(a: string, b: string): number {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Parse JSON the way Go's decodeGenericObject does (json.Number): numbers whose literal text does
 * not survive a JS round trip (1.0, 1e3, integers above 2^53) are kept verbatim as
 * JSON.rawJSON values, so a read-modify-write never reformats a number it did not touch.
 * Tolerates a leading BOM, which Go itself rejects (a deliberate superset, see FR-9).
 */
export function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(stripBom(text), (_key, value, context?: { source?: string }) => {
    if (typeof value === "number" && context?.source !== undefined) {
      if (JSON.stringify(value) !== context.source) return JSON.rawJSON(context.source);
    }
    return value;
  });
}

/** decodeGenericObject: a JSON object, or an error. */
export function decodeGenericObject(text: string): Record<string, unknown> {
  const value = parseJsonPreservingNumbers(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

/** readJSON: read and parse a JSON file (BOM tolerant). */
export function readJson(path: string): unknown {
  return parseJsonPreservingNumbers(readFileSync(path, "utf8"));
}

/** writeJSON: indented JSON plus a trailing newline, written atomically. */
export function writeJson(path: string, value: unknown): void {
  atomicWrite(path, `${goJsonStringify(value)}\n`);
}

/** writeCanonicalJSON: sorted keys, two-space indent, trailing newline (config writers). */
export function writeCanonicalJson(path: string, value: unknown): void {
  atomicWrite(path, `${goJsonStringify(sortKeysDeep(value))}\n`);
}

// --- files -------------------------------------------------------------------------------------

/**
 * atomicWrite: write to a temporary file in the destination directory, then rename over dst. The
 * temporary file and therefore the result are mode 0600, as with Go's os.CreateTemp. Creates the
 * parent directory (0755).
 */
export function atomicWrite(dst: string, data: string | Uint8Array): void {
  const dir = dirname(dst);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.tmp-knowns-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    renameSync(tmp, dst);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** formatISO: the TypeScript-compatible ISO string, `2006-01-02T15:04:05.000Z`, in UTC. */
export function formatIso(date: Date = new Date()): string {
  return date.toISOString();
}

// --- task file names ---------------------------------------------------------------------------

/**
 * sanitizeTitle (storage): the 50-character filename slug of the legacy
 * `task-{id} - {Title}.md` format. Letters and digits are kept, every other run becomes one hyphen.
 */
export function sanitizeFileSlug(title: string): string {
  let out = "";
  let prevHyphen = false;
  let count = 0;
  for (const ch of title) {
    if (count >= 50) break;
    if (/^[\p{L}\p{Nd}]$/u.test(ch)) {
      out += ch;
      prevHyphen = false;
      count++;
    } else if (!prevHyphen) {
      out += "-";
      prevHyphen = true;
      count++;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

/**
 * TaskFileMatches: whether `name` is the file for `id`, in any of the three forms the store has
 * written. The canonical form is checked first, so an ID that itself begins with "task-" can
 * never be mistaken for a legacy name.
 *
 *   <id>.md                  canonical
 *   task-<id>.md             legacy, untitled
 *   task-<id> - <slug>.md    legacy, titled
 */
export function taskFileMatches(name: string, id: string): boolean {
  if (name === `${id}.md`) return true;
  return name === `task-${id}.md` || name.startsWith(`task-${id} - `);
}

/** IDFromFilename: the task ID of any filename the store has written; "" if none. */
export function idFromFilename(filename: string): string {
  let name = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  if (name === "") return "";
  if (name.startsWith("task-")) name = name.slice("task-".length);
  const cut = name.indexOf(" - ");
  if (cut >= 0) name = name.slice(0, cut);
  return name;
}

// --- markdown sections -------------------------------------------------------------------------

/** extractBetween: trimmed text between two markers, with nested/duplicate markers stripped. */
export function extractBetween(content: string, begin: string, end: string): string {
  const start = content.indexOf(begin);
  if (start === -1) return "";
  const from = start + begin.length;
  const stop = content.indexOf(end, from);
  if (stop === -1) return "";
  let result = goTrimSpace(content.slice(from, stop));
  result = result.replaceAll(begin, "").replaceAll(end, "");
  return goTrimSpace(result);
}

/**
 * extractSection: content between `<!-- SECTION:TYPE:BEGIN -->` / `<!-- SECTION:TYPE:END -->`
 * (current format) or `<!-- BEGIN:type -->` / `<!-- END:type -->` (older format).
 */
export function extractSection(content: string, sectionType: string): string {
  const upper = sectionType.toUpperCase();
  const current = extractBetween(
    content,
    `<!-- SECTION:${upper}:BEGIN -->`,
    `<!-- SECTION:${upper}:END -->`,
  );
  if (current !== "") return current;
  const lower = sectionType.toLowerCase();
  return extractBetween(content, `<!-- BEGIN:${lower} -->`, `<!-- END:${lower} -->`);
}

const AC_LINE = /^-[ \t\n\f\r]+\[([ xX])\][ \t\n\f\r]+(?:#\d+[ \t\n\f\r]+)?(.+)$/gm;

/** extractAC: criteria from the `<!-- AC:BEGIN -->` block (`- [x] #2 text`). */
export function extractAC(content: string): AcceptanceCriterion[] {
  const block = extractBetween(content, "<!-- AC:BEGIN -->", "<!-- AC:END -->");
  if (block === "") return [];
  const result: AcceptanceCriterion[] = [];
  for (const m of block.matchAll(AC_LINE)) {
    result.push({ text: goTrimSpace(m[2] ?? ""), completed: m[1] === "x" || m[1] === "X" });
  }
  return result;
}

/** renderAC: the body of an AC block. */
export function renderAC(criteria: readonly AcceptanceCriterion[]): string {
  if (criteria.length === 0) return "";
  return criteria.map((ac, i) => `- [${ac.completed ? "x" : " "}] #${i + 1} ${ac.text}`).join("\n");
}

/** renderSection: wrap content in SECTION markers, stripping markers already present. */
export function renderSection(sectionType: string, content: string): string {
  const upper = sectionType.toUpperCase();
  const begin = `<!-- SECTION:${upper}:BEGIN -->`;
  const end = `<!-- SECTION:${upper}:END -->`;
  const body = goTrimSpace(content.replaceAll(begin, "").replaceAll(end, ""));
  return body === "" ? `${begin}\n${end}` : `${begin}\n${body}\n${end}`;
}

/**
 * splitFrontmatter: the YAML block and the body of a markdown document. A BOM is stripped. When
 * there is no complete frontmatter the YAML is "" and the body is the whole (BOM-stripped) content.
 */
export function splitFrontmatter(raw: string): { yaml: string; body: string } {
  const content = stripBom(raw);
  if (!content.startsWith("---")) return { yaml: "", body: content };
  let rest = content.slice(3);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);
  const idx = rest.indexOf("\n---");
  if (idx === -1) return { yaml: "", body: content };
  // With CRLF input idx points at the LF of "\r\n---"; exclude the CR.
  let yaml = rest.slice(0, idx);
  if (yaml.endsWith("\r")) yaml = yaml.slice(0, -1);
  let body = rest.slice(idx + 4);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { yaml, body };
}

// --- dot-notation keys -------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** setNestedKey: set `a.b.c` in a nested map, creating (or replacing non-object) levels. */
export function setNestedKey(m: Json, key: string, value: unknown): void {
  const dot = key.indexOf(".");
  if (dot < 0) {
    m[key] = value;
    return;
  }
  const head = key.slice(0, dot);
  const existing = m[head];
  const sub: Json =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Json)
      : {};
  setNestedKey(sub, key.slice(dot + 1), value);
  m[head] = sub;
}

/** getNestedKey: read `a.b.c`; `found` is false when any level is missing or not an object. */
export function getNestedKey(m: Json, key: string): { found: boolean; value?: unknown } {
  const dot = key.indexOf(".");
  const head = dot < 0 ? key : key.slice(0, dot);
  if (!Object.hasOwn(m, head)) return { found: false };
  const v = m[head];
  if (dot < 0) return { found: true, value: v };
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { found: false };
  return getNestedKey(v as Json, key.slice(dot + 1));
}
