// CLI-only helpers for the end to end suites in this folder. Every call spawns the real CLI as a
// subprocess: KNOWNS_TS_BIN (a compiled binary, what CI uses) when set, else `bun src/main.ts`.
// Never the Go binary. MCP clients belong to the MCP suites, not here.

import { afterAll, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv } from "../helpers/process-env.ts";
import { tsSide } from "../rollback/binaries.ts";

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const dirs: string[] = [];

/** Removes every directory made by tmp() when the file's tests are done. */
export function registerCleanup(): void {
  afterAll(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // a lingering child may still hold the directory on Windows
      }
    }
  });
}

/** A fresh directory with symlinks resolved (so /var vs /private/var never matters). */
export function tmp(prefix = "kn-e2e-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** The env of a child: the test process env (already sandboxed by the preload) plus overrides. */
export function childEnv(
  extra: Record<string, string> = {},
  home?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // KNOWN_LSP_AUTO_INSTALL=0 (spelled so in init.ts) keeps `init` from downloading language
  // servers into the empty sandbox home, which takes over a minute and is not under test here.
  Object.assign(env, { NO_COLOR: "1", KNOWNS_RUNTIME_INLINE: "1", KNOWN_LSP_AUTO_INSTALL: "0" });
  if (home) Object.assign(env, homeEnv(home), { KNOWNS_LSP_DAEMON: "0" });
  return { ...env, ...extra };
}

export interface RunOptions {
  /** Extra env. A value of "" is passed through as an empty variable. */
  env?: Record<string, string>;
  /** Isolated user home (HOME and USERPROFILE). Default: the sandboxed home of the test process. */
  home?: string;
  timeoutMs?: number;
}

/** Runs the CLI in `dir` and waits for it (default timeout 60s). */
export function runCli(dir: string, args: string[], opts: RunOptions = {}): CLIResult {
  const side = tsSide();
  const r = Bun.spawnSync([...side.cmd, ...args], {
    cwd: dir,
    env: childEnv(opts.env, opts.home),
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 60_000,
  });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode ?? -1 };
}

/** Starts the CLI without waiting (servers). */
export function spawnCli(dir: string, args: string[], opts: RunOptions = {}) {
  const side = tsSide();
  return Bun.spawn([...side.cmd, ...args], {
    cwd: dir,
    env: childEnv(opts.env, opts.home),
    stdout: "ignore",
    stderr: "ignore",
  });
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

/** git init + local identity + `knowns init --no-wizard` inside `dir` (created when missing). */
export function initProject(dir: string, name = "e2e-test"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@e2e.local"]);
  git(dir, ["config", "user.name", "E2E Test"]);
  const res = runCli(dir, ["init", name, "--no-wizard"]);
  if (res.exitCode !== 0) {
    throw new Error(`knowns init failed (code ${res.exitCode}): ${res.stderr}\n${res.stdout}`);
  }
  return dir;
}

/** An isolated, initialised project. */
export function setupTestProject(): string {
  return initProject(tmp());
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const CREATED = /created\s+task\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i;
const TASK_REF = /task-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/;

/** The id from "Created task <id>:", else from an @task-<id> reference; "" when neither. */
export function extractTaskIDShort(output: string): string {
  const clean = output.replace(ANSI, "");
  return CREATED.exec(clean)?.[1] ?? TASK_REF.exec(clean)?.[1] ?? "";
}

function clip(s: string, n = 500): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

/** Fails with the output when the CLI did not exit 0. */
export function requireSuccess(res: CLIResult, what = ""): void {
  if (res.exitCode !== 0) {
    throw new Error(
      `expected exit code 0, got ${res.exitCode}${what ? `: ${what}` : ""}\nstdout: ${clip(res.stdout)}\nstderr: ${clip(res.stderr)}`,
    );
  }
}

export function assertContains(haystack: string, needle: string, what = ""): void {
  expect(haystack, what || `output should contain ${JSON.stringify(needle)}`).toContain(needle);
}

/** A free TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
