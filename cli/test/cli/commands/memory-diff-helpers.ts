// Differential harness for the memory and decision commands: the same arguments run against the Go
// binary and the TypeScript CLI, each in its own copy of a golden fixture project with an isolated
// HOME (the global memory layer lives in ~/.knowns). stdout, stderr, the exit code and the resulting
// file tree are compared after masking only what Go itself makes nondeterministic.
import { expect } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fixtureRoot } from "../../helpers/fixtures.ts";

export const GO_BIN = process.env.KNOWNS_GO_BIN;
export const hasGoBin = GO_BIN !== undefined && existsSync(GO_BIN);
/** KNOWNS_TS_BIN runs a compiled TypeScript binary instead of `bun src/main.ts`. */
const MAIN = resolve(import.meta.dir, "..", "..", "..", "src", "main.ts");

export interface World {
  root: string;
  project: string;
  home: string;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const made: string[] = [];
export function cleanupWorlds(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A project (a copy of the golden fixture, or an empty `knowns init`-shaped one) plus its HOME. */
export function makeWorld(fixture = "full"): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-memdec-")));
  made.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  cpSync(join(fixtureRoot(fixture), ".knowns"), join(project, ".knowns"), { recursive: true });
  const fixtureHome = join(fixtureRoot(fixture), "_home", ".knowns");
  if (existsSync(fixtureHome)) cpSync(fixtureHome, join(home, ".knowns"), { recursive: true });
  return { root, project, home };
}

function env(w: World): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: w.home,
    USERPROFILE: w.home,
    NO_UPDATE_CHECK: "1",
    CI: "1",
    // Without this the Go binary queues an index job and spawns a background runtime daemon after
    // every memory/decision write (runtime/ state under HOME). That subsystem is ported separately.
    KNOWNS_RUNTIME_INLINE: "1",
    // No semantic runtime: the review libraries' semantic leg must stay off in both binaries.
    KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
  };
}

export function runGo(w: World, args: string[], stdin = ""): Run {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const r = Bun.spawnSync([GO_BIN, ...args], {
    cwd: w.project,
    env: env(w),
    stdin: Buffer.from(stdin),
  });
  // The oracle is built without the release ldflags and calls itself "dev".
  const fix = (t: string) => t.replaceAll("(vdev)", "(v0.34.1)");
  return {
    code: r.exitCode ?? -1,
    stdout: fix(r.stdout.toString()),
    stderr: fix(r.stderr.toString()),
  };
}

export function runTs(w: World, args: string[], stdin = ""): Run {
  const cmd = process.env.KNOWNS_TS_BIN ? [process.env.KNOWNS_TS_BIN] : ["bun", MAIN];
  const r = Bun.spawnSync([...cmd, ...args], {
    cwd: w.project,
    env: env(w),
    stdin: Buffer.from(stdin),
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Every file below a world's .knowns directories, keyed by path relative to the world. */
export function tree(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      // ~/.knowns/logs/mcp.log is created empty by the Go binary at startup (root logging init).
      if (name.endsWith(".lock") || name.startsWith(".tmp") || name === "mcp.log") continue;
      out[relative(w.root, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(join(w.project, ".knowns"));
  walk(join(w.home, ".knowns"));
  return out;
}

/**
 * Go renders a memory's `metadata:` block by ranging over a map, so with two or more keys the line
 * order is random (the TypeScript port sorts them). Sort the block's lines on both sides.
 */
export function sortMetadataBlock(text: string): string {
  return text.replace(/^metadata:\n((?: {2}.*\n)+)/gm, (_m, block: string) => {
    const lines = block.split("\n").filter((l) => l !== "");
    return `metadata:\n${lines.sort().join("\n")}\n`;
  });
}

const TS_RE = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g;
const DID_RE = /\b(\d{8})-\d{4}-/g;

/** Today's date as yyyymmdd, local and UTC: the only ids whose minute prefix the wall clock chose. */
const TODAY = (() => {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return new Set([
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`,
  ]);
})();

/**
 * The masks. Go itself makes these nondeterministic: wall-clock timestamps, the random base36
 * memory/task ids and the minute-resolution decision id prefix. Nothing else is touched.
 */
export function mask(text: string, newIds: string[] = []): string {
  let t = sortMetadataBlock(text)
    .replace(TS_RE, "<TS>")
    .replace(DID_RE, (m, day: string) => (TODAY.has(day) ? "<DID>-" : m));
  newIds.forEach((id, i) => {
    t = t.replaceAll(id, `<NEW${i + 1}>`);
  });
  return t;
}

/** Memory ids present in a world, project and global. */
export function memoryIds(w: World): string[] {
  const ids: string[] = [];
  for (const base of [join(w.project, ".knowns", "memory"), join(w.home, ".knowns", "memory")]) {
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base)) {
      const m = /^memory-(.+)\.md$/.exec(f);
      if (m) ids.push(m[1] as string);
    }
  }
  return ids.sort();
}

export interface Pair {
  go: World;
  ts: World;
  /** Memory ids that did not exist in the fixture, in creation order, per binary. */
  goIds: string[];
  tsIds: string[];
}

export function makePair(fixture = "full"): Pair {
  return { go: makeWorld(fixture), ts: makeWorld(fixture), goIds: [], tsIds: [] };
}

export interface Compared {
  go: Run;
  ts: Run;
}

/**
 * Runs `args` on both worlds and returns the masked results plus the masked trees. Newly created
 * memory ids are replaced by position so the two binaries' random ids compare equal.
 */
export type Args = string[] | ((w: World) => string[]);
const argsOf = (a: Args, w: World): string[] => (typeof a === "function" ? a(w) : a);

/** The decision id whose file name ends in `-<slug>.md` (newest first when several), per world. */
export function decisionId(w: World, slug: string, nth = 0): string {
  const dir = join(w.project, ".knowns", "decisions");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(`-${slug}.md`) || new RegExp(`-${slug}-\\d+\\.md$`).test(f))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const id = hits[nth];
  if (!id) throw new Error(`no decision for slug ${slug} in ${dir}`);
  return id;
}

export function runBoth(
  pair: Pair,
  args: Args,
  opts: { stdin?: string; sortLines?: boolean } = {},
): { go: Run; ts: Run; goTree: Record<string, string>; tsTree: Record<string, string> } {
  const beforeGo = memoryIds(pair.go);
  const beforeTs = memoryIds(pair.ts);
  const go = runGo(pair.go, argsOf(args, pair.go), opts.stdin);
  const ts = runTs(pair.ts, argsOf(args, pair.ts), opts.stdin);
  // Ids created by this run are labelled in order of creation time (file mtime is too coarse, so
  // the order is the sorted id set seen so far plus the new ones, which is stable per run).
  for (const id of memoryIds(pair.go).filter((i) => !beforeGo.includes(i))) pair.goIds.push(id);
  for (const id of memoryIds(pair.ts).filter((i) => !beforeTs.includes(i))) pair.tsIds.push(id);
  const newGo = pair.goIds;
  const newTs = pair.tsIds;
  const norm = (r: Run, ids: string[]): Run => ({
    code: r.code,
    stdout: mask(r.stdout, ids),
    stderr: mask(r.stderr, ids),
  });
  const maskTree = (t: Record<string, string>, ids: string[]) => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(t)) o[mask(k, ids)] = mask(v, ids);
    return o;
  };
  return {
    go: norm(go, newGo),
    ts: norm(ts, newTs),
    goTree: maskTree(tree(pair.go), newGo),
    tsTree: maskTree(tree(pair.ts), newTs),
  };
}

/**
 * matchedBy lists come from a Go map iteration and so are in random order in the Go binary; sort
 * the comma-separated MATCHED_BY value and the JSON matchedBy arrays before comparing.
 */
export function sortMatchedBy(text: string): string {
  return text
    .replace(
      /^( {2}MATCHED_BY: )(.*)$/gm,
      (_m, p: string, v: string) => p + v.split(", ").sort().join(", "),
    )
    .replace(/"matchedBy": \[([^\]]*)\]/g, (_m, inner: string) => {
      const items = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .sort();
      return `"matchedBy": [${items.join(", ")}]`;
    });
}

/** Blocks separated by blank lines, sorted: list output ordered by Go's random generated ids. */
function sortBlocks(text: string): string {
  return text.split("\n\n").sort().join("\n\n");
}

/** Write the same file into both worlds (path relative to the world root). */
export function writeBoth(pair: Pair, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    for (const w of [pair.go, pair.ts]) {
      const p = join(w.root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

export interface ParityOptions {
  stdin?: string;
  /** The output is a list in Go's (random) generated-id order: compare its blocks as a set. */
  unordered?: boolean;
}

/**
 * Runs `args` on both binaries and asserts identical exit code, stdout, stderr and resulting file
 * tree. Returns the (masked) Go result so a test can also assert on content.
 */
export function expectParity(pair: Pair, args: Args, opts: ParityOptions = {}): Run {
  const label = typeof args === "function" ? args(pair.ts).join(" ") : args.join(" ");
  const r = runBoth(pair, args, opts);
  const fix = (t: string) => sortMatchedBy(opts.unordered ? sortBlocks(t) : t);
  expect(r.ts.code, `exit code of: ${label}`).toBe(r.go.code);
  expect(fix(r.ts.stdout), `stdout of: ${label}`).toBe(fix(r.go.stdout));
  expect(r.ts.stderr, `stderr of: ${label}`).toBe(r.go.stderr);
  const sorted = (t: Record<string, string>) =>
    Object.entries(t).sort(([a], [b]) => (a < b ? -1 : 1));
  expect(sorted(r.tsTree), `file tree after: ${label}`).toEqual(sorted(r.goTree));
  return r.go;
}
