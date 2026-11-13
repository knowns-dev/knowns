// Text helpers for the task and time renderers: lipgloss.Width and friends, and the slices of Go's
// fmt and time formatting whose exact text appears in task output.

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

/** fmt's %-Ns for plain strings: pads by rune count, not display width. */
export function padRunes(s: string, n: number): string {
  const count = [...s].length;
  return count >= n ? s : s + " ".repeat(n - count);
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

/** fmt %v of a float64 (strconv 'g', shortest: exponent form below 1e-4 and from 1e6 up, Go's eprec of 6). */
export function fmtFloatV(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "+Inf";
  if (n === Number.NEGATIVE_INFINITY) return "-Inf";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const neg = n < 0;
  const [mant, expText] = Math.abs(n).toExponential().split("e") as [string, string];
  const exp = Number(expText);
  const digits = mant.replace(".", "");
  let body: string;
  if (exp < -4 || exp >= 6) {
    body = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  } else if (exp >= 0) {
    body =
      digits.length <= exp + 1
        ? digits + "0".repeat(exp + 1 - digits.length)
        : `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else {
    body = `0.${"0".repeat(-exp - 1)}${digits}`;
  }
  return neg ? `-${body}` : body;
}

/** fmt %v of a JSON-decoded value (what a history change holds after it was read from disk). */
export function fmtV(value: unknown): string {
  if (value === null || value === undefined) return "<nil>";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return fmtFloatV(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) return `[${value.map(fmtV).join(" ")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `map[${keys.map((k) => `${k}:${fmtV(obj[k])}`).join(" ")}]`;
    }
    default:
      return String(value);
  }
}

const TS_PARTS = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** time.Time.Format(time.RFC3339) of a timestamp string. */
export function formatRFC3339(ts: string): string {
  const m = TS_PARTS.exec(ts);
  if (!m) return ts;
  const zone = m[3] === "+00:00" || m[3] === "-00:00" ? "Z" : m[3];
  return `${m[1]}T${m[2]}${zone}`;
}

/** Format("2006-01-02") in the timestamp's own zone. */
export function formatDate(ts: string): string {
  return TS_PARTS.exec(ts)?.[1] ?? ts.slice(0, 10);
}

/** Format("2006-01-02 15:04:05"). */
export function formatDateTime(ts: string): string {
  const m = TS_PARTS.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}

/** Format("2006-01-02 15:04"). */
export function formatDateMinute(ts: string): string {
  const m = TS_PARTS.exec(ts);
  return m ? `${m[1]} ${m[2]?.slice(0, 5)}` : ts;
}

/** Format("2006-01-02T15:04:05Z"): the literal Z is part of the layout, not a zone. */
export function formatISOLiteralZ(ts: string): string {
  const m = TS_PARTS.exec(ts);
  return m ? `${m[1]}T${m[2]}Z` : ts;
}
