// Port of internal/references/references.go: the inline semantic reference grammar
// (`@doc/path#heading:10-20{relation}`, `@task/id`, legacy `@task-id`, ...). Pure functions, no I/O.
import {
  type DocReferenceFragment,
  SEMANTIC_REFERENCE_RELATION_REFERENCES,
  type SemanticReference,
} from "../../models/reference.ts";
import { goTrimSpace } from "../../storage/core/util.ts";

const TASK_REFERENCE_RE = /^@task-[A-Za-z0-9.-]+(?:\{[a-z-]+\})?/;
const MEMORY_REFERENCE_RE = /^@memory-[A-Za-z0-9-]+(?:\{[a-z-]+\})?/;
const DOC_RANGE_SUFFIX_RE = /:(\d+)-(\d+)$/;
const DOC_LINE_SUFFIX_RE = /:(\d+)$/;

// Go iterates this map, so the order is irrelevant to the result: the prefixes are disjoint.
const SLASH_NAMESPACES: ReadonlyArray<readonly [string, string]> = [
  ["task/", "task"],
  ["memory/", "memory"],
  ["decision/", "decision"],
  ["doc/", "doc"],
  ["template/", "template"],
];

const ALLOWED_RELATIONS: ReadonlySet<string> = new Set([
  "implements",
  "depends",
  "blocked-by",
  "follows",
  "related",
  "parent",
  "spec",
  "imported-from",
  "template-for",
  SEMANTIC_REFERENCE_RELATION_REFERENCES,
]);

/** AllRelationKinds: the full allowlist of relation kinds. */
export function allRelationKinds(): string[] {
  return [...ALLOWED_RELATIONS];
}

export function allowedRelation(relation: string): boolean {
  return ALLOWED_RELATIONS.has(relation);
}

/**
 * Extract: every valid reference in `content`, in order, skipping fenced code blocks (a line that
 * starts with three backticks toggles the fence).
 */
export function extract(content: string): SemanticReference[] {
  const refs: SemanticReference[] = [];
  let inCodeBlock = false;
  let i = 0;
  while (i < content.length) {
    if (isLineStart(content, i) && content.startsWith("```", i)) {
      inCodeBlock = !inCodeBlock;
      i += 3;
      continue;
    }
    if (inCodeBlock) {
      i++;
      continue;
    }
    if (content[i] !== "@") {
      i++;
      continue;
    }
    const match = extractReferenceAt(content.slice(i));
    if (match === "") {
      i++;
      continue;
    }
    const ref = parse(match);
    if (ref) refs.push(ref);
    i += match.length;
  }
  return refs;
}

/** Parse: one reference token. Returns undefined where Go returns ok == false. */
export function parse(rawInput: string): SemanticReference | undefined {
  const raw = goTrimSpace(trimTrailingPunctuation(rawInput));
  if (raw === "" || !raw.startsWith("@")) return undefined;

  let body = raw.slice(1);
  let relation: string = SEMANTIC_REFERENCE_RELATION_REFERENCES;
  let explicitRelation = false;
  let validRelation = true;

  const open = body.lastIndexOf("{");
  if (open >= 0 && body.endsWith("}")) {
    relation = body.slice(open + 1, body.length - 1);
    body = body.slice(0, open);
    explicitRelation = true;
    validRelation = allowedRelation(relation);
  }

  let type = "";
  let target = "";
  let legacy = false;
  let fragment: DocReferenceFragment | undefined;

  if (body.startsWith("task-")) {
    type = "task";
    target = body.slice("task-".length);
    legacy = true;
  } else if (body.startsWith("memory-")) {
    type = "memory";
    target = body.slice("memory-".length);
    legacy = true;
  } else if (body.startsWith("doc/")) {
    type = "doc";
    [target, fragment] = parseDocTarget(body.slice("doc/".length));
  } else {
    for (const [prefix, typ] of SLASH_NAMESPACES) {
      if (!body.startsWith(prefix)) continue;
      type = typ;
      const rest = body.slice(prefix.length);
      if (typ === "doc") {
        [target, fragment] = parseDocTarget(rest);
      } else {
        target = trimTrailingPunctuation(goTrimSpace(rest));
      }
      break;
    }
    if (type === "") return undefined;
  }

  if (goTrimSpace(target) === "") return undefined;

  // Key order is Go's struct order (raw, canonical, type, target, relation, explicitRelation,
  // validRelation, legacy, fragment), so JSON output matches.
  let canonical = `@${type}/${target}`;
  if (fragment) canonical += fragment.raw ?? "";
  if (explicitRelation) canonical += `{${relation}}`;
  const ordered: Record<string, unknown> = { raw, canonical, type, target, relation };
  if (explicitRelation) ordered.explicitRelation = true;
  ordered.validRelation = validRelation;
  if (legacy) ordered.legacy = true;
  if (fragment) ordered.fragment = fragment;
  return ordered as SemanticReference;
}

function parseDocTarget(input: string): [string, DocReferenceFragment | undefined] {
  let value = goTrimSpace(input);
  let fragment: DocReferenceFragment = {};

  const hash = value.indexOf("#");
  if (hash >= 0) {
    fragment.raw = value.slice(hash);
    const heading = value.slice(hash + 1);
    if (heading !== "") fragment.heading = heading;
    value = value.slice(0, hash);
  } else {
    const range = DOC_RANGE_SUFFIX_RE.exec(value);
    if (range) {
      fragment.raw = range[0];
      const start = goAtoi(range[1] ?? "");
      const end = goAtoi(range[2] ?? "");
      if (start !== 0) fragment.rangeStart = start;
      if (end !== 0) fragment.rangeEnd = end;
      value = value.slice(0, value.length - range[0].length);
    } else {
      const line = DOC_LINE_SUFFIX_RE.exec(value);
      if (line) {
        fragment.raw = line[0];
        const n = goAtoi(line[1] ?? "");
        if (n !== 0) fragment.line = n;
        value = value.slice(0, value.length - line[0].length);
      }
    }
  }

  value = trimTrailingPunctuation(value);
  if ((fragment.raw ?? "") === "") fragment = {};
  return [value, fragment.raw === undefined ? undefined : orderFragment(fragment)];
}

/** Go's field order: raw, line, rangeStart, rangeEnd, heading. */
function orderFragment(f: DocReferenceFragment): DocReferenceFragment {
  const out: DocReferenceFragment = {};
  if (f.raw !== undefined) out.raw = f.raw;
  if (f.line !== undefined) out.line = f.line;
  if (f.rangeStart !== undefined) out.rangeStart = f.rangeStart;
  if (f.rangeEnd !== undefined) out.rangeEnd = f.rangeEnd;
  if (f.heading !== undefined) out.heading = f.heading;
  return out;
}

/** strconv.Atoi on a digit string; Go returns 0 with an error on overflow, which the caller drops. */
function goAtoi(digits: string): number {
  // Out of int64 range Go returns the maximum int (with an error the caller discards). JS numbers
  // cannot hold 9223372036854775807 exactly; it serialises as 9223372036854776000.
  return BigInt(digits) > 9223372036854775807n ? Number(9223372036854775807n) : Number(digits);
}

function extractReferenceAt(content: string): string {
  if (content.startsWith("@doc/")) return extractDocReferenceAt(content);
  if (content.startsWith("@task/")) return extractNamespacedReferenceAt(content, "@task/".length);
  if (content.startsWith("@memory/"))
    return extractNamespacedReferenceAt(content, "@memory/".length);
  if (content.startsWith("@decision/"))
    return extractNamespacedReferenceAt(content, "@decision/".length);
  if (content.startsWith("@template/"))
    return extractNamespacedReferenceAt(content, "@template/".length);
  if (content.startsWith("@task-")) return TASK_REFERENCE_RE.exec(content)?.[0] ?? "";
  if (content.startsWith("@memory-")) return MEMORY_REFERENCE_RE.exec(content)?.[0] ?? "";
  return "";
}

function extractDocReferenceAt(content: string): string {
  let i = "@doc/".length;
  if (i >= content.length || !isDocPathChar(content.charAt(i))) return "";

  while (i < content.length) {
    const r = content.charAt(i);
    if (isDocPathChar(r)) {
      i++;
    } else if (r === "#") {
      const next = consumeDocHeading(content, i);
      if (next === i) return content.slice(0, i);
      i = next;
    } else if (r === ":") {
      const next = consumeDocLineSuffix(content, i);
      if (next === i) return content.slice(0, i);
      i = next;
    } else if (r === "{") {
      const next = consumeRelationSuffix(content, i);
      if (next === i) return content.slice(0, i);
      return content.slice(0, next);
    } else {
      return content.slice(0, i);
    }
  }
  return content.slice(0, i);
}

function extractNamespacedReferenceAt(content: string, start: number): string {
  let i = start;
  if (i >= content.length || !isNamespacedTargetChar(content.charAt(i))) return "";

  while (i < content.length) {
    const r = content.charAt(i);
    if (isNamespacedTargetChar(r)) {
      i++;
    } else if (r === "{") {
      const next = consumeRelationSuffix(content, i);
      if (next === i) return content.slice(0, i);
      return content.slice(0, next);
    } else {
      return content.slice(0, i);
    }
  }
  return content.slice(0, i);
}

function consumeDocHeading(content: string, start: number): number {
  let i = start + 1;
  while (i < content.length && isDocHeadingChar(content.charAt(i))) i++;
  return i === start + 1 ? start : i;
}

function consumeDocLineSuffix(content: string, start: number): number {
  let i = start + 1;
  let rangeSeparatorSeen = false;
  let digitsBefore = 0;
  let digitsAfter = 0;

  while (i < content.length) {
    const r = content.charAt(i);
    if (r >= "0" && r <= "9") {
      if (rangeSeparatorSeen) digitsAfter++;
      else digitsBefore++;
      i++;
    } else if (r === "-" && !rangeSeparatorSeen && digitsBefore > 0) {
      rangeSeparatorSeen = true;
      i++;
    } else {
      break;
    }
  }

  if (digitsBefore === 0 || (rangeSeparatorSeen && digitsAfter === 0)) return start;
  return i;
}

function consumeRelationSuffix(content: string, start: number): number {
  let i = start + 1;
  while (i < content.length) {
    const r = content.charAt(i);
    if ((r >= "a" && r <= "z") || r === "-") {
      i++;
      continue;
    }
    break;
  }
  if (i === start + 1 || i >= content.length || content.charAt(i) !== "}") return start;
  return i + 1;
}

function isAsciiAlnum(r: string): boolean {
  return (r >= "A" && r <= "Z") || (r >= "a" && r <= "z") || (r >= "0" && r <= "9");
}

function isDocPathChar(r: string): boolean {
  return isAsciiAlnum(r) || r === "/" || r === "_" || r === "-" || r === ".";
}

function isDocHeadingChar(r: string): boolean {
  return isAsciiAlnum(r) || r === "_" || r === "-" || r === ".";
}

function isNamespacedTargetChar(r: string): boolean {
  return isAsciiAlnum(r) || r === "/" || r === "_" || r === "-" || r === ".";
}

function isLineStart(content: string, i: number): boolean {
  return i === 0 || content.charAt(i - 1) === "\n";
}

const TRAILING_PUNCT = ".,;:!?`'\"";
// Go's unicode.IsSpace set.
const GO_SPACE_RE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value.charAt(end - 1);
    if (GO_SPACE_RE.test(ch) || TRAILING_PUNCT.includes(ch)) end--;
    else break;
  }
  return value.slice(0, end);
}
