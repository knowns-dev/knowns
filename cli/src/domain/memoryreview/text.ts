// Go-compatible text helpers for the review scoring (strings.Fields, unicode.IsLetter, len()).
import {
  byteLength,
  byteSlicePrefix,
  goFields,
  goToLower,
  goTrimSpace,
} from "../../search/text.ts";

export { byteLength, goFields, goToLower, goTrimSpace };

/** normalizedText: lower-cased, whitespace collapsed to single spaces. */
export function normalizedText(text: string): string {
  return goFields(goToLower(goTrimSpace(text))).join(" ");
}

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{Nd}]+/u;

/** tokenSet: lower-cased letter/digit runs of at least three bytes (Go's len() is bytes). */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of goToLower(text).split(NOT_LETTER_OR_DIGIT)) {
    if (token === "" || byteLength(token) < 3) continue;
    out.add(token);
  }
  return out;
}

/** Jaccard similarity of two token sets. */
export function tokenSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  const union = left.size + right.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/** truncate: byte length, trimmed, "..." suffix (the memory reviewer's variant). */
export function truncateTrimmed(text: string, maxLen: number): string {
  if (maxLen <= 0 || byteLength(text) <= maxLen) return text;
  return `${goTrimSpace(byteSlicePrefix(text, maxLen))}...`;
}

/** firstNonEmpty: the first value with content, trimmed. */
export function firstNonEmpty(...values: string[]): string {
  for (const value of values) if (goTrimSpace(value) !== "") return goTrimSpace(value);
  return "";
}

/** appendUnique: existing then new values, empties and duplicates dropped. */
export function appendUnique(
  existing: readonly string[] | undefined,
  ...values: string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...(existing ?? []), ...values]) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
