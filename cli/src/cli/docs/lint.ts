/**
 * Docs lint (tools/gendocs/lint.go and paths.go, ported): hand-written docs and user-facing source
 * strings must only show commands and flags the command tree has, and must only name source files
 * that exist.
 *
 * Hand-written docs drift from the binary in a way generated pages cannot: they show commands and
 * flags a reader is meant to type. Only fenced code is linted in markdown, because prose
 * deliberately names commands that do not exist ("There is no `knowns model` command"), and
 * treating that as drift would train people to ignore the check.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { Command } from "../core/command.ts";

export const DOC_ROOTS = [
  "README.md",
  "README.vi.md",
  "ARCHITECTURE.md",
  "PHILOSOPHY.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "OPENCODE.md",
  "docs",
  "internal/instructions",
];

/**
 * Source files tell users what to run too: doctor remediations, error hints, and a UI alert saying
 * "Run 'knowns init' in your terminal". Every line counts there; there is no fence to be inside of.
 */
export const SRC_ROOTS = ["internal", "cmd", "ui/src"];

export const ALLOW_FILE = "docs/allowed-missing-paths.txt";

const invocationRE = /\bknowns\s+((?:[a-z][a-z0-9_-]*\s*)+)/g;
const flagTokenRE = /--([a-z][a-z0-9-]*)/g;
const fenceRE = /^\s*```/;

export interface DocFinding {
  file: string;
  line: string;
  detail: string;
}

export interface PathFinding {
  file: string;
  line: string;
  token: string;
}

/** filepath.Walk over `root` (relative to `repo`), yielding repo-relative slash paths of files. */
function walkFiles(repo: string, root: string, onFile: (rel: string) => void): void {
  const abs = join(repo, root);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return;
  }
  if (!st.isDirectory()) {
    onFile(root);
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(abs).sort();
  } catch {
    return;
  }
  for (const name of entries) walkFiles(repo, `${root}/${name}`, onFile);
}

function readText(repo: string, rel: string): string | undefined {
  try {
    return readFileSync(join(repo, rel), "utf8");
  } catch {
    return undefined;
  }
}

export function isSourceFile(path: string): boolean {
  const ext = extname(path);
  return (ext === ".go" || ext === ".ts" || ext === ".tsx") && !path.includes("/cli-reference/");
}

/**
 * Every fenced `knowns ...` invocation in the doc roots, and every invocation in the source roots,
 * whose flags the command does not accept.
 */
export function lintDocs(root: Command, repo: string): { findings: DocFinding[]; checked: number } {
  const findings: DocFinding[] = [];
  let checked = 0;

  const scan = (roots: string[], want: (p: string) => boolean, fenced: boolean): void => {
    for (const r of roots) {
      walkFiles(repo, r, (path) => {
        if (!want(path) || path.includes("node_modules")) return;
        const body = readText(repo, path);
        if (body === undefined) return;
        let inFence = !fenced;
        body.split("\n").forEach((line, n) => {
          if (fenced && fenceRE.test(line)) {
            inFence = !inFence;
            return;
          }
          if (!inFence) return;
          for (const detail of lintLine(root, line)) {
            checked++;
            if (detail !== "") findings.push({ file: path, line: String(n + 1), detail });
          }
        });
      });
    }
  };

  scan(DOC_ROOTS, (p) => p.endsWith(".md") && !p.includes("cli-reference"), true);
  scan(SRC_ROOTS, isSourceFile, false);
  return { findings, checked };
}

/**
 * Assigns each flag to the invocation that precedes it, the way a shell does. A line often
 * mentions two commands, and attributing every flag to the first one reports drift that is not
 * there. One entry per invocation: "" when it is fine or does not resolve to a command.
 */
export function lintLine(root: Command, line: string): string[] {
  const matches = [...line.matchAll(invocationRE)];
  if (matches.length === 0) return [];
  const out: string[] = [];
  matches.forEach((m, i) => {
    const words = (m[1] ?? "").split(/\s+/).filter((w) => w !== "");
    const resolved = resolvePath(root, words);
    if (!resolved) {
      out.push("");
      return;
    }
    const [cmd, path] = resolved;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? line.length) : line.length;

    // cobra registers the help flag lazily, so `knowns task --help` must not lint as an error.
    cmd.initDefaultHelpFlag();

    let problem = "";
    for (const f of line.slice(start, end).matchAll(flagTokenRE)) {
      const name = f[1] ?? "";
      if (!cmd.flags().lookup(name) && !cmd.inheritedFlags().lookup(name)) {
        problem = `knowns ${path.join(" ")} does not accept --${name}`;
      }
    }
    out.push(problem);
  });
  return out;
}

/** Consumes as many subcommand words as resolve, stopping at the first that is not one. */
export function resolvePath(root: Command, words: string[]): [Command, string[]] | undefined {
  let cur = root;
  const path: string[] = [];
  for (const w of words) {
    const next = cur.commands().find((c) => c.name() === w);
    if (!next) break;
    cur = next;
    path.push(w);
  }
  return path.length === 0 ? undefined : [cur, path];
}

// --- file references ---------------------------------------------------------------------------

// Source extensions only, and backticked. Config and markdown names in docs are overwhelmingly
// artifacts Knowns writes into a user's project, which cannot be resolved here. A .go or .ts name
// can only mean a file in this repository. Directory-tree blocks name files without backticks.
const pathTokenRE = /`([A-Za-z0-9_./-]+\.(?:go|ts|tsx|js|jsx))`/g;
const fencedPathRE = /\b([A-Za-z0-9_./-]+\.(?:go|ts|tsx|js|jsx))\b/g;
const placeholderRE = /[<>*$]|\.\.\./;

/** Backticked (or fenced) source file references in the doc roots that resolve to nothing. */
export function lintPaths(repo: string): {
  findings: PathFinding[];
  checked: number;
  allowFile: string;
} {
  const allow = loadAllowList(repo);
  const index = buildBasenameIndex(repo);
  const findings: PathFinding[] = [];
  let checked = 0;

  for (const r of DOC_ROOTS) {
    walkFiles(repo, r, (path) => {
      if (!path.endsWith(".md") || path.includes("cli-reference")) return;
      const body = readText(repo, path);
      if (body === undefined) return;
      let inFence = false;
      body.split("\n").forEach((line, n) => {
        if (fenceRE.test(line)) {
          inFence = !inFence;
          return;
        }
        for (const m of line.matchAll(inFence ? fencedPathRE : pathTokenRE)) {
          const token = m[1] ?? "";
          if (placeholderRE.test(token) || allow.has(token)) continue;
          checked++;
          if (!pathExists(repo, token, index)) {
            findings.push({ file: path, line: String(n + 1), token });
          }
        }
      });
    });
  }
  return { findings, checked, allowFile: ALLOW_FILE };
}

/**
 * A repo-relative path, or for a bare filename any file in the tree with that basename, or for a
 * partial path like "handlers/task.go" any file whose path ends with it.
 */
function pathExists(repo: string, token: string, index: Set<string>): boolean {
  for (const candidate of [token, join("internal", token)]) {
    if (existsSync(join(repo, candidate))) return true;
  }
  if (!token.includes("/")) return index.has(token);
  return index.has(`suffix:${token}`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "bin"]);

function buildBasenameIndex(repo: string): Set<string> {
  const index = new Set<string>();
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
        continue;
      }
      index.add(e.name);
      const parts = relative(repo, abs).split(sep);
      for (let i = 0; i < parts.length; i++) index.add(`suffix:${parts.slice(i).join("/")}`);
    }
  };
  walk(repo);
  return index;
}

function loadAllowList(repo: string): Set<string> {
  const allow = new Set<string>();
  const body = readText(repo, ALLOW_FILE);
  if (body === undefined) return allow;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("#")) allow.add(line);
  }
  return allow;
}
