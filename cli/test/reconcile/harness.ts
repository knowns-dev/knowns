// Differential harness for the reconciler: the same operation runs against the Go 0.34.1 binary
// and the TypeScript code in two copies of one fixture, each with its own HOME, and the whole
// `.knowns` tree is compared byte for byte.
//
// Normalised, and only because Go itself makes it nondeterministic: RFC 3339 timestamps
// (time.Now), the record chain hashes that cover those timestamps (`recordHash`, `prevRecordHash`),
// the batch ids (a hash that includes the project path), generated doc ids, and the per-run temp
// root. Canonical entity hashes, paths, revisions, operations and file names are compared exactly.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { installReconciler } from "../../src/wiring/reconciler.ts";
import {
  dispose,
  hasGoBin,
  makeProject,
  type Project,
  runGoIn,
  runTsIn,
} from "../cli/commands/doc-harness.ts";

export { dispose, hasGoBin, makeProject, type Project, runGoIn, runTsIn };

installReconciler();

const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const _DOC_ID_RE = /doc-[0-9a-f]{32}/g;

export function normalize(text: string, p: Project): string {
  return (
    text
      .replaceAll(p.base, "<ROOT>")
      .replaceAll(JSON.stringify(p.base).slice(1, -1), "<ROOT>")
      .replace(TS_RE, "<TS>")
      .replace(/("(?:recordHash|prevRecordHash)": ?")[0-9a-f]{64}"/g, '$1<CHAIN>"')
      .replace(/batch-[0-9a-f]{24}/g, "batch-<ID>")
      // lifecycle event ids embed time.Now().UnixNano() and a random suffix
      .replace(/(task:[^:\s"]+:[a-z_]+:)\d+:[0-9a-f]{16}/g, "$1<NS>:<R>")
      // The Go binary logs its search-index hook on stderr; that hook is TSR-2MPMDK's seam.
      .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[search\][^\n]*\n/gm, "")
  );
}

/** Every file under `.knowns` except runtime residue, as relative path to normalised content. */
export function tree(p: Project, opts: { locks?: boolean } = {}): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(p.dir, ".knowns");
  if (!existsSync(root)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join("/");
        // The search runtime is a separate subsystem (TSR-2MPMDK).
        if (rel.startsWith(".search/") || rel.startsWith("history/state/qdrant-")) continue;
        if (!opts.locks && rel.endsWith(".lock")) continue;
        out.set(rel, normalize(readFileSync(full, "utf8"), p));
      }
    }
  };
  walk(root);
  return out;
}

export function treeDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const n of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(n)) diffs.push(`${n}: only in ts`);
    else if (!b.has(n)) diffs.push(`${n}: only in go`);
    else if (a.get(n) !== b.get(n))
      diffs.push(`${n}: differs\n--- go\n${a.get(n)}\n--- ts\n${b.get(n)}`);
  }
  return diffs;
}

export interface Pair {
  go: Project;
  ts: Project;
}

export function makePair(fixture: string, setup?: (dir: string) => void): Pair {
  return { go: makeProject(fixture, setup), ts: makeProject(fixture, setup) };
}

export function disposePair(pair: Pair): void {
  dispose(pair.go);
  dispose(pair.ts);
}

export interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runBothCli(pair: Pair, args: string[]): Promise<{ go: Out; ts: Out }> {
  const g = runGoIn(pair.go, args);
  const t = await runTsIn(pair.ts, args);
  const strip = (s: string) => s.replace(/\n UPDATE {2}v[^\n]*\n/g, "");
  return {
    go: {
      code: g.code,
      stdout: normalize(strip(g.stdout), pair.go),
      stderr: normalize(strip(g.stderr), pair.go),
    },
    ts: {
      code: t.code,
      stdout: normalize(t.stdout, pair.ts),
      stderr: normalize(t.stderr, pair.ts),
    },
  };
}
