// Helpers for `knowns time`: Go's time.Parse("2006-01-02", ...) with its exact error text, and
// encoding/csv's writer rules.
import { goQuote } from "../core/gofmt.ts";

export interface ParsedDate {
  /** Epoch milliseconds of 00:00:00 UTC on the date. */
  ms: number;
  /** time.Time.IsZero: January 1 of year 1. */
  isZero: boolean;
}

const isDigit = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
};

function daysIn(month: number, year: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** time.Parse("2006-01-02", value): the parsed date, or Go's error message. */
export function parseGoDate(
  value: string,
): { ok: true; date: ParsedDate } | { ok: false; error: string } {
  const layout = "2006-01-02";
  const bad = (valueElem: string, layoutElem: string) => ({
    ok: false as const,
    error: `parsing time ${goQuote(value)} as ${goQuote(layout)}: cannot parse ${goQuote(valueElem)} as ${goQuote(layoutElem)}`,
  });
  const range = (what: string) => ({
    ok: false as const,
    error: `parsing time ${goQuote(value)}: ${what} out of range`,
  });
  let rest = value;

  // 2006
  if (rest.length < 4 || !isDigit(rest, 0)) return bad(rest, "2006");
  const yearText = rest.slice(0, 4);
  if (!/^\d{4}$/.test(yearText)) return bad(rest, "2006");
  const year = Number.parseInt(yearText, 10);
  rest = rest.slice(4);

  const literal = (): ReturnType<typeof bad> | undefined => {
    if (!rest.startsWith("-")) return bad(rest, "-");
    rest = rest.slice(1);
    return undefined;
  };
  const twoDigits = (layoutElem: string): number | ReturnType<typeof bad> => {
    if (!isDigit(rest, 0) || !isDigit(rest, 1)) return bad(rest, layoutElem);
    const n = (rest.charCodeAt(0) - 48) * 10 + (rest.charCodeAt(1) - 48);
    rest = rest.slice(2);
    return n;
  };

  let err = literal();
  if (err) return err;
  const month = twoDigits("01");
  if (typeof month !== "number") return month;
  if (month <= 0 || month > 12) return range("month");
  err = literal();
  if (err) return err;
  const day = twoDigits("02");
  if (typeof day !== "number") return day;
  if (rest.length !== 0) {
    return {
      ok: false,
      error: `parsing time ${goQuote(value)}: extra text: ${goQuote(rest)}`,
    };
  }
  if (day < 1 || day > daysIn(month, year)) return range("day");
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  return { ok: true, date: { ms: d.getTime(), isZero: year === 1 && month === 1 && day === 1 } };
}

/** encoding/csv fieldNeedsQuotes. */
function fieldNeedsQuotes(field: string): boolean {
  if (field === "") return false;
  if (field === "\\.") return true;
  if (/[,"\r\n]/.test(field)) return true;
  return /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(field);
}

/** csv.Writer.Write for one record, with "\n" line endings. */
export function csvRecord(fields: string[]): string {
  return `${fields
    .map((f) => (fieldNeedsQuotes(f) ? `"${f.replaceAll('"', '""')}"` : f))
    .join(",")}\n`;
}
