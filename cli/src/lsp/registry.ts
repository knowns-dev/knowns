// Port of internal/lsp/registry.go.
import { type BigIntStats, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, extname } from "node:path";
import { ErrExtensionAlreadyRegistered, WrappedError } from "./errors.ts";
import type { Binary, Language, PathMatcher, PathMatcherKind } from "./types.ts";
import { DartLanguageID } from "./types.ts";

export function builtinLanguages(): Language[] {
  const tsServer = (): Binary[] => [
    { name: "typescript-language-server", args: ["--stdio"], checkArgs: ["--version"] },
  ];
  return [
    {
      id: "go",
      name: "Go",
      extensions: [".go"],
      binaries: [{ name: "gopls", args: ["serve"], checkArgs: ["version"] }],
    },
    { id: "typescript", name: "TypeScript", extensions: [".ts"], binaries: tsServer() },
    { id: "typescriptreact", name: "TSX", extensions: [".tsx"], binaries: tsServer() },
    { id: "javascript", name: "JavaScript", extensions: [".js"], binaries: tsServer() },
    { id: "javascriptreact", name: "JSX", extensions: [".jsx"], binaries: tsServer() },
    {
      id: "python",
      name: "Python",
      extensions: [".py"],
      binaries: [
        { name: "pylsp", checkArgs: ["--version"] },
        { name: "pyright-langserver", args: ["--stdio"], checkArgs: ["--version"] },
      ],
    },
    {
      id: "rust",
      name: "Rust",
      extensions: [".rs"],
      binaries: [{ name: "rust-analyzer", checkArgs: ["--version"] }],
    },
    {
      id: DartLanguageID,
      name: "Dart",
      extensions: [".dart"],
      binaries: [{ name: "dart", args: ["language-server"], checkArgs: ["--version"] }],
    },
  ];
}

interface RegisteredMatcher {
  language: Language;
  matcher: Required<PathMatcher>;
}

function normalizedPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function pathBase(p: string): string {
  const n = normalizedPath(p).replace(/\/+$/, "");
  const idx = n.lastIndexOf("/");
  return idx >= 0 ? n.slice(idx + 1) : n;
}

function hasPathSegment(p: string, segment: string): boolean {
  return normalizedPath(p)
    .split("/")
    .some((part) => part.toLowerCase() === segment.toLowerCase());
}

export function readFirstLine(path: string): string {
  // bigint: Windows file ids are 64-bit and a Number rounds them, so distinct files could match.
  let info: BigIntStats;
  try {
    info = lstatSync(path, { bigint: true });
  } catch {
    return "";
  }
  if (!info.isFile() || info.size === 0n) return "";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) return "";
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    let line = buf.subarray(0, n).toString("utf8");
    const idx = line.search(/[\r\n]/);
    if (idx >= 0) line = line.slice(0, idx);
    return line;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export function shebangInterpreter(lineIn: string): string {
  const line = lineIn.trim();
  if (!line.startsWith("#!")) return "";
  const fields = line
    .slice(2)
    .trim()
    .split(/\s+/)
    .filter((f) => f !== "");
  const first = fields[0];
  if (first === undefined) return "";
  const interpreter = basename(first).toLowerCase();
  if (interpreter !== "env") return interpreter;
  for (const field of fields.slice(1)) {
    if (field.startsWith("-") || field.includes("=")) continue;
    return basename(field).toLowerCase();
  }
  return "";
}

function normalizeRegistryExtensions(extensions: string[] | undefined): string[] {
  if (!extensions || extensions.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of extensions) {
    const ext = raw.trim().toLowerCase();
    if (ext === "" || seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

function normalizePathMatchers(
  extensions: string[],
  matchers: PathMatcher[] | undefined,
): Required<PathMatcher>[] {
  const all: PathMatcher[] = extensions.map((e) => ({ kind: "suffix" as const, pattern: e }));
  all.push(...(matchers ?? []));
  const seen = new Set<string>();
  const out: Required<PathMatcher>[] = [];
  for (const m of all) {
    let pattern = m.pattern.trim().toLowerCase();
    if (pattern === "") continue;
    if (m.kind === "suffix") {
      if (!pattern.startsWith(".")) pattern = `.${pattern}`;
    } else if (m.kind !== "exact_name" && m.kind !== "shebang") {
      continue;
    }
    const priority = m.priority ?? 0;
    const explicitOnly = m.explicitOnly ?? false;
    const key = `${m.kind}\u0000${pattern}\u0000${priority}\u0000${explicitOnly}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m.kind, pattern, priority, explicitOnly });
  }
  return out;
}

function kindRank(kind: PathMatcherKind): number {
  switch (kind) {
    case "exact_name":
      return 0;
    case "suffix":
      return 1;
    case "shebang":
      return 2;
    default:
      return 3;
  }
}

/** Go compares strings bytewise; for BMP-only patterns UTF-16 code unit order matches except astral; fine for ASCII ids. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Registry {
  private langs: Language[] = [];
  private byID = new Map<string, Language>();
  private byExt = new Map<string, Language>();
  private matchers: RegisteredMatcher[] = [];
  /** Normalized matchers per language id (Language.matchers holds the normalized set after register). */

  constructor(languages?: Language[]) {
    const list = languages ?? builtinLanguages();
    for (const lang of list) {
      try {
        this.register(lang);
      } catch {
        // Go: _ = r.Register(lang)
      }
    }
  }

  static empty(): Registry {
    return new Registry([]);
  }

  register(langIn: Language): void {
    const extensions = normalizeRegistryExtensions(langIn.extensions);
    const matchers = normalizePathMatchers(extensions, langIn.matchers);
    const lang: Language = {
      ...langIn,
      id: langIn.id.trim(),
      name: langIn.name.trim(),
      extensions,
      matchers,
    };
    if (lang.id === "" || matchers.length === 0) return;
    for (const ext of extensions) {
      const owner = this.byExt.get(ext);
      if (owner && owner.id !== lang.id) {
        throw new WrappedError(
          `${ErrExtensionAlreadyRegistered.message}: ${ext} is owned by ${owner.id}`,
          ErrExtensionAlreadyRegistered,
        );
      }
    }
    for (const [ext, owner] of [...this.byExt]) {
      if (owner.id === lang.id) this.byExt.delete(ext);
    }
    if (this.byID.has(lang.id)) {
      const i = this.langs.findIndex((l) => l.id === lang.id);
      if (i >= 0) this.langs[i] = lang;
    } else {
      this.langs.push(lang);
    }
    this.byID.set(lang.id, lang);
    for (const ext of extensions) this.byExt.set(ext, lang);
    this.rebuildMatchers();
  }

  languages(): Language[] {
    return [...this.langs];
  }

  language(id: string): Language | undefined {
    return this.byID.get(id);
  }

  forPath(path: string): Language | undefined {
    return this.matchPath(path, false);
  }

  forDetection(path: string): Language | undefined {
    return this.matchPath(path, true);
  }

  hasExtension(path: string): boolean {
    return this.forPath(path) !== undefined;
  }

  private matchPath(path: string, detection: boolean): Language | undefined {
    if (hasPathSegment(path, ".knowns")) return undefined;
    let firstLine = "";
    let loaded = false;
    for (const candidate of this.matchers) {
      const m = candidate.matcher;
      let matched = false;
      switch (m.kind) {
        case "suffix":
          matched = normalizedPath(path).toLowerCase().endsWith(m.pattern);
          break;
        case "exact_name":
          matched = pathBase(path).toLowerCase() === m.pattern;
          break;
        case "shebang":
          if (extname(basename(path)) !== "") break;
          if (!loaded) {
            firstLine = readFirstLine(path);
            loaded = true;
          }
          matched = shebangInterpreter(firstLine) === m.pattern;
          break;
      }
      if (!matched) continue;
      if (detection && m.explicitOnly) return undefined;
      return candidate.language;
    }
    return undefined;
  }

  private rebuildMatchers(): void {
    const all: RegisteredMatcher[] = [];
    for (const lang of this.langs) {
      for (const matcher of (lang.matchers ?? []) as Required<PathMatcher>[]) {
        all.push({ language: lang, matcher });
      }
    }
    all.sort((l, r) => {
      if (l.matcher.priority !== r.matcher.priority) return r.matcher.priority - l.matcher.priority;
      if (l.matcher.pattern.length !== r.matcher.pattern.length)
        return r.matcher.pattern.length - l.matcher.pattern.length;
      if (l.matcher.kind !== r.matcher.kind)
        return kindRank(l.matcher.kind) - kindRank(r.matcher.kind);
      if (l.matcher.pattern !== r.matcher.pattern)
        return cmpStr(l.matcher.pattern, r.matcher.pattern);
      return cmpStr(l.language.id, r.language.id);
    });
    this.matchers = all;
  }
}
