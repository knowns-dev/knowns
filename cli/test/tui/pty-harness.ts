// Runs Go 0.34.1 and the TypeScript CLI on a pseudo-terminal with the same keystrokes and compares
// what they asked and what they wrote. Unix only (needs python3 for the pty); on Windows, or
// without python3, the suites skip and the non-TTY fallbacks are proven elsewhere.
//
// huh and clack agree on Enter, the arrow keys, y/n and typed text. They differ on toggling a
// multi-select item (huh: x, clack: space), so a key script gives both spellings: "{toggle}".
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  disposeInit,
  type InitProject,
  makeInitProject,
  normalizeInit,
  snapshotTree,
} from "../cli/commands/init-harness.ts";
import { GO_BIN, hasGoBin } from "../cli/oracle.ts";

export { disposeInit, hasGoBin, type InitProject, makeInitProject, normalizeInit, snapshotTree };

export const hasPty = process.platform !== "win32" && Bun.which("python3") !== null;

const DRIVER = join(import.meta.dir, "..", "helpers", "ptydrive.py");
const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");

export const KEY = {
  enter: "\r",
  down: "\x1b[B",
  up: "\x1b[A",
  ctrlC: "\x03",
};

export interface PtyStep {
  /** Regex the screen must show before the keys are sent. */
  expect: string | null;
  /** Keys; "{toggle}" is x for Go and space for TS. */
  keys: string;
}

export interface PtyResult {
  transcript: string;
  exit: number | null;
}

/** A PATH holding git (and bun for the TS side) and no ollama, so the Ollama probe is deterministic. */
export function sandboxPath(withBun: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knowns-pty-bin-")));
  const link = (name: string, target: string | null | undefined) => {
    if (target) symlinkSync(target, join(dir, name));
  };
  link("git", Bun.which("git"));
  if (withBun) link("bun", process.execPath);
  return dir;
}

function run(
  side: "go" | "ts",
  p: InitProject,
  args: string[],
  steps: PtyStep[],
  env: Record<string, string>,
): PtyResult {
  const spec = {
    env: {
      HOME: p.home,
      USERPROFILE: p.home,
      PATH: sandboxPath(side === "ts"),
      NO_UPDATE_CHECK: "1",
      KNOWNS_RUNTIME_INLINE: "1",
      KNOWN_LSP_AUTO_INSTALL: "0",
      ...env,
    },
    argv: side === "go" ? [GO_BIN as string, ...args] : [process.execPath, MAIN, ...args],
    steps: steps.map((s) => [s.expect, s.keys.replaceAll("{toggle}", side === "go" ? "x" : " ")]),
  };
  const specPath = join(p.base, `spec-${side}.json`);
  writeFileSync(specPath, JSON.stringify(spec));
  const r = Bun.spawnSync(["python3", "-I", DRIVER, p.dir, specPath], { timeout: 180_000 });
  if (r.exitCode !== 0) throw new Error(`pty driver failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString()) as PtyResult;
}

export interface PtyRun {
  go: PtyResult;
  ts: PtyResult;
  goTree: Map<string, string>;
  tsTree: Map<string, string>;
  goHome: Map<string, string>;
  tsHome: Map<string, string>;
  goP: InitProject;
  tsP: InitProject;
}

const skipProject = (rel: string): boolean =>
  rel === ".git" ||
  rel.startsWith(".git/") ||
  /(^|\/)\.knowns\/\.search(\/|$)/.test(rel) ||
  rel.endsWith(".lock") ||
  /(^|\/)\.knowns\/history\/state\/qdrant-/.test(rel);
const skipHome = (rel: string): boolean =>
  rel === ".bun" ||
  rel.startsWith(".bun/") ||
  rel.startsWith("Library") ||
  rel.startsWith(".knowns/logs") ||
  rel.endsWith(".lock");

/** Go's MCP logger leaves an empty ~/.knowns/ (only the skipped logs); that is not the command's output. */
function withoutLogOnlyDir(m: Map<string, string>): Map<string, string> {
  if (![...m.keys()].some((k) => k.startsWith(".knowns/") && k !== ".knowns/"))
    m.delete(".knowns/");
  return m;
}

export function runBoth(
  args: string[],
  steps: PtyStep[],
  opts: { setup?: (p: InitProject) => void; env?: Record<string, string> } = {},
): PtyRun {
  const mk = () => {
    const p = makeInitProject((q) => {
      mkdirSync(join(q.dir, ".git"), { recursive: true });
      opts.setup?.(q);
    });
    return p;
  };
  // huh asks the terminal for its background colour at startup and can swallow keys typed before
  // the answer arrives, so a Go run now and then loses an Enter. A run whose exit code differs from
  // the other side is repeated once on fresh directories before it counts.
  let goP = mk();
  let tsP = mk();
  let go = run("go", goP, args, steps, opts.env ?? {});
  let ts = run("ts", tsP, args, steps, opts.env ?? {});
  if (go.exit !== ts.exit) {
    goP = mk();
    tsP = mk();
    go = run("go", goP, args, steps, opts.env ?? {});
    ts = run("ts", tsP, args, steps, opts.env ?? {});
  }
  return {
    go,
    ts,
    goTree: snapshotTree(goP.dir, goP, skipProject),
    tsTree: snapshotTree(tsP.dir, tsP, skipProject),
    goHome: withoutLogOnlyDir(snapshotTree(goP.home, goP, skipHome)),
    tsHome: withoutLogOnlyDir(snapshotTree(tsP.home, tsP, skipHome)),
    goP,
    tsP,
  };
}

/** The titles, in the order they first appear in a transcript. */
export function askedInOrder(transcript: string, titles: string[]): string[] {
  const found = titles
    .map((t) => ({ t, at: transcript.indexOf(t) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  return found.map((x) => x.t);
}

/** `dirname` re-export so tests need not import node:path for one call. */
export { dirname };
