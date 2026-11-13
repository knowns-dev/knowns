// Differential harness for `sync` and `agents`. Unlike the .knowns-only harnesses it compares the
// whole project tree (platform files, skills, MCP configs) and the sandboxed HOME (global skills,
// ~/.claude hooks, ~/.gemini and ~/.hermes configs), because that is where sync writes.
//
// A project template is made once with the Go binary's `init --no-wizard` (the TS init is a
// separate worker's), then copied byte for byte to a Go side and a TS side, each with its own HOME.
//
// Normalised, and only because the sides legitimately differ: the temp root, wall-clock
// timestamps, the oracle's `dev` version, and the absolute path of the running executable (Go's
// os.Executable() versus bun's process.execPath), which runtime hooks embed.
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
import { GO_BIN, hasGoBin, normalizeGo, type Result, runTs } from "../oracle.ts";

export { hasGoBin };

export interface Side {
  base: string;
  dir: string;
  home: string;
}

const baseEnv = (s: Side, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: s.home,
  USERPROFILE: s.home,
  NO_UPDATE_CHECK: "1",
  CI: "1",
  KNOWNS_RUNTIME_INLINE: "1",
  KNOWN_LSP_AUTO_INSTALL: "0",
  ...extra,
});

export function runGoIn(s: Side, args: string[], env: Record<string, string> = {}): Result {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const r = Bun.spawnSync([GO_BIN, ...args], {
    cwd: s.dir,
    env: baseEnv(s, env),
    stdin: Buffer.from(""),
    timeout: 120_000,
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

export async function runTsIn(s: Side, args: string[], env: Record<string, string> = {}) {
  // The storage layer reads the machine root from process.env.HOME.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = s.home;
  process.env.USERPROFILE = s.home;
  try {
    return await runTs(args, { cwd: s.dir, env: baseEnv(s, env), configWarning: true });
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
  }
}

/** A project initialised by the Go binary: `init proj --no-wizard` with extra flags. */
export function makeTemplate(initArgs: string[] = [], prepare?: (dir: string) => void): Side {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "knowns-sync-tpl-")));
  const dir = join(base, "proj");
  const home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const side = { base, dir, home };
  const r = runGoIn(side, ["init", "proj", "--no-wizard", ...initArgs]);
  if (r.code !== 0) throw new Error(`go init failed: ${r.stderr}`);
  // The template is only a source of bytes: drop whatever the init run put in its HOME.
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  prepare?.(dir);
  return side;
}

export function copySide(t: Side): Side {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "knowns-sync-diff-")));
  const dir = join(base, "proj");
  const home = join(base, "home");
  cpSync(t.dir, dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, dir, home };
}

export function dispose(...sides: Side[]): void {
  for (const s of sides) rmSync(s.base, { recursive: true, force: true });
}

/** Edit .knowns/config.json of a template (test fixture setup; not a product code path). */
export function editConfig(
  dir: string,
  edit: (cfg: { settings: Record<string, unknown> }) => void,
): void {
  const path = join(dir, ".knowns", "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  edit(cfg);
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function writeText(dir: string, rel: string, text: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

export function normalize(text: string, s: Side): string {
  let t = text
    .replaceAll(s.base, "<ROOT>")
    .replaceAll(JSON.stringify(s.base).slice(1, -1), "<ROOT>")
    .replace(TS_RE, "<TS>");
  for (const exe of new Set([GO_BIN, process.execPath].filter((x): x is string => !!x))) {
    t = t
      .replaceAll(exe, "<KNOWNS_BIN>")
      .replaceAll(JSON.stringify(exe).slice(1, -1), "<KNOWNS_BIN>");
  }
  return t;
}

/** Relative path to normalised content, for every file under root except skipped prefixes. */
export function tree(root: string, s: Side, skip: RegExp[] = []): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      const rel = relative(root, full).split(sep).join("/");
      if (skip.some((re) => re.test(rel))) continue;
      if (statSync(full).isDirectory()) {
        out.set(`${rel}/`, "");
        walk(full);
      } else out.set(rel, normalize(readFileSync(full).toString("latin1"), s));
    }
  };
  walk(root);
  return out;
}

/** .git internals and runtime residue that Go and TS legitimately differ on. */
const PROJECT_SKIP = [/^\.git(\/|$)/, /^\.knowns\/(\.search|runtime|history)(\/|$)/, /\.lock$/];
// Go creates the machine root (~/.knowns/{logs,runtime,lsp-servers}) as it starts; sync does not
// write there, so the directories are not part of what is compared.
const HOME_SKIP = [/^\.knowns\/(logs|runtime|lsp-servers)(\/|$)/, /^\.knowns\/?$/];

export interface StepResult {
  go: Result;
  ts: Result;
}

export interface Pair {
  go: Side;
  ts: Side;
}

export function makePair(t: Side): Pair {
  return { go: copySide(t), ts: copySide(t) };
}

export async function runBoth(
  p: Pair,
  args: string[],
  env: Record<string, string> = {},
): Promise<StepResult> {
  const go = runGoIn(p.go, args, env);
  const ts = await runTsIn(p.ts, args, env);
  const fix = (r: Result, s: Side): Result => ({
    code: r.code,
    stdout: normalize(normalizeGo(r.stdout), s),
    stderr: normalize(normalizeGo(r.stderr), s),
  });
  return { go: fix(go, p.go), ts: fix(ts, p.ts) };
}

export function treeDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(k)) diffs.push(`only in TS: ${k}`);
    else if (!b.has(k)) diffs.push(`only in Go: ${k}`);
    else if (a.get(k) !== b.get(k)) diffs.push(`differs: ${k}`);
  }
  return diffs.sort();
}

export function projectTreeDiff(p: Pair): string[] {
  return treeDiff(tree(p.go.dir, p.go, PROJECT_SKIP), tree(p.ts.dir, p.ts, PROJECT_SKIP));
}

export function homeTreeDiff(p: Pair): string[] {
  return treeDiff(tree(p.go.home, p.go, HOME_SKIP), tree(p.ts.home, p.ts, HOME_SKIP));
}
