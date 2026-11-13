// Go-compatible text helpers for decision review scoring.
import {
  byteLength,
  byteSlicePrefix,
  goFields,
  goToLower,
  goTrimSpace,
} from "../../search/text.ts";

export { byteLength, goFields, goToLower, goTrimSpace };

export function normalizedText(text: string): string {
  return goFields(goToLower(goTrimSpace(text))).join(" ");
}

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{Nd}]+/u;

/** tokenSet: lower-cased letter/digit runs of at least three bytes. */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of goToLower(text).split(NOT_LETTER_OR_DIGIT)) {
    if (token === "" || byteLength(token) < 3) continue;
    out.add(token);
  }
  return out;
}

const STOP_WORDS = [
  "and",
  "are",
  "but",
  "for",
  "from",
  "new",
  "old",
  "our",
  "the",
  "this",
  "that",
  "use",
  "uses",
  "using",
  "with",
];

export function significantTokenSet(text: string): Set<string> {
  const tokens = tokenSet(text);
  for (const stop of STOP_WORDS) tokens.delete(stop);
  return tokens;
}

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

/** truncate: byte length, "..." suffix counted inside maxLen. */
export function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0 || byteLength(text) <= maxLen) return text;
  if (maxLen <= 3) return byteSlicePrefix(text, maxLen);
  return `${byteSlicePrefix(text, maxLen - 3)}...`;
}

export function firstNonEmpty(...values: string[]): string {
  for (const value of values) if (goTrimSpace(value) !== "") return goTrimSpace(value);
  return "";
}

export function normalizeStringSlice(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const v = goTrimSpace(value);
    if (v !== "") out.push(v);
  }
  return out;
}

/** appendUnique: trimmed, de-duplicated, order preserved. */
export function appendUnique(
  existing: readonly string[] | undefined,
  ...values: string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...(existing ?? []), ...values]) {
    const value = goTrimSpace(raw);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
