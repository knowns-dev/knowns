// Time helpers for the lifecycle library. Task and history timestamps are strings in Go's
// time.Time JSON form; the clock is injectable so tests (and Go-parity checks) can pin it.
import { goNow, goTime } from "../../storage/history/go-json.ts";

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** A Date as the RFC 3339 UTC string Go marshals (trailing fractional zeros trimmed). */
export function wireTime(date: Date): string {
  return goNow(date);
}

/** Normalizes any RFC 3339 string to Go's marshalled form. */
export function wireTimeOf(ts: string): string {
  return goTime(ts);
}

/** Epoch milliseconds of a timestamp string (NaN when unparseable). */
export function epochMs(ts: string): number {
  return Date.parse(ts);
}

/** time.Time.UnixNano for a Date whose precision is milliseconds. */
export function unixNano(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}

/** time.Time.Equal on two timestamp strings. */
export function sameInstant(a: string, b: string): boolean {
  return epochMs(a) === epochMs(b);
}

/** Both absent, or both present and the same instant (timePointersEqual). */
export function sameOptionalInstant(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return sameInstant(a, b);
}
