// Go time.Time formatting for timestamps the models keep as strings.
//
// Go parses a stored timestamp and marshals it again as RFC 3339 with the shortest fractional
// part, keeping the original offset ("Z" for a zero offset). The models keep the file's text, so
// "...35.500Z" must come out as "...35.5Z" in search output.
import { GO_ZERO_TIME } from "../models/common.ts";

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** json.Marshal of a time.Time that was parsed from `value`. Unparseable input is returned as is. */
export function goTimeString(value: string): string {
  const m = RFC3339.exec(value);
  if (!m) return value;
  const frac = (m[7] ?? "").replace(/0+$/, "");
  let zone = m[8] ?? "Z";
  if (zone === "+00:00" || zone === "-00:00") zone = "Z";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac ? `.${frac}` : ""}${zone}`;
}

/** time.Time.IsZero for a stored timestamp. */
export function isZeroTime(value: string | undefined): boolean {
  return value === undefined || value === "" || value === GO_ZERO_TIME;
}

/** timePtr in engine.go: nil for the zero time, else the marshaled form. */
export function timePtr(value: string | undefined): string | undefined {
  if (value === undefined || isZeroTime(value)) return undefined;
  return goTimeString(value);
}

/** cloneTimePointer: the marshaled form of an optional timestamp. */
export function cloneTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return goTimeString(value);
}

/** t.UTC().Format(time.RFC3339Nano). */
export function formatRFC3339NanoUTC(value: string): string {
  const m = RFC3339.exec(value);
  if (!m) return value;
  const [, y, mo, d, h, mi, s, fracRaw, zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone !== "Z") {
    const sign = zone?.startsWith("-") ? -1 : 1;
    const oh = Number(zone?.slice(1, 3));
    const om = Number(zone?.slice(4, 6));
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  const date = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const frac = (fracRaw ?? "").replace(/0+$/, "");
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${frac ? `.${frac}` : ""}Z`;
}

/** Milliseconds since the epoch for a stored timestamp (NaN when unparseable). */
export function timeMillis(value: string): number {
  return Date.parse(value);
}
