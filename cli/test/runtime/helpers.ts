// Shared helpers for the runtime queue tests: a Go/TS pair of the same fixture, each with its own
// HOME, run with the daemon bypassed (KNOWNS_RUNTIME_INLINE=1) or for real, and a normaliser for
// the runtime files (queue, registry, watermarks) that only masks what Go itself makes
// nondeterministic: uuids, timestamps, hashes, absolute temp paths.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setDaemonCommand } from "../../src/runtime/queue.ts";
import { installRuntime } from "../../src/wiring/runtime.ts";
import { Normalizer, type Pair } from "../cli/commands/harness.ts";
import { type Result, runGo, runTs } from "../cli/oracle.ts";
import { withProcessEnv } from "../helpers/process-env.ts";

export { hasGoBin, makePair } from "../cli/commands/harness.ts";

installRuntime();
setDaemonCommand(() => ({
  cmd: process.execPath,
  args: [join(import.meta.dir, "..", "..", "src", "main.ts"), "__runtime", "run"],
}));

const BASE = {
  NO_UPDATE_CHECK: "1",
  CI: "1",
  KNOWN_LSP_AUTO_INSTALL: "0",
};

/** Runs one side. The TS CLI runs in-process, so process.env carries HOME and the runtime knobs. */
export async function runSide(
  pair: Pair,
  side: "go" | "ts",
  args: string[],
  env: Record<string, string> = {},
): Promise<Result> {
  const s = pair[side];
  const full = { ...BASE, HOME: s.home, USERPROFILE: s.home, ...env };
  const a = args.map((x) => pair.norm.arg(side, x));
  let result: Result;
  if (side === "go") {
    result = runGo(a, full, s.dir);
  } else {
    // process.env must say what the Go side's environment says. runGo builds a clean env, so a
    // KNOWNS_RUNTIME_INLINE inherited from the shell (huit-gpu's env.sh exports it) never reaches
    // Go; the in-process TS side would still read it, run inline and never spawn its daemon.
    const onProcess: Record<string, string | undefined> = {
      KNOWNS_RUNTIME_INLINE: undefined,
      ...full,
    };
    result = await withProcessEnv(onProcess, () => runTs(a, { env: full, cwd: s.dir }));
  }
  pair.norm.learn(side, result.stdout);
  return result;
}

export const INLINE = { KNOWNS_RUNTIME_INLINE: "1" };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Masks uuids, timestamps, hashes and the side's absolute paths. */
export function mask(pair: Pair, side: "go" | "ts", text: string): string {
  const s = pair[side];
  // JSON escapes Windows backslashes ("C:\\Users\\..."), which the raw form misses.
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  let t = text.replaceAll(`/private${s.dir}`, "<PROJECT>").replaceAll(s.dir, "<PROJECT>");
  t = t.replaceAll(esc(s.dir), "<PROJECT>");
  t = t.replaceAll(`/private${s.home}`, "<HOME>").replaceAll(s.home, "<HOME>");
  t = t.replaceAll(esc(s.home), "<HOME>");
  t = pair.norm.text(side, t);
  t = t.replace(UUID, "<UUID>").replace(TS, "<TS>");
  t = t.replace(/\bproj-[0-9a-f]{8}\b/g, "<KEY>").replace(/project-[0-9a-f]{8}/g, "<KEY>");
  t = t.replace(/\b(doc-)[0-9a-f]{32}\b/g, "$1<ID>");
  // Memory ids are random (6 chars) and appear as the job key and target.
  t = t
    .replace(/(-memory::)[a-z0-9]{6}\b/g, "$1<MID>")
    .replace(/("target": ")(?=[a-z0-9]{6}")[a-z0-9]{6}/g, "$1<MID>");
  return t;
}

function walk(root: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split("\\").join("/"));
  }
}

/** Every file under HOME/.knowns/runtime plus the project's watermark file, masked. */
export function runtimeSnapshot(pair: Pair, side: "go" | "ts"): Record<string, string> {
  const s = pair[side];
  const out: Record<string, string> = {};
  const rt = join(s.home, ".knowns", "runtime");
  const files: string[] = [];
  walk(rt, rt, files);
  for (const rel of files) {
    if (/\.lock$|^(status|semantic-status)\.json$|knowns-runtime\.pid$/.test(rel)) continue;
    const key = mask(pair, side, `runtime/${rel}`);
    out[key] = mask(pair, side, readFileSync(join(rt, rel), "utf8"));
  }
  const wm = join(s.dir, ".knowns", "history", "state", "qdrant-index-watermarks.json");
  if (existsSync(wm)) {
    // Keys embed random doc ids, so Go's key order differs between two projects: sort by path.
    const parsed = Object.values(
      JSON.parse(readFileSync(wm, "utf8")) as Record<string, unknown>,
    ).map((v) => mask(pair, side, JSON.stringify(v, null, 2)));
    out.watermarks = parsed.sort().join("\n");
  }
  return out;
}

export async function waitFor(cond: () => boolean, ms: number, step = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

export { Normalizer };

/** The legacy SQLite index of one side, masked and ordered, for byte comparison with Go. */
export function sqliteIndexDump(pair: Pair, side: "go" | "ts") {
  const path = join(pair[side].dir, ".knowns", ".search", "index.db");
  expect(existsSync(path)).toBe(true);
  const db = new Database(path);
  try {
    const chunks = db
      .query(
        `SELECT id, type, content, token_count, hex(embedding) AS emb, doc_path, section, heading_level,
          header_path, position, task_id, field, status, priority, labels, memory_id, memory_layer,
          memory_store, decision_id, name, signature, visibility, detail FROM chunks ORDER BY id`,
      )
      .all();
    const hashes = db.query("SELECT source_id, hash FROM content_hashes ORDER BY source_id").all();
    const meta = db
      .query("SELECT key, value FROM metadata WHERE key <> 'indexedAt' ORDER BY key")
      .all();
    // Task ids are random per project: mask first, then order.
    const m = (rows: unknown[]) => rows.map((r) => mask(pair, side, JSON.stringify(r))).sort();
    return JSON.stringify({ chunks: m(chunks), hashes: m(hashes), meta });
  } finally {
    db.close();
  }
}
