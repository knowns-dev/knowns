// Port of internal/codegen/helpers.go: the case-conversion helpers registered with the template
// engine. Go maps case rune by rune (simple case mapping), so these do the same instead of using
// whole-string toUpperCase/toLowerCase (which apply context rules and multi-character mappings).
import { isDigit, isLower, isUnicodeSpace, isUpper } from "./goquote.ts";

function simpleUpper(ch: string): string {
  const u = ch.toUpperCase();
  return [...u].length === 1 ? u : ch;
}

function simpleLower(ch: string): string {
  if (ch === "İ") return "i";
  const l = ch.toLowerCase();
  return [...l].length === 1 ? l : ch;
}

/** strings.ToUpper. */
export function goToUpper(s: string): string {
  let out = "";
  for (const ch of s) out += simpleUpper(ch);
  return out;
}

/** strings.ToLower. */
export function goToLower(s: string): string {
  let out = "";
  for (const ch of s) out += simpleLower(ch);
  return out;
}

/** strings.TrimSpace. */
export function goTrimSpace(s: string): string {
  const chars = [...s];
  let a = 0;
  let b = chars.length;
  while (a < b && isUnicodeSpace(chars[a] as string)) a++;
  while (b > a && isUnicodeSpace(chars[b - 1] as string)) b--;
  return chars.slice(a, b).join("");
}

/** strings.Fields. */
export function fields(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (isUnicodeSpace(ch)) {
      if (cur !== "") out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** wordSplit: camelCase, PascalCase, snake_case, kebab-case and space-delimited input. */
function wordSplit(input: string): string[] {
  const s = input.replaceAll("_", " ").replaceAll("-", " ");
  const runes = [...s];
  let expanded = "";
  runes.forEach((r, i) => {
    if (i > 0 && isUpper(r)) {
      const prev = runes[i - 1] as string;
      if (isLower(prev) || isDigit(prev)) {
        expanded += " ";
      } else if (i + 1 < runes.length && isLower(runes[i + 1] as string) && isUpper(prev)) {
        expanded += " ";
      }
    }
    expanded += r;
  });
  return fields(expanded);
}

function capitalize(w: string): string {
  const [first = "", ...rest] = [...w];
  return simpleUpper(first) + goToLower(rest.join(""));
}

export function camelCase(s: string): string {
  const words = wordSplit(s);
  if (words.length === 0) return "";
  return words.map((w, i) => (i === 0 ? goToLower(w) : capitalize(w))).join("");
}

export function pascalCase(s: string): string {
  return wordSplit(s).map(capitalize).join("");
}

export function kebabCase(s: string): string {
  return wordSplit(s).map(goToLower).join("-");
}

export function snakeCase(s: string): string {
  return wordSplit(s).map(goToLower).join("_");
}

export function startCase(s: string): string {
  return wordSplit(s).map(capitalize).join(" ");
}

export function upperCase(s: string): string {
  return goToUpper(s);
}

export function lowerCase(s: string): string {
  return goToLower(s);
}
