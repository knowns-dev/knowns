// Go-diff for commands that read stdin or write machine state: the Go oracle and the TypeScript
// CLI each run as a subprocess against a fresh copy of the same template (a project directory and
// a temporary HOME), and the comparison covers stdout, stderr, the exit code and the files the
// command left behind. Nothing here touches the real ~/.knowns.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { GO_BIN, normalizeGo } from "../oracle.ts";

const CLI_DIR = join(import.meta.dir, "..", "..", "..");
const TS_ENTRY = join(CLI_DIR, "src", "bin.ts");

export interface Sandbox {
  root: string;
  home: string;
  proj: string;
}

export function makeSandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const proj = join(root, "proj");
  return { root, home, proj };
}

export function sandboxEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    NO_UPDATE_CHECK: "1",
    CI: "1",
    ...extra,
  };
}

/**
 * Fixture steps run inline: otherwise a step such as `doc create` starts the shared runtime
 * daemon detached, with its cwd and HOME inside the template, and it outlives the test (Windows
 * then refuses to delete the directory). init would also download a language server.
 */
const FIXTURE_ENV = { KNOWNS_RUNTIME_INLINE: "1", KNOWN_LSP_AUTO_INSTALL: "0" };

/** Runs the Go oracle in the template itself (used to build fixtures). */
export function goInTemplate(t: Sandbox, args: string[], env: Record<string, string> = {}): string {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const r = Bun.spawnSync([GO_BIN, ...args], {
    cwd: t.proj,
    env: sandboxEnv(t.home, { ...FIXTURE_ENV, ...env }),
  });
  if (r.exitCode !== 0) {
    throw new Error(`fixture step failed: ${args.join(" ")}\n${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

export interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  /** Files (relative to the run root) whose content is compared too; directories are walked. */
  watch?: string[];
}

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  files: Record<string, string>;
}

function snapshot(root: string, watch: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (abs: string) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) add(join(abs, name));
      return;
    }
    // A write stamps the wall clock; everything else in the file is compared.
    files[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8").replace(
      /^updatedAt: .*$/gm,
      "updatedAt: <now>",
    );
  };
  for (const w of watch) add(join(root, w));
  return files;
}

// Async on purpose: a test that serves a stub API in-process needs its event loop free while the
// command runs.
async function runIn(
  bin: string[],
  t: Sandbox,
  args: string[],
  opts: RunOptions,
  isGo: boolean,
): Promise<Outcome> {
  const run = mkdtempSync(join(tmpdir(), "knowns-run-"));
  try {
    cpSync(t.root, run, { recursive: true });
    const home = join(run, "home");
    const proj = join(run, "proj");
    const proc = Bun.spawn([...bin, ...args], {
      cwd: proj,
      env: sandboxEnv(home, opts.env),
      stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const clean = (s: string) => {
      const out = s.replaceAll(run, "<RUN>");
      return isGo ? normalizeGo(out) : out;
    };
    const files = snapshot(run, opts.watch ?? []);
    for (const k of Object.keys(files)) files[k] = clean(files[k] as string);
    return {
      code,
      stdout: clean(stdout),
      stderr: clean(stderr),
      files,
    };
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

export function runGoIn(t: Sandbox, args: string[], opts: RunOptions = {}): Promise<Outcome> {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  return runIn([GO_BIN], t, args, opts, true);
}

export function runTsIn(t: Sandbox, args: string[], opts: RunOptions = {}): Promise<Outcome> {
  return runIn([process.execPath, TS_ENTRY], t, args, opts, false);
}

/** goInTemplate for a step that calls a stub server living in the test's own event loop. */
export async function goInTemplateAsync(
  t: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const p = Bun.spawn([GO_BIN, ...args], {
    cwd: t.proj,
    env: sandboxEnv(t.home, { ...FIXTURE_ENV, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`fixture step failed: ${args.join(" ")}\n${err}`);
  return out;
}
