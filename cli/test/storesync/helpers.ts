// Shared fixtures for the store sync tests: real git repositories in temp dirs (a bare remote and
// clones), an isolated HOME per side, and a controlled git environment (no user or system config).
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setDaemonCommand } from "../../src/runtime/queue.ts";
import { installStoreSync } from "../../src/wiring/storesync.ts";
import { GO_BIN, hasGoBin, type Result, runGo, runTs } from "../cli/oracle.ts";

export { GO_BIN, hasGoBin };

/** The controlled git identity every test commit uses. */
export const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.test",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "author@example.test",
  GIT_TERMINAL_PROMPT: "0",
};

export function tempRoot(prefix = "knowns-store-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Runs git with the controlled environment; throws on failure. */
export function git(cwd: string, home: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...GIT_ENV },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

/** A bare remote seeded with one commit on main (a README), so clones have a branch and upstream. */
export function makeRemote(root: string, name: string): string {
  const home = join(root, "githome");
  mkdirSync(home, { recursive: true });
  const bare = join(root, `${name}.git`);
  git(root, home, "init", "--bare", "-b", "main", bare);
  const seed = join(root, `${name}-seed`);
  git(root, home, "clone", bare, seed);
  git(seed, home, "checkout", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# store\n");
  git(seed, home, "add", "-A");
  git(seed, home, "commit", "-m", "seed");
  git(seed, home, "push", "origin", "main");
  // Forward slashes: Go derives the store name from the text after the last "/" or ":", so a
  // backslash path would be one giant "name" on Windows (Go and TS both reject it).
  return bare.replaceAll("\\", "/");
}

export interface Side {
  root: string;
  home: string;
  /** The code repository the store is linked to. */
  code: string;
}

/** An isolated machine: HOME with a git identity, and an empty code directory named "proj". */
export function makeSide(root: string, name: string): Side {
  const dir = join(root, name);
  const home = join(dir, "home");
  const code = join(dir, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(code, { recursive: true });
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = Test Author\n\temail = author@example.test\n[core]\n\tautocrlf = false\n",
  );
  return { root: dir, home, code };
}

export const sideEnv = (s: Side, extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: s.home,
  USERPROFILE: s.home,
  KNOWNS_RUNTIME_INLINE: "1",
  KNOWN_LSP_AUTO_INSTALL: "0",
  ...GIT_ENV,
  ...extra,
});

/** Runs the Go binary in s.code. */
export function runGoSide(
  s: Side,
  args: string[],
  extra: Record<string, string> = {},
  cwd = s.code,
): Result {
  return runGo(args, sideEnv(s, extra), cwd);
}

/** Runs the TypeScript CLI in-process: runtime knobs come from process.env, so set them around the call. */
export async function runTsSide(
  s: Side,
  args: string[],
  extra: Record<string, string> = {},
  cwd = s.code,
): Promise<Result> {
  const env = sideEnv(s, extra);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await runTs(args, { env, cwd, configWarning: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every file under dir (relative, slash-separated), skipping .git. */
export function tree(dir: string): Record<string, string> {
  const SKIP = new Set(["logs/mcp.log"]); // Go creates it whenever a command runs; the TS CLI only for MCP
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      if (name === ".git") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split("\\").join("/");
        if (!SKIP.has(rel)) out[rel] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Masks what the two sides legitimately differ in: their temp roots, generated ids and clocks. */
export function maskFor(s: Side, text: string): string {
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  let t = text;
  for (const root of [s.root, esc(s.root), s.root.replaceAll("\\", "/")])
    t = t.split(root).join("<SIDE>");
  t = t.replace(TS_RE, "<TS>").replace(/\b\d{8}T\d{6}Z\b/g, "<STAMP>");
  t = t.replace(/("id": ")[0-9a-z]{6}(")/g, "$1<ID>$2");
  return t;
}

export function maskTree(s: Side, t: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [maskFor(s, k), maskFor(s, v)]));
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  ms: number,
  step = 100,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

/** The daemon entry the TS runtime tests spawn: main.ts with store sync wired in. */
export const DAEMON_ENTRY = join(import.meta.dir, "daemon-entry.ts");

installStoreSync();
setDaemonCommand(() => ({ cmd: process.execPath, args: [DAEMON_ENTRY, "__runtime", "run"] }));

export interface Daemon {
  pid: number;
  kill(): void;
  exited: Promise<number | null>;
  log(): string;
}

/** Spawns a daemon (Go or TS) for a side and returns a handle that kills only that PID. */
export function spawnDaemon(
  s: Side,
  which: "go" | "ts",
  extra: Record<string, string> = {},
): Daemon {
  const env = { ...sideEnv(s, extra), PATH: process.env.PATH ?? "" } as Record<string, string>;
  delete env.KNOWNS_RUNTIME_INLINE;
  const cmd = which === "go" ? (GO_BIN as string) : process.execPath;
  const args = which === "go" ? ["__runtime", "run"] : [DAEMON_ENTRY, "__runtime", "run"];
  const child = spawn(cmd, args, { cwd: s.code, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", (d) => {
    log += d;
  });
  child.stderr?.on("data", (d) => {
    log += d;
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  return {
    pid: child.pid as number,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    },
    exited,
    log: () => log,
  };
}
