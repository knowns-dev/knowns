// Go-compatible text helpers for the migration classifier.
import { compareStrings, goFields, goToLower, goTrimSpace } from "../../search/text.ts";

export { compareStrings, goFields, goToLower, goTrimSpace };

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{Nd}]+/u;

/** normalizeMigrationText: lower-cased letter/digit runs joined by single spaces. */
export function normalizeMigrationText(value: string): string {
  return goToLower(goTrimSpace(value))
    .split(NOT_LETTER_OR_DIGIT)
    .filter((w) => w !== "")
    .join(" ");
}

/** sort.Strings: bytewise order. */
export function sortStrings(values: string[]): string[] {
  return values.sort(compareStrings);
}

/** sortedUnique: trimmed, empties dropped, de-duplicated, bytewise sorted. */
export function sortedUnique(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const v = goTrimSpace(value);
    if (v !== "") seen.add(v);
  }
  return sortStrings([...seen]);
}

/** addedValues: the requested values (sorted, unique) that `existing` does not already hold. */
export function addedValues(
  existing: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): string[] {
  const seen = new Set((existing ?? []).map(goTrimSpace));
  return sortedUnique(requested).filter((v) => !seen.has(v));
}

export function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const v = goTrimSpace(value);
    if (v !== "") return v;
  }
  return "";
}
