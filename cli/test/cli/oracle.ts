// Runs the Go binary (the parity oracle) and the TypeScript CLI side by side.
// Go tests need KNOWNS_GO_BIN pointing at a knowns binary built from this repo; they skip without it.

import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, type CommandSpec } from "../../src/cli/core/define.ts";
import { memoryIO } from "../../src/cli/core/io.ts";
import { GO_SHORT_OF_REMOVED, REMOVED_COMMAND_SHORT } from "../../src/cli/core/removed.ts";
import { execute } from "../../src/cli/core/root.ts";
import { VERSION } from "../../src/version.ts";
import { withProcessEnv } from "../helpers/process-env.ts";

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
      // D8: root help lists removed commands as removed; this is the only intended difference.
      .replaceAll(GO_SHORT_OF_REMOVED.import ?? "\u0000", REMOVED_COMMAND_SHORT.import ?? "")
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

// Proxy variables never go on process.env: Bun on Windows keeps using a proxy after it is removed
// (see test/helpers/process-env.ts and the init harness).
const PROXY_KEY = /^(https?|all|no)_proxy$/i;

export async function runTs(args: string[], opts: TsOptions = {}): Promise<Result> {
  const { io, out, err } = memoryIO();
  const env = baseEnv(opts.env);
  // The in-process CLI resolves ~/.knowns, the runtime root and the runtime knobs from
  // process.env, not from `env`. Without this, a call ran against whatever home the test process
  // has (formerly the developer's real one) instead of the sandbox the caller asked for.
  // Windows has no empty environment variables (setting one to "" removes it), so a real child
  // given USERPROFILE="" runs with it unset; mirror that instead of leaving "" on process.env,
  // which libuv's homedir lookup rejects with ENOENT.
  const mirrored: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env)
      .filter(([k]) => k !== "PATH" && !PROXY_KEY.test(k))
      .map(([k, v]) => [k, process.platform === "win32" && v === "" ? undefined : v]),
  );
  const code = await withProcessEnv(mirrored, () =>
    execute(args, {
      io,
      env,
      cwd: opts.cwd ?? sandbox,
      skipConfigWarning: !opts.configWarning,
      ...(opts.extra && { extra: opts.extra }),
      ...(opts.checkForUpdate && { checkForUpdate: opts.checkForUpdate }),
      ...(opts.updateTimeoutMs !== undefined && { updateTimeoutMs: opts.updateTimeoutMs }),
    }),
  );
  return { code, stdout: out.text, stderr: err.text };
}

export { buildCommand };
