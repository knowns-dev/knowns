// Runs the Go binary (the parity oracle) and the TypeScript CLI side by side.
// Go tests need KNOWNS_GO_BIN pointing at a knowns binary built from this repo; they skip without it.
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, type CommandSpec } from "../../src/cli/core/define.ts";
import { memoryIO } from "../../src/cli/core/io.ts";
import { execute } from "../../src/cli/core/root.ts";
import { VERSION } from "../../src/version.ts";

export const GO_BIN = process.env.KNOWNS_GO_BIN;
export const hasGoBin = GO_BIN !== undefined && existsSync(GO_BIN);

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** An empty directory with no project in it, and a HOME that has no machine registry. */
export const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "knowns-cli-golden-")));

export const processEnv = (extra: Record<string, string> = {}): Record<string, string> =>
  baseEnv(extra);

const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: sandbox,
  USERPROFILE: sandbox,
  NO_UPDATE_CHECK: "1",
  CI: "1",
  ...extra,
});

export function runGo(
  args: string[],
  env: Record<string, string> = {},
  cwd: string = sandbox,
): Result {
  if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
  const r = Bun.spawnSync([GO_BIN, ...args], { cwd, env: baseEnv(env) });
  return {
    code: r.exitCode ?? -1,
    stdout: normalizeGo(r.stdout.toString()),
    stderr: normalizeGo(r.stderr.toString()),
  };
}

/** The oracle is built without the release ldflags and so calls itself "dev"; TS reports VERSION. */
export function normalizeGo(text: string): string {
  return (
    text
      .replaceAll("(vdev)", `(v${VERSION})`)
      .replace(/^knowns version dev$/m, `knowns version ${VERSION}`)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
      .replace(/(Knowns(?:\x1b\[m)? (?:\x1b\[32m)?)dev/, `$1${VERSION}`)
  );
}

export interface TsOptions {
  env?: Record<string, string>;
  extra?: CommandSpec[];
  cwd?: string;
  /** Run the unmigrated-config check (off by default so tests never read a real project). */
  configWarning?: boolean;
  checkForUpdate?: () => Promise<string>;
  updateTimeoutMs?: number;
}

export async function runTs(args: string[], opts: TsOptions = {}): Promise<Result> {
  const { io, out, err } = memoryIO();
  const code = await execute(args, {
    io,
    env: baseEnv(opts.env),
    cwd: opts.cwd ?? sandbox,
    skipConfigWarning: !opts.configWarning,
    ...(opts.extra && { extra: opts.extra }),
    ...(opts.checkForUpdate && { checkForUpdate: opts.checkForUpdate }),
    ...(opts.updateTimeoutMs !== undefined && { updateTimeoutMs: opts.updateTimeoutMs }),
  });
  return { code, stdout: out.text, stderr: err.text };
}

export { buildCommand };
