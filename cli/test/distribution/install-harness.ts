// Runs install/install.sh against a fake release mirror in a temp HOME. Nothing touches the real
// HOME, PATH dirs or network: downloads come from a file:// KNOWNS_BASE_URL, and `uname` is
// shadowed by a stub so any platform can be exercised on this machine.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homeEnv } from "../helpers/process-env.ts";

export const INSTALL_SH = resolve(import.meta.dir, "../../../install/install.sh");
export const INSTALL_PS1 = resolve(import.meta.dir, "../../../install/install.ps1");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `knowns-${prefix}-`));
}

export interface Release {
  /** Base URL to pass as KNOWNS_BASE_URL. */
  baseUrl: string;
  dir: string;
}

/** Builds <dir>/<tag>/knowns-<platform>.tar.gz(.sha256) holding a stub `knowns` that prints `label`. */
export function makeRelease(
  tag: string,
  platform: string,
  label: string,
  dir = tempDir("rel"),
): Release {
  const stage = tempDir("stage");
  const bin = join(stage, "knowns");
  writeFileSync(bin, `#!/bin/sh\necho "knowns version ${label}"\n`);
  chmodSync(bin, 0o755);
  mkdirSync(join(dir, tag), { recursive: true });
  const archive = join(dir, tag, `knowns-${platform}.tar.gz`);
  run(["tar", "-czf", archive, "-C", stage, "./knowns"]);
  const sum = sha256Hex(archive);
  writeFileSync(`${archive}.sha256`, `${sum}  knowns-${platform}.tar.gz\n`);
  return { baseUrl: `file://${dir}`, dir };
}

export function sha256Hex(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function run(cmd: string[], env?: Record<string, string>, cwd?: string) {
  const r = Bun.spawnSync(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

export interface Sandbox {
  home: string;
  /** Directories placed on PATH ahead of the system ones (HOME-relative dirs are created). */
  extraPath: string[];
}

export function makeSandbox(extraPathRel: string[] = []): Sandbox {
  const home = tempDir("home");
  const extraPath = extraPathRel.map((rel) => {
    const d = join(home, rel);
    mkdirSync(d, { recursive: true });
    return d;
  });
  return { home, extraPath };
}

/**
 * A `uname` that answers -s/-m with the given values, and a `sysctl` that answers
 * sysctl.proc_translated (1 = the shell runs under Rosetta 2), both first on PATH.
 */
export function fakeUname(os: string, arch: string, translated = false): string {
  const d = tempDir("uname");
  const f = join(d, "uname");
  writeFileSync(
    f,
    `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${arch};; *) echo ${os};; esac\n`,
  );
  chmodSync(f, 0o755);
  const sysctl = join(d, "sysctl");
  writeFileSync(
    sysctl,
    `#!/bin/sh\nfor a; do [ "$a" = sysctl.proc_translated ] && { echo ${translated ? 1 : 0}; exit 0; }; done\nexit 1\n`,
  );
  chmodSync(sysctl, 0o755);
  return d;
}

export function runInstall(opts: {
  sandbox: Sandbox;
  baseUrl: string;
  version: string;
  uname?: [string, string];
  /** With uname: whether the stub sysctl reports a Rosetta-translated shell. */
  rosetta?: boolean;
  env?: Record<string, string>;
}) {
  const sys = "/usr/bin:/bin:/usr/sbin:/sbin";
  const pathParts = [
    ...(opts.uname ? [fakeUname(...opts.uname, opts.rosetta)] : []),
    ...opts.sandbox.extraPath,
    sys,
  ];
  const env: Record<string, string> = {
    ...homeEnv(opts.sandbox.home),
    PATH: pathParts.join(":"),
    TMPDIR: tmpdir(),
    KNOWNS_BASE_URL: opts.baseUrl,
    KNOWNS_VERSION: opts.version,
    ...opts.env,
  };
  return run(["sh", INSTALL_SH], env);
}
