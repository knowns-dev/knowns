// Go-compatible string helpers. Go's strings/unicode functions and TypeScript's differ in small
// but ranking-visible ways (whitespace sets, byte versus UTF-16 lengths, byte-order comparison),
// so everything search needs lives here and is used instead of the JS built-ins.

// unicode.IsSpace: \t \n \v \f \r, space, U+0085, U+00A0 and the Z category (not U+FEFF).
const GO_SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function isGoSpace(code: number): boolean {
  return GO_SPACE.has(code) || (code >= 0x2000 && code <= 0x200a);
}

/** strings.TrimSpace. */
export function goTrimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** strings.Fields. */
export function goFields(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (isGoSpace(s.charCodeAt(i))) {
      if (start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) out.push(s.slice(start));
  return out;
}

/** strings.ToLower: one-to-one simple case mapping per rune (JS lowercases U+0130 to two runes). */
export function goToLower(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s.toLowerCase();
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    if (lower === ch) out += ch;
    else if (ch === "\u0130") out += "i";
    else out += [...lower].length === 1 ? lower : ch;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** len(s) in Go: UTF-8 bytes. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * s[:n] in Go, then encoded the way encoding/json writes it: a multi-byte sequence cut in half
 * becomes one U+FFFD per orphaned byte.
 */
export function byteSlicePrefix(s: string, n: number): string {
  const bytes = encoder.encode(s);
  if (n >= bytes.length) return s;
  let end = n;
  // A cut inside a multi-byte sequence leaves its lead byte plus some continuation bytes.
  let lead = end - 1;
  let trailing = 0;
  while (lead >= 0 && lead >= end - 4 && ((bytes[lead] ?? 0) & 0xc0) === 0x80) {
    lead--;
    trailing++;
  }
  let orphaned = 0;
  if (lead >= 0 && lead >= end - 4) {
    const b = bytes[lead] ?? 0;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > 1 && trailing + 1 < need) {
      orphaned = trailing + 1;
      end = lead;
    }
  }
  return decoder.decode(bytes.subarray(0, end)) + "\ufffd".repeat(orphaned);
}

/** truncateStr in engine.go: byte lengths, "..." suffix. */
export function truncateStr(s: string, maxLen: number): string {
  if (byteLength(s) <= maxLen) return s;
  if (maxLen <= 3) return byteSlicePrefix(s, maxLen);
  return `${byteSlicePrefix(s, maxLen - 3)}...`;
}

/** Go compares strings bytewise; for UTF-8 that is code point order, not UTF-16 order. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    const sa = ca >= 0xd800 && ca <= 0xdfff;
    const sb = cb >= 0xd800 && cb <= 0xdfff;
    if (sa !== sb) return sa ? 1 : -1; // a surrogate pair encodes a code point above U+FFFF
    return ca < cb ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/** Stable sort with a Go-style `less` function (sort.SliceStable). */
export function stableSort<T>(items: T[], less: (a: T, b: T) => boolean): T[] {
  const indexed = items.map((item, index) => ({ item, index }));
  indexed.sort((x, y) => {
    if (less(x.item, y.item)) return -1;
    if (less(y.item, x.item)) return 1;
    return x.index - y.index;
  });
  for (let i = 0; i < items.length; i++) items[i] = (indexed[i] as { item: T }).item;
  return items;
}

export function containsStr(slice: readonly string[] | undefined, item: string): boolean {
  return (slice ?? []).includes(item);
}

export function firstNonEmpty(...values: string[]): string {
  for (const v of values) if (goTrimSpace(v) !== "") return v;
  return "";
}
