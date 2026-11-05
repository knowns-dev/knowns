// Port of path/filepath.Match plus the engine's own ** matcher (matchGlob) and directory walk
// (globDir) from internal/codegen/template_engine.go.
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { goFsError } from "../../platform/goerror.ts";
import { compareStrings } from "./gofmt.ts";

export const ERR_BAD_PATTERN = "syntax error in pattern";

const WINDOWS = sep === "\\";

function firstRune(s: string): { r: number; n: number } {
  const cp = s.codePointAt(0) ?? 0;
  return { r: cp, n: cp > 0xffff ? 2 : 1 };
}

function scanChunk(pattern: string): { star: boolean; chunk: string; rest: string } {
  let star = false;
  let p = pattern;
  while (p.length > 0 && p[0] === "*") {
    p = p.slice(1);
    star = true;
  }
  let inrange = false;
  for (let i = 0; i < p.length; i++) {
    switch (p[i]) {
      case "\\":
        if (!WINDOWS && i + 1 < p.length) i++;
        break;
      case "[":
        inrange = true;
        break;
      case "]":
        inrange = false;
        break;
      case "*":
        if (!inrange) return { star, chunk: p.slice(0, i), rest: p.slice(i) };
    }
  }
  return { star, chunk: p, rest: "" };
}

function getEsc(chunk: string): { r: number; rest: string } {
  if (chunk.length === 0 || chunk[0] === "-" || chunk[0] === "]") throw new Error(ERR_BAD_PATTERN);
  let c = chunk;
  if (c[0] === "\\" && !WINDOWS) {
    c = c.slice(1);
    if (c.length === 0) throw new Error(ERR_BAD_PATTERN);
  }
  const { r, n } = firstRune(c);
  const rest = c.slice(n);
  if (rest.length === 0) throw new Error(ERR_BAD_PATTERN);
  return { r, rest };
}

function matchChunk(chunkIn: string, sIn: string): { rest: string; ok: boolean } {
  let chunk = chunkIn;
  let s = sIn;
  let failed = false;
  while (chunk.length > 0) {
    failed = failed || s.length === 0;
    const c = chunk[0];
    if (c === "[") {
      let r = 0;
      if (!failed) {
        const f = firstRune(s);
        r = f.r;
        s = s.slice(f.n);
      }
      chunk = chunk.slice(1);
      let negated = false;
      if (chunk.length > 0 && chunk[0] === "^") {
        negated = true;
        chunk = chunk.slice(1);
      }
      let match = false;
      let nrange = 0;
      for (;;) {
        if (chunk.length > 0 && chunk[0] === "]" && nrange > 0) {
          chunk = chunk.slice(1);
          break;
        }
        const lo = getEsc(chunk);
        chunk = lo.rest;
        let hi = lo.r;
        if (chunk[0] === "-") {
          const h = getEsc(chunk.slice(1));
          hi = h.r;
          chunk = h.rest;
        }
        match = match || (lo.r <= r && r <= hi);
        nrange++;
      }
      failed = failed || match === negated;
    } else if (c === "?") {
      if (!failed) {
        failed = s[0] === sep;
        s = s.slice(firstRune(s).n);
      }
      chunk = chunk.slice(1);
    } else {
      if (c === "\\" && !WINDOWS) {
        chunk = chunk.slice(1);
        if (chunk.length === 0) throw new Error(ERR_BAD_PATTERN);
      }
      if (!failed) {
        failed = chunk[0] !== s[0];
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
    }
  }
  if (failed) return { rest: "", ok: false };
  return { rest: s, ok: true };
}

/** filepath.Match. Throws Error(ERR_BAD_PATTERN) for a malformed pattern. */
export function filepathMatch(patternIn: string, nameIn: string): boolean {
  let pattern = patternIn;
  let name = nameIn;
  outer: while (pattern.length > 0) {
    const sc = scanChunk(pattern);
    pattern = sc.rest;
    const { star, chunk } = sc;
    if (star && chunk === "") return !name.includes(sep);
    let m: { rest: string; ok: boolean } | null = null;
    let err: Error | null = null;
    try {
      m = matchChunk(chunk, name);
    } catch (e) {
      err = e as Error;
    }
    if (m?.ok && (m.rest.length === 0 || pattern.length > 0)) {
      name = m.rest;
      continue;
    }
    if (err) throw err;
    if (star) {
      for (let i = 0; i < name.length && name[i] !== sep; i++) {
        const t = matchChunk(chunk, name.slice(i + 1));
        if (t.ok) {
          if (pattern.length === 0 && t.rest.length > 0) continue;
          name = t.rest;
          continue outer;
        }
      }
    }
    // the rest of the pattern must still be syntactically valid
    let rest = pattern;
    while (rest.length > 0) {
      const next = scanChunk(rest);
      rest = next.rest;
      matchChunk(next.chunk, "");
    }
    return false;
  }
  return name.length === 0;
}

function toSlash(p: string): string {
  return sep === "/" ? p : p.replaceAll(sep, "/");
}

function fromSlash(p: string): string {
  return sep === "/" ? p : p.replaceAll("/", sep);
}

/** matchGlob: a glob that may contain one "**". */
export function matchGlob(patternIn: string, nameIn: string): boolean {
  const pattern = toSlash(patternIn);
  let name = toSlash(nameIn);
  if (!pattern.includes("**")) return filepathMatch(fromSlash(pattern), fromSlash(name));
  const at = pattern.indexOf("**");
  const prefix = pattern.slice(0, at);
  let suffix = pattern.slice(at + 2);
  if (suffix.startsWith("/")) suffix = suffix.slice(1);
  if (prefix !== "") {
    if (!name.startsWith(prefix)) return false;
    name = name.slice(prefix.length);
  }
  if (suffix === "") return true;
  const segments = name.split("/");
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join("/");
    if (filepathMatch(fromSlash(suffix), fromSlash(candidate))) return true;
  }
  return false;
}

/** globDir: every file under root (lexical order, symlinks not followed) matching the pattern. */
export function globDir(root: string, pattern: string): string[] {
  const matches: string[] = [];
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root);
  } catch (e) {
    throw goFsError("lstat", root, e);
  }
  const visit = (path: string): void => {
    const rel = relative(root, path) || ".";
    if (matchGlob(pattern, rel)) matches.push(path);
  };
  if (!st.isDirectory()) {
    visit(root);
    return matches;
  }
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw goFsError("open", dir, e);
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else visit(p);
    }
  };
  walk(root);
  return matches;
}
