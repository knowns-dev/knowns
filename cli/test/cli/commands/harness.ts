// Differential harness for command tests: the same arguments run against a Go 0.34.1 binary and
// the TypeScript CLI, each in its own copy of one golden fixture and its own HOME, comparing
// stdout, stderr, exit code and the resulting .knowns tree.
//
// Only what Go itself makes nondeterministic is normalised, and `Normalizer` is the one place that
// does it: wall-clock timestamps, hashes chained over them, generated ids (task ids, time entry
// ids, lifecycle event ids), and elapsed-time text. Nothing else is rewritten, so any other
// difference fails the test.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { GO_BIN, hasGoBin, type Result, runGo, runTs } from "../oracle.ts";

export { GO_BIN, hasGoBin };

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

/**
 * Files written only by the search index/runtime hooks (internal/search/sync.go: Qdrant intent
 * watermarks) that the lifecycle library reaches through `taskLifecycleSeams`. Those hooks belong
 * to the search sync / runtime subsystem, which is not ported, so the tree comparison skips them.
 */
const SEAM_FILES = [
  /^history\/state\/qdrant-index-watermarks\.json$/,
  /^\.search\/locks\/qdrant-watermarks\.lock$/,
  // The hook reads task history under its entity lock, which creates the (empty) lock file.
  /^history\/locks\/.*\.lock$/,
];

export interface Side {
  dir: string;
  home: string;
}

export interface Pair {
  go: Side;
  ts: Side;
  norm: Normalizer;
}

function makeSide(fixture: string): Side {
  const root = mkdtempSync(join(tmpdir(), "knowns-cmd-"));
  const dir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(home);
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return { dir, home };
}

/** Two fresh copies of a fixture. */
export function makePair(fixture: string): Pair {
  return { go: makeSide(fixture), ts: makeSide(fixture), norm: new Normalizer() };
}

const RFC3339 = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

export class Normalizer {
  private readonly ids = { go: new Map<string, string>(), ts: new Map<string, string>() };
  /** Rewrite durations too (a stopped timer's length is wall-clock). */
  durations = false;
  /** Rewrite elapsed-time text of running timers (it reads the clock when the command runs). */
  elapsed = false;

  /** Learn the ids a command created, by ordinal, from its stdout. */
  learn(side: "go" | "ts", stdout: string): void {
    for (const m of stdout.matchAll(/Created task (\S+?):/g)) {
      const map = this.ids[side];
      if (!map.has(m[1] as string)) map.set(m[1] as string, `<ID${map.size + 1}>`);
    }
  }

  /** A `<IDn>` placeholder in an argument becomes the id that side generated for the nth task. */
  arg(side: "go" | "ts", value: string): string {
    return value.replace(/<ID\d+>/g, (token) => {
      for (const [id, t] of this.ids[side]) if (t === token) return id;
      return token;
    });
  }

  /**
   * `shape` keeps the timestamp layout visible: Go writes frontmatter times as exactly
   * `YYYY-MM-DDTHH:MM:SS.mmmZ`, and a task file must keep doing so.
   */
  text(side: "go" | "ts", input: string, shape = false): string {
    let s = input;
    for (const [id, token] of this.ids[side]) s = s.replaceAll(id, token);
    s = s.replace(RFC3339, (ts) => (shape && /\.\d{3}Z$/.test(ts) ? "<TS.mmmZ>" : "<TS>"));
    s = s.replace(/\b[0-9a-f]{64}\b/g, "<HASH>");
    s = s.replace(/te-\d+-/g, "te-<MS>-");
    s = s.replace(/(time-stop-|reorder-[A-Za-z0-9.-]+?-)\d+/g, "$1<NS>");
    s = s.replace(/(task:[^:\s"]+:[a-z_]+:)\d+:[0-9a-f]{16}/g, "$1<NS>:<R>");
    if (this.elapsed) {
      s = s.replace(/ELAPSED: [0-9hms ]+/g, "ELAPSED: <E>");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI styling is part of the output
      s = s.replace(/— (\x1b\[36m)?[0-9hms ]+(\x1b\[m)?/g, "— $1<E>$2");
    }
    if (this.durations) {
      s = s.replace(/Duration: [0-9hms ]+/g, "Duration: <D>");
      s = s.replace(/"duration":( ?)\d+/g, '"duration":$1<D>');
      s = s.replace(/"timeSpent":( ?)\d+/g, '"timeSpent":$1<D>');
      // history JSONL: {"field":"timeSpent","oldValue":null,"newValue":88287}
      s = s.replace(/("field":"timeSpent","oldValue":[^,]+,"newValue":)\d+/g, "$1<D>");
      s = s.replace(/timeSpent: \d+/g, "timeSpent: <D>");
      // task history: "timeSpent: <nil> -> 88115"; Go and TS can straddle a second boundary.
      s = s.replace(/(timeSpent: \S+ -> )\d+/g, "$1<D>");
      // time log rows and totals ("24h 29m"): the running entry's length crosses minute boundaries.
      s = s.replace(/\b\d+h \d+m\b/g, "<D>");
      s = s.replace(/TIME SPENT: [0-9hms ]+/g, "TIME SPENT: <D>");
    }
    return s;
  }
}

export interface Run {
  go: Result;
  ts: Result;
}

export interface RunOptions {
  /** Extra environment for both sides. */
  env?: Record<string, string>;
}

/** Runs the same arguments on both sides. */
export async function runBoth(pair: Pair, args: string[], opts: RunOptions = {}): Promise<Run> {
  const goEnv = { HOME: pair.go.home, USERPROFILE: pair.go.home, ...opts.env };
  const tsEnv = { HOME: pair.ts.home, USERPROFILE: pair.ts.home, ...opts.env };
  const go = runGo(
    args.map((a) => pair.norm.arg("go", a)),
    goEnv,
    pair.go.dir,
  );
  const ts = await runTs(
    args.map((a) => pair.norm.arg("ts", a)),
    { env: tsEnv, cwd: pair.ts.dir },
  );
  pair.norm.learn("go", go.stdout);
  pair.norm.learn("ts", ts.stdout);
  return { go, ts };
}

/** The normalised result of one side, for comparison. */
export function normalized(pair: Pair, run: Run): { go: Result; ts: Result } {
  const n = (side: "go" | "ts", r: Result): Result => ({
    code: r.code,
    stdout: pair.norm.text(side, r.stdout),
    stderr: pair.norm.text(side, r.stderr),
  });
  return { go: n("go", run.go), ts: n("ts", run.ts) };
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split("\\").join("/"));
  }
}

/** The normalised .knowns tree: relative path to content (SEAM_FILES excluded). */
export function snapshot(pair: Pair, side: "go" | "ts"): Record<string, string> {
  const base = join(pair[side].dir, ".knowns");
  const files: string[] = [];
  if (existsSync(base)) walk(base, base, files);
  const tree: Record<string, string> = {};
  for (const rel of files) {
    if (SEAM_FILES.some((re) => re.test(rel))) continue;
    // Pending-lifecycle files are named by the sha256 of a random event id.
    const name = pair.norm.text(side, rel).replace(/[0-9a-f]{64}\.json$/, "<HASH>.json");
    const frontmatter = /^(tasks|archive)\//.test(rel);
    tree[name] = pair.norm.text(side, readFileSync(join(base, rel), "utf8"), frontmatter);
  }
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function treesOf(pair: Pair): { go: Record<string, string>; ts: Record<string, string> } {
  return { go: snapshot(pair, "go"), ts: snapshot(pair, "ts") };
}
