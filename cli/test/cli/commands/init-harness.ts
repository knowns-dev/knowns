// Differential harness for `knowns init`: the same argv runs against the Go oracle and the
// TypeScript CLI, each in its own empty project directory and its own HOME, then stdout, stderr,
// exit code, the whole project tree (.knowns plus CLAUDE.md, AGENTS.md, .gitignore, ...) and the
// HOME tree are compared.
//
// Normalised, and only because Go itself makes it nondeterministic or the sides legitimately differ:
//   - wall-clock timestamps (config.json createdAt: Go writes microseconds, TS milliseconds);
//   - the temp root path;
//   - the spinner frames init draws on stderr (their count depends on how long a step takes);
//   - the oracle's version string;
//   - the wording of a JSON syntax error (Go's encoding/json vs Bun's parser), which comes from the
//     storage layer and is not init's to fix;
//   - runtime-only trees: .knowns/.search, lock files, ~/.knowns/logs (Go's MCP log), the bun
//     cache under HOME/Library or HOME/.bun, and the inside of .git (only whether it exists is compared).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { withProcessEnv } from "../../helpers/process-env.ts";
import { GO_BIN, hasGoBin, normalizeGo, type Result, runTs } from "../oracle.ts";

export { hasGoBin };

export interface InitProject {
  base: string;
  dir: string;
  home: string;
  /** dir is a symlink and commands run with PWD set to it. */
  linked?: boolean;
}

export interface InitStep {
  args: string[];
  /** Extra environment for this step, both sides. */
  env?: Record<string, string>;
  /** Runs on both sides (project dir and HOME) before the command, to edit files between steps. */
  before?: (p: InitProject) => void;
  /**
   * Run both sides as real processes in a new session, so they have no controlling terminal
   * (/dev/tty cannot be opened) however the test runner itself was started.
   */
  detached?: boolean;
  /**
   * Run the TS side as a separate `bun` process instead of in-process. Needed when the env sets
   * HTTP(S)_PROXY: Bun on Windows keeps using a proxy put on process.env even after it is removed,
   * which breaks every later test in the run that talks to a local server.
   */
  proc?: boolean;
}

export function makeInitProject(
  setup?: (p: InitProject) => void,
  sub = "",
  linked = false,
): InitProject {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "knowns-init-diff-")));
  const dir = join(base, "proj");
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  if (linked) {
    // proj -> real: the shell's $PWD says "proj", the kernel's getcwd says "real".
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), dir);
  }
  mkdirSync(join(dir, sub), { recursive: true });
  const p: InitProject = { base, dir, home, ...(linked ? { linked } : {}) };
  setup?.(p);
  return { ...p, dir: join(dir, sub) };
}

export function disposeInit(p: InitProject): void {
  rmSync(p.base, { recursive: true, force: true });
}

const baseEnv = (p: InitProject, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: p.home,
  USERPROFILE: p.home,
  ...(p.linked ? { PWD: p.dir } : {}),
  NO_UPDATE_CHECK: "1",
  CI: "1",
  KNOWNS_RUNTIME_INLINE: "1",
  // Go reads this name (a typo for KNOWNS_ in init.go, kept for parity): without it Go downloads
  // a language server for whatever it detects. LSP installation is not ported.
  KNOWN_LSP_AUTO_INSTALL: "0",
  ...extra,
});

const SETSID = "import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])";
const MAIN = join(import.meta.dir, "..", "..", "..", "src", "main.ts");

// A new session has no controlling terminal, so /dev/tty cannot be opened even on a developer
// machine. Needs python3 for setsid(2); on Windows (no /dev/tty) or without python3 both sides
// simply run as plain children with empty stdin, which is the same for Go and TS.
const CAN_SETSID = process.platform !== "win32" && Bun.which("python3") !== null;

const SPAWN_TIMEOUT_MS = 60_000;

function runDetached(cmd: string[], p: InitProject, step: InitStep): Result {
  const argv = CAN_SETSID ? ["python3", "-I", "-c", SETSID, ...cmd] : cmd;
  const r = Bun.spawnSync(argv, {
    cwd: p.dir,
    env: baseEnv(p, step.env),
    stdin: Buffer.from(""),
    // A child that waits for input (Go's wizard on a Windows console) must not hang the suite.
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

export function runInitGo(p: InitProject, step: InitStep): Result {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  if (step.detached) return runDetached([GO_BIN, ...step.args], p, step);
  const r = Bun.spawnSync([GO_BIN, ...step.args], {
    cwd: p.dir,
    env: baseEnv(p, step.env),
    stdin: Buffer.from(""),
    // A child that waits for input (Go's wizard on a Windows console) must not hang the suite.
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

export async function runInitTs(p: InitProject, step: InitStep): Promise<Result> {
  if (step.detached) return runDetached(["bun", MAIN, ...step.args], p, step);
  const env = baseEnv(p, step.env);
  if (step.proc) {
    // process.execPath: the step's PATH may be a sandbox that holds no bun.
    const r = Bun.spawnSync([process.execPath, MAIN, ...step.args], {
      cwd: p.dir,
      env,
      stdin: Buffer.from(""),
      timeout: SPAWN_TIMEOUT_MS,
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  if (env.HTTP_PROXY !== undefined || env.HTTPS_PROXY !== undefined) {
    throw new Error("a step that sets a proxy must use proc: true (see InitStep.proc)");
  }
  // The whole sandbox env, PATH included: the language-server install step looks up binaries on
  // PATH, and the runtime reads its knobs from process.env.
  return withProcessEnv(env, () => runTs(step.args, { cwd: p.dir, env }));
}

const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const SPINNER_FRAME = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

export function normalizeInit(text: string, p: InitProject): string {
  return normalizeGo(text)
    .replace(
      /invalid character '.' looking for [^\n]*|JSON Parse error: [^\n]*/g,
      "<JSON-SYNTAX-ERROR>",
    )
    .replaceAll(p.base, "<ROOT>")
    .replaceAll(JSON.stringify(p.base).slice(1, -1), "<ROOT>")
    .replace(TS_RE, "<TS>")
    .replace(new RegExp(`\\r  \\x1b\\[90m${SPINNER_FRAME}\\x1b\\[m [^\\r\\n]*`, "g"), "")
    .replace(/\r {2,}(?=\r)/g, "");
}

/**
 * Relative path to `[mode] normalised content` for files, and `dir/` to `[mode]` for directories
 * (empty ones included), for everything under root that is part of the result. A missing mkdir or
 * a different permission bit therefore fails a comparison.
 */
export function snapshotTree(root: string, p: InitProject, skip: (rel: string) => boolean) {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      const rel = relative(root, full).split(sep).join("/");
      if (skip(rel)) continue;
      const st = statSync(full);
      // Windows has no unix permission bits (stat reports 666/777 for everything), so only the
      // paths are compared there.
      const mode = process.platform === "win32" ? "[-]" : `[${(st.mode & 0o777).toString(8)}]`;
      if (st.isDirectory()) {
        out.set(`${rel}/`, mode);
        walk(full);
      } else out.set(rel, `${mode} ${normalizeInit(readFileSync(full, "utf8"), p)}`);
    }
  };
  walk(root);
  return out;
}

const skipProject = (rel: string): boolean =>
  rel === ".git" ||
  rel.startsWith(".git/") ||
  /(^|\/)\.knowns\/\.search(\/|$)/.test(rel) ||
  rel.endsWith(".lock") ||
  /(^|\/)\.knowns\/history\/state\/qdrant-/.test(rel);

// The TS side runs `bun src/main.ts`, and Bun on linux keeps its transpiler cache in $HOME/.bun
// (macOS uses HOME/Library). The compiled binary writes neither; Go has no equivalent.
const isBunCache = (rel: string): boolean => rel === ".bun" || rel.startsWith(".bun/");

const skipHome = (rel: string): boolean =>
  isBunCache(rel) ||
  rel.startsWith("Library") ||
  rel.startsWith(".knowns/logs") ||
  rel.endsWith(".lock");

/** Go's MCP logger leaves ~/.knowns/ (holding only the skipped logs); that is not init's output. */
function withoutLogOnlyDir(m: Map<string, string>): Map<string, string> {
  if (![...m.keys()].some((k) => k.startsWith(".knowns/") && k !== ".knowns/"))
    m.delete(".knowns/");
  return m;
}

export interface InitRun {
  go: Result[];
  ts: Result[];
  goTree: Map<string, string>;
  tsTree: Map<string, string>;
  goHome: Map<string, string>;
  tsHome: Map<string, string>;
  goHasGit: boolean;
  tsHasGit: boolean;
  goP: InitProject;
  tsP: InitProject;
}

export interface InitCompareOptions {
  setup?: (p: InitProject) => void;
  /** Run the command in this subdirectory of the project dir (created, may be nested). */
  sub?: string;
  /** Make the project dir a symlink and run with PWD set to it (use with `detached` steps). */
  linked?: boolean;
}

export async function compareInit(
  steps: Array<InitStep | string[]>,
  opts: InitCompareOptions = {},
): Promise<InitRun> {
  const goP = makeInitProject(opts.setup, opts.sub, opts.linked);
  const tsP = makeInitProject(opts.setup, opts.sub, opts.linked);
  const go: Result[] = [];
  const ts: Result[] = [];
  for (const raw of steps) {
    const s = Array.isArray(raw) ? { args: raw } : raw;
    s.before?.(goP);
    s.before?.(tsP);
    const g = runInitGo(goP, s);
    go.push({
      code: g.code,
      stdout: normalizeInit(g.stdout, goP),
      stderr: normalizeInit(g.stderr, goP),
    });
    const t = await runInitTs(tsP, s);
    ts.push({
      code: t.code,
      stdout: normalizeInit(t.stdout, tsP),
      stderr: normalizeInit(t.stderr, tsP),
    });
  }
  const top = (p: InitProject) => (opts.sub ? p.dir.slice(0, -(opts.sub.length + 1)) : p.dir);
  return {
    go,
    ts,
    goTree: snapshotTree(top(goP), goP, skipProject),
    tsTree: snapshotTree(top(tsP), tsP, skipProject),
    goHome: withoutLogOnlyDir(snapshotTree(goP.home, goP, skipHome)),
    tsHome: withoutLogOnlyDir(snapshotTree(tsP.home, tsP, skipHome)),
    goHasGit: existsSync(join(top(goP), ".git")),
    tsHasGit: existsSync(join(top(tsP), ".git")),
    goP,
    tsP,
  };
}

export function treeDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const n of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(n) || !b.has(n)) diffs.push(`${n}: only in ${a.has(n) ? "go" : "ts"}`);
    else if (a.get(n) !== b.get(n)) diffs.push(`${n}: content differs`);
  }
  return diffs;
}
