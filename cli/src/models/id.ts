// Port of internal/models/id.go: task ID generation and task-file naming helpers.
//
// Default IDs are six lowercase base-36 characters ("abc123"). Prefixed IDs are `PREFIX-XXXXXX`,
// where the suffix is six characters of uppercase Crockford Base32 ("KN-4F7Q2M").

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Crockford Base32 omits I, L, O and U. */
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 36^6, the exclusive upper bound of a six-character base-36 value. */
export const BASE36_MAX = 36 ** 6;
/** 32^6, the exclusive upper bound of a six-character Crockford Base32 value. */
export const CROCKFORD_BASE32_MAX = 32 ** 6;

/** 2-8 alphanumeric characters beginning with a letter. */
const TASK_ID_PREFIX = /^[A-Z][A-Z0-9]{1,7}$/;

/** Used when a project name yields nothing that can be a prefix. */
export const FALLBACK_TASK_ID_PREFIX = "TSK";

/** Uniform random integer in [0, max) from the platform CSPRNG (rejection sampling, max <= 2^32). */
export function randomBelow(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new RangeError("invalid max");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] as number;
    if (v < limit) return v % max;
  }
}

/** encodeBase: encode n in `alphabet`, left-padded with its first character to `width`. */
export function encodeBase(n: number, width: number, alphabet: string): string {
  const first = alphabet.charAt(0);
  if (n === 0) return first.repeat(width);
  const base = alphabet.length;
  let out = "";
  let rest = n;
  while (rest > 0) {
    out = alphabet.charAt(rest % base) + out;
    rest = Math.floor(rest / base);
  }
  return out.length < width ? first.repeat(width - out.length) + out : out;
}

/** NewTaskID: random six-character base-36 ID. */
export function newTaskId(): string {
  return encodeBase(randomBelow(BASE36_MAX), 6, BASE36);
}

/** NormalizeTaskIDPrefix: trim and uppercase; "" is allowed (no prefix); throws on an illegal prefix. */
export function normalizeTaskIdPrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase();
  if (normalized === "") return "";
  if (!TASK_ID_PREFIX.test(normalized)) {
    throw new Error("task ID prefix must be 2-8 alphanumeric characters and start with a letter");
  }
  return normalized;
}

const isLetterOrDigit = (ch: string) => /^[\p{L}\p{Nd}]$/u.test(ch);

/**
 * firstN: up to n characters from the front of s, uppercased, stopping at the first character
 * that cannot appear in a prefix. It stops rather than skips ("Uber" with umlaut contributes nothing).
 */
function firstN(s: string, n: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length === n) break;
    if ((ch.codePointAt(0) ?? 0) >= 0x80 || !isLetterOrDigit(ch)) break;
    out += ch.toUpperCase();
  }
  return out;
}

/**
 * DeriveTaskIDPrefix: a prefix from a project name. One word gives its first two letters, several
 * words give their initials (max four). Never returns an illegal prefix.
 */
export function deriveTaskIdPrefix(projectName: string): string {
  const words = projectName.split(/[^\p{L}\p{Nd}]+/u).filter((w) => w !== "");
  let candidate = "";
  if (words.length === 1) {
    candidate = firstN(words[0] as string, 2);
  } else if (words.length > 1) {
    let initials = "";
    for (const word of words) {
      if (initials.length === 4) break;
      initials += firstN(word, 1);
    }
    candidate = initials;
  }
  try {
    const normalized = normalizeTaskIdPrefix(candidate);
    if (normalized !== "") return normalized;
  } catch {
    // fall through to the fallback
  }
  return FALLBACK_TASK_ID_PREFIX;
}

/** NewPrefixedTaskID: `PREFIX-XXXXXX` with an uppercase Crockford Base32 suffix. */
export function newPrefixedTaskId(prefix: string): string {
  const normalized = normalizeTaskIdPrefix(prefix);
  if (normalized === "") throw new Error("task ID prefix is required");
  return `${normalized}-${encodeBase(randomBelow(CROCKFORD_BASE32_MAX), 6, CROCKFORD_BASE32)}`;
}

/** Matches IDs produced by newTaskId. */
export const DEFAULT_TASK_ID_PATTERN = /^[0-9a-z]{6}$/;
/** Matches IDs produced by newPrefixedTaskId. */
export const PREFIXED_TASK_ID_PATTERN = /^[A-Z][A-Z0-9]{1,7}-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * SanitizeTitle: strip characters that are unsafe in file names, collapse ASCII whitespace runs to
 * a single hyphen. Go's `\s` is ASCII-only, so it is spelled out here.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9 \t\n\f\r-]/g, "").replace(/[ \t\n\f\r]+/g, "-");
}

/**
 * TaskFileName: the canonical task file name is the ID and nothing else. Older forms
 * (`task-<id>.md`, `task-<id> - <slug>.md`) are still read; see taskFileMatches in storage/core/util.
 */
export function taskFileName(id: string): string {
  return `${id}.md`;
}
