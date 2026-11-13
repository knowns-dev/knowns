// Pure helpers shared by the doc commands (internal/cli/doc.go "helpers" and runtime.go display
// helpers). No I/O; reusable by the MCP/server layers.
import { goTrimSpace } from "../../storage/core/util.ts";
import { goQuote } from "../core/gofmt.ts";

// --- text ----------------------------------------------------------------------------------------

/** utf8.RuneCountInString. */
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function approximateDocTokens(content: string): number {
  const len = runeCount(content);
  if (len === 0) return 0;
  return Math.ceil(len / 3.5);
}

/** formatWithCommas: 1234567 -> "1,234,567". */
export function formatWithCommas(n: number): string {
  const s = String(Math.abs(n));
  const sign = n < 0 ? "-" : "";
  if (s.length <= 3) return `${sign}${s}`;
  let rem = s.length % 3;
  if (rem === 0) rem = 3;
  let out = s.slice(0, rem);
  for (let i = rem; i < s.length; i += 3) out += `,${s.slice(i, i + 3)}`;
  return sign + out;
}

export function pluralDocs(n: number): string {
  return n === 1 ? "doc" : "docs";
}

export function containsTag(tags: readonly string[] | undefined, tag: string): boolean {
  return (tags ?? []).includes(tag);
}

/** slugifyTitle: ASCII letters and digits, runs of anything else become one hyphen. */
export function slugifyTitle(title: string): string {
  const lower = title.toLowerCase();
  let out = "";
  let prevHyphen = false;
  for (const ch of lower) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      prevHyphen = false;
    } else if (!prevHyphen) {
      out += "-";
      prevHyphen = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

// --- terminal width ------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are the point
const ANSI_RE = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const ZERO_WIDTH_RE = /^[\p{M}\p{Cf}\p{Cc}]$/u;

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** lipgloss.Width: visible terminal columns, ignoring ANSI escapes. */
export function stringWidth(s: string): number {
  let width = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    if (ZERO_WIDTH_RE.test(ch)) continue;
    width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/** padRight: pads with spaces to n visible columns. */
export function padRight(s: string, n: number): string {
  const w = stringWidth(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

/** truncateVisible: trims to `max` visible columns, ending in an ellipsis. */
export function truncateVisible(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  let out = "";
  let visible = 0;
  let inEsc = false;
  for (const ch of s) {
    if (ch === "\x1b") {
      inEsc = true;
      out += ch;
      continue;
    }
    if (inEsc) {
      out += ch;
      if (ch === "m") inEsc = false;
      continue;
    }
    if (visible >= max - 1) {
      out += "…";
      break;
    }
    out += ch;
    visible++;
  }
  return `${out}\x1b[0m`;
}

// --- time and fmt --------------------------------------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Formats an RFC 3339 timestamp the way Go's time.Format does for the layout, in the timestamp's
 * own zone. "date" = 2006-01-02, "datetime" = 2006-01-02 15:04:05, "rfc3339" = time.RFC3339.
 * A string that is not RFC 3339 is returned unchanged.
 */
export function formatGoTime(ts: string, layout: "date" | "datetime" | "rfc3339"): string {
  const m = TS_RE.exec(ts);
  if (!m) return ts;
  const [, y, mo, d, h, mi, s, zone] = m;
  const date = `${y}-${mo}-${d}`;
  if (layout === "date") return date;
  const clock = `${h}:${mi}:${s}`;
  if (layout === "datetime") return `${date} ${clock}`;
  const z = zone === "+00:00" || zone === "-00:00" ? "Z" : zone;
  return `${date}T${clock}${z}`;
}

/** fmt's %v for the JSON-shaped values history carries (string, float64, bool, nil, slice, map). */
export function formatGoValue(v: unknown): string {
  if (v === null || v === undefined) return "<nil>";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return formatGoFloat(v);
  if (Array.isArray(v)) return `[${v.map(formatGoValue).join(" ")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `map[${keys.map((k) => `${k}:${formatGoValue(o[k])}`).join(" ")}]`;
  }
  return String(v);
}

/** %v of a float64: shortest repr, exponent form below 1e-4 and from 1e21. */
function formatGoFloat(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const abs = Math.abs(n);
  if (abs < 1e-4 || abs >= 1e21) {
    const [mant = "", exp = "0"] = n.toExponential().split("e");
    const e = Number(exp);
    const sign = e < 0 ? "-" : "+";
    return `${mant}e${sign}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return String(n);
}

// --- markdown sections ---------------------------------------------------------------------------

export interface Heading {
  level: number;
  text: string;
}

function headingLevel(line: string): number {
  let level = 0;
  for (const ch of line) {
    if (ch === "#") level++;
    else break;
  }
  return level;
}

/** extractHeadings: every non-empty `#` heading line. */
export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("#")) continue;
    const level = headingLevel(line);
    const text = goTrimSpace(line.slice(level));
    if (text !== "") headings.push({ level, text });
  }
  return headings;
}

function sectionMatches(count: number, text: string, ref: string): boolean {
  return (
    String(count) === ref ||
    text.toLowerCase() === ref.toLowerCase() ||
    text.toLowerCase().includes(ref.toLowerCase())
  );
}

/** Finds the section `ref` (1-based heading number or title text) and its end line. */
function findSection(
  lines: readonly string[],
  ref: string,
): { start: number; end: number; level: number } | undefined {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("#")) continue;
    count++;
    const level = headingLevel(line);
    const text = goTrimSpace(line.slice(level));
    if (!sectionMatches(count, text, ref)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.startsWith("#") && headingLevel(next) <= level) {
        end = j;
        break;
      }
    }
    return { start: i, end, level };
  }
  return undefined;
}

/** extractDocSection: the section's text, trimmed; "" when not found. */
export function extractDocSection(content: string, sectionRef: string): string {
  const lines = content.split("\n");
  const s = findSection(lines, sectionRef);
  if (!s) return "";
  return goTrimSpace(lines.slice(s.start, s.end).join("\n"));
}

/** replaceDocSection: swaps a section's body (heading kept); content unchanged when not found. */
export function replaceDocSection(content: string, sectionRef: string, newContent: string): string {
  const lines = content.split("\n");
  const s = findSection(lines, sectionRef);
  if (!s) return content;
  const before = lines.slice(0, s.start + 1).join("\n");
  const after = lines.slice(s.end).join("\n");
  let result = `${before}\n\n${newContent}`;
  if (after !== "") result += `\n\n${after}`;
  return result;
}

/** extractDocLines: "42" or "10-20". Throws Go's error messages. */
export function extractDocLines(
  content: string,
  lineParam: string,
): { content: string; label: string } {
  const all = content.split("\n");
  const total = all.length;

  const dash = lineParam.indexOf("-");
  if (dash >= 0) {
    const start = goAtoi(lineParam.slice(0, dash));
    const end = goAtoi(lineParam.slice(dash + 1));
    if (start !== undefined && end !== undefined && start >= 1 && end >= start) {
      if (start > total) throw new Error(`line ${start} exceeds document length (${total} lines)`);
      const e = Math.min(end, total);
      return { content: all.slice(start - 1, e).join("\n"), label: `${start}-${e}` };
    }
  }

  const line = goAtoi(lineParam);
  if (line === undefined) {
    throw new Error(`invalid line parameter: ${goQuote(lineParam)} (use '42' or '10-20')`);
  }
  if (line < 1 || line > total) {
    throw new Error(`line ${line} out of range (document has ${total} lines)`);
  }
  return { content: all[line - 1] ?? "", label: String(line) };
}

/** strconv.Atoi: optional sign and decimal digits only; undefined on a syntax error. */
function goAtoi(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  return Number(s);
}

// --- multi-line styling --------------------------------------------------------------------------

interface Renders {
  render(text: string): string;
}

/**
 * lipgloss Render for text that may contain newlines: every line, including empty ones, is wrapped
 * in the style and then padded with unstyled spaces to the widest line. core's Style.render wraps
 * lines but does not pad, which only shows when a styled string holds a newline (for example a YAML
 * block scalar with its trailing newline). A style that is switched off (plain, --json, NO_COLOR)
 * returns the text untouched, as lipgloss does for a style without properties.
 */
export function renderBlock(style: Renders, text: string): string {
  if (!text.includes("\n")) return style.render(text);
  const probe = style.render("x");
  const at = probe.indexOf("x");
  if (probe === "x" || at < 0) return text;
  const open = probe.slice(0, at);
  const close = probe.slice(at + 1);
  const lines = text.split("\n");
  const width = Math.max(...lines.map(stringWidth));
  return lines
    .map((line) => `${open}${line}${close}${" ".repeat(width - stringWidth(line))}`)
    .join("\n");
}
