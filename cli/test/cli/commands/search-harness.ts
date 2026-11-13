// Differential harness for search, retrieve, resolve, config, status and quickstart: the same argv
// runs against the Go oracle and the TypeScript CLI in two copies of one fixture project, then
// stdout, stderr, exit code and the resulting .knowns tree are compared.
//
// Built on doc-harness (projects, tree snapshots, timestamp / hash / temp-root normalisation). It
// differs in two ways: both binaries run with KNOWNS_RUNTIME_INLINE=1 (Go would otherwise spawn
// its runtime daemon) and a per-step extra environment, and `home` stays isolated per side.
//
// Normalised, and only because the sides legitimately differ: the oracle reports itself as `dev`
// where the TypeScript CLI reports its package version, the update banner Go adds around runs, and
// whatever doc-harness already rewrites (timestamps, generated ids, hashes, the temp root).
import { join } from "node:path";
import { VERSION } from "../../../src/version.ts";
import { GO_BIN, hasGoBin, normalizeGo, type Result, runTs } from "../oracle.ts";
import {
  makeProject,
  normalize,
  type Project,
  snapshot,
  stripUpdateNotice,
} from "./doc-harness.ts";

export {
  dispose,
  hasGoBin,
  type Project,
  treeContentDiff,
  writeText as writeFixtureText,
} from "./doc-harness.ts";

export interface Step {
  args: string[];
  /** Extra environment for this step, both sides. */
  env?: Record<string, string>;
  /** Run the TS side as a real process (needed when the command reads stdin). */
  stdin?: string;
}

// A suite that silently skips proves nothing: on CI a missing oracle is a failure.
if (process.env.CI && !hasGoBin) {
  throw new Error(
    "KNOWNS_GO_BIN is not set (or does not exist) and CI is set: the differential suites cannot be skipped",
  );
}

const baseEnv = (p: Project, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: p.home,
  USERPROFILE: p.home,
  NO_UPDATE_CHECK: "1",
  CI: "1",
  KNOWNS_RUNTIME_INLINE: "1",
  ...extra,
});

export function runGo(p: Project, step: Step): Result {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const r = Bun.spawnSync([GO_BIN, ...step.args], {
    cwd: p.dir,
    env: baseEnv(p, step.env),
    stdin: Buffer.from(step.stdin ?? ""),
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

export async function runTsStep(p: Project, step: Step): Promise<Result> {
  if (step.stdin !== undefined) {
    const main = join(import.meta.dir, "..", "..", "..", "src", "main.ts");
    const r = Bun.spawnSync(["bun", main, ...step.args], {
      cwd: p.dir,
      env: baseEnv(p, step.env),
      stdin: Buffer.from(step.stdin),
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  // The storage layer reads the machine root from process.env.HOME and the runtime queue reads
  // its knobs (KNOWNS_RUNTIME_INLINE, the semantic overrides) from process.env, so the in-process
  // run needs the whole sandbox env there (a real binary gets it from its environment). Without
  // it a queued reindex tries to start a real daemon from the test process.
  const env = baseEnv(p, step.env);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "PATH") continue;
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    // configWarning: the real binary tells you when the project config needs `knowns migrate`.
    return await runTs(step.args, { cwd: p.dir, env, configWarning: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Go reports `dev`; the TS CLI reports VERSION. Only the places a version is printed. */
export function normalizeVersion(text: string): string {
  return (
    text
      .replace(/("version": ")dev(")/g, `$1${VERSION}$2`)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI styling is part of the output
      .replace(/(Version:(?:\x1b\[m)? )dev$/gm, `$1${VERSION}`)
  );
}

/** A private copy of a fixture (no Go or TS run), for tests of the libraries. */
export function makeFixtureProject(fixture: string, setup?: (dir: string) => void): Project {
  return makeProject(fixture, setup);
}

export interface Compared {
  go: Result[];
  ts: Result[];
  goTree: Map<string, string>;
  tsTree: Map<string, string>;
  goP: Project;
  tsP: Project;
}

export interface CompareOptions {
  setup?: (dir: string) => void;
  /** Maps the text of each result before comparison (both sides). */
  map?: (text: string) => string;
}

export async function compare(
  fixture: string,
  steps: Step[],
  opts: CompareOptions = {},
): Promise<Compared> {
  const goP = makeProject(fixture, opts.setup);
  const tsP = makeProject(fixture, opts.setup);
  const map = opts.map ?? ((t: string) => t);
  const go: Result[] = [];
  const ts: Result[] = [];
  for (const s of steps) {
    const g = runGo(goP, s);
    go.push({
      code: g.code,
      stdout: map(normalize(normalizeVersion(stripUpdateNotice(normalizeGo(g.stdout))), goP)),
      stderr: map(normalize(normalizeVersion(stripUpdateNotice(normalizeGo(g.stderr))), goP)),
    });
    const t = await runTsStep(tsP, s);
    ts.push({
      code: t.code,
      stdout: map(normalize(t.stdout, tsP)),
      stderr: map(normalize(t.stderr, tsP)),
    });
  }
  return { go, ts, goTree: snapshot(goP), tsTree: snapshot(tsP), goP, tsP };
}
