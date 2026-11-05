// Differential harness for the doc, template and validate commands: the same argv runs against the
// Go oracle and the TypeScript CLI in two copies of the same project, then stdout, stderr, exit
// code and the resulting .knowns tree are compared.
//
// Normalised, and only because Go itself makes it nondeterministic: RFC 3339 timestamps (time.Now),
// generated doc ids (`doc-<32 hex>`), 64-hex canonical/record hashes (they cover the timestamps and
// ids), history record/version ids, and the per-run temp root.
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
import { dirname, join, relative, sep } from "node:path";
import { fixtureRoot } from "../../helpers/fixtures.ts";
import { GO_BIN, hasGoBin, normalizeGo, type Result, runTs } from "../oracle.ts";

export { hasGoBin };

export interface Project {
  /** The project root (contains `.knowns`). */
  dir: string;
  home: string;
  base: string;
}

export function makeProject(fixture: string, setup?: (dir: string) => void): Project {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "knowns-doc-diff-")));
  const dir = join(base, "proj");
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  if (fixture === "") mkdirSync(dir, { recursive: true });
  else cpSync(fixtureRoot(fixture), dir, { recursive: true });
  // Fixtures keep helper payloads next to .knowns; they are not part of a project.
  for (const extra of ["_api", "_home"]) rmSync(join(dir, extra), { recursive: true, force: true });
  setup?.(dir);
  return { dir, home, base };
}

export function dispose(p: Project): void {
  // maxRetries: Windows can report EBUSY for a moment after a child process exits.
  rmSync(p.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const envFor = (p: Project): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: p.home,
  USERPROFILE: p.home,
  NO_UPDATE_CHECK: "1",
  CI: "1",
  // Without these Go forks a detached `__runtime run` whose cwd is the project, which keeps the
  // temp dir busy on Windows (EBUSY on dispose); the other harnesses set them too.
  KNOWNS_RUNTIME_INLINE: "1",
  KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
});

export function runGoIn(p: Project, args: string[], stdin = ""): Result {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const r = Bun.spawnSync([GO_BIN, ...args], {
    cwd: p.dir,
    env: envFor(p),
    stdin: Buffer.from(stdin),
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

export async function runTsIn(p: Project, args: string[]): Promise<Result> {
  // The storage layer reads the machine root from process.env.HOME, so the in-process run needs
  // the sandbox home there too (a real binary gets it from its environment).
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = p.home;
  process.env.USERPROFILE = p.home;
  try {
    return await runTs(args, { cwd: p.dir, env: envFor(p) });
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
  }
}

/** The TS CLI as a real process, for commands that read stdin. */
export function runTsProcIn(p: Project, args: string[], stdin = ""): Result {
  const main = join(import.meta.dir, "..", "..", "..", "src", "main.ts");
  const r = Bun.spawnSync(["bun", main, ...args], {
    cwd: p.dir,
    env: envFor(p),
    stdin: Buffer.from(stdin),
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const DOC_ID_RE = /doc-[0-9a-f]{32}/g;
const HASH_RE = /\b[0-9a-f]{64}\b/g;

export function normalize(text: string, p: Project): string {
  return (
    text
      .replaceAll(p.base, "<ROOT>")
      // JSON output escapes Windows backslashes ("C:\\Users\\..."), which the raw form misses.
      .replaceAll(JSON.stringify(p.base).slice(1, -1), "<ROOT>")
      .replace(TS_RE, "<TS>")
      .replace(DOC_ID_RE, "<DOCID>")
      .replace(HASH_RE, "<HASH>")
  );
}

/** Every file under `.knowns` (relative path -> normalised content). */
export function snapshot(p: Project): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(p.dir, ".knowns");
  if (!existsSync(root)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join("/");
        // The Go binary also queues search work (.search/); that runtime is not part of this port.
        if (rel.startsWith(".search/") || rel.startsWith("history/state/qdrant-")) continue;
        // Lock files are residue of taking a lock (Go also takes them on no-op mutations).
        if (rel.endsWith(".lock")) continue;
        out.set(rel.replace(DOC_ID_RE, "<DOCID>"), normalize(readFileSync(full, "utf8"), p));
      }
    }
  };
  walk(root);
  return out;
}

/** History/ledger files carry per-run ids and clocks beyond the patterns above; compare names only. */
const NAME_ONLY = [/^history\//, /^versions\//, /^\.search\//, /^audit\//, /^locks?\//, /\.lock$/];

export interface Step {
  args: string[];
  stdin?: string;
  /** Run the TS side as a real process (needed when the command reads stdin). */
  proc?: boolean;
}

export interface Compared {
  go: Result[];
  ts: Result[];
  goTree: Map<string, string>;
  tsTree: Map<string, string>;
}

/** Runs the steps on both sides in fresh copies of `fixture`. */
export async function compareSteps(
  fixture: string,
  steps: Step[],
  setup?: (dir: string) => void,
): Promise<{ result: Compared; goP: Project; tsP: Project }> {
  const goP = makeProject(fixture, setup);
  const tsP = makeProject(fixture, setup);
  const go: Result[] = [];
  const ts: Result[] = [];
  for (const s of steps) {
    const g = runGoIn(goP, s.args, s.stdin ?? "");
    go.push({
      code: g.code,
      stdout: normalize(normalizeGo(g.stdout), goP),
      stderr: normalize(normalizeGo(g.stderr), goP),
    });
    const t =
      s.proc || s.stdin !== undefined
        ? runTsProcIn(tsP, s.args, s.stdin ?? "")
        : await runTsIn(tsP, s.args);
    ts.push({ code: t.code, stdout: normalize(t.stdout, tsP), stderr: normalize(t.stderr, tsP) });
  }
  return {
    result: { go, ts, goTree: snapshot(goP), tsTree: snapshot(tsP) },
    goP,
    tsP,
  };
}

/** Go prints an update banner from the (dev) build; strip the blocks Go adds around runs. */
export function stripUpdateNotice(text: string): string {
  return text.replace(/\n UPDATE {2}v[^\n]*\n/g, "");
}

export function treeNames(m: Map<string, string>): string[] {
  return [...m.keys()].filter((k) => !k.startsWith(".")).sort();
}

export function treeContentDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const diffs: string[] = [];
  const names = new Set([...a.keys(), ...b.keys()]);
  for (const n of [...names].sort()) {
    const inA = a.has(n);
    const inB = b.has(n);
    if (!inA || !inB) {
      diffs.push(`${n}: only in ${inA ? "go" : "ts"}`);
      continue;
    }
    if (NAME_ONLY.some((re) => re.test(n))) continue;
    if (a.get(n) !== b.get(n)) diffs.push(`${n}: content differs`);
  }
  return diffs;
}

export function writeText(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
