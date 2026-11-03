// Shared primitives for the Go-compatible models.
//
// The Go models marshal time.Time as RFC 3339 (nanosecond precision, `Z` or a numeric offset) and
// the frontmatter writers use millisecond ISO strings. Both are plain strings on the wire, so the
// TypeScript models keep them as strings and validate the shape; nothing is converted to Date, which
// would lose Go's sub-millisecond digits and rewrite offsets on the next save.
import { z } from "zod";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A Go time.Time as serialized by encoding/json, or an ISO-8601 frontmatter timestamp. */
export const timestampSchema = z.string().regex(RFC3339, "expected an RFC 3339 timestamp");

/** Go's zero time.Time, which `omitempty` does not omit and yaml `omitempty` does. */
export const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/** Go `[]string` that may be omitted. */
export const stringList = z.array(z.string());

/**
 * A Go slice or map WITHOUT `omitempty`. A nil slice marshals to JSON `null` (the Go CLI prints
 * `"labels": null`), an empty one to `[]`; both are valid on the wire.
 */
export const nilableArray = <T extends z.ZodType>(item: T) => z.array(item).nullable();
export const nilableRecord = <T extends z.ZodType>(value: T) =>
  z.record(z.string(), value).nullable();

/** JSON `map[string]any`. */
export const anyRecord = z.record(z.string(), z.unknown());

/** Go `int` fields: JSON numbers that must be integers. */
export const int = z.number().int();

export function isGoZeroTime(value: string | undefined): boolean {
  return value === undefined || value === "" || value === GO_ZERO_TIME;
}
