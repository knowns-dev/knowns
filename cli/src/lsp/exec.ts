// Process helpers shared by the detector, installer and adapters: PATH lookup, the 2s version
// probes and generic command runs (Go: exec.LookPath, runVersionCheck, defaultRunCommand).
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type Ctx, ctxErr } from "./context.ts";

export type LookPath = (name: string) => string | undefined;
export type RunCheck = (ctx: Ctx, path: string, ...args: string[]) => Promise<void>;
export type RunCommand = (ctx: Ctx, name: string, ...args: string[]) => Promise<string>;

/** exec.LookPath: undefined when the binary is not found. Names with a separator are checked as paths. */
export const lookPath: LookPath = (name) => {
  if (name === "") return undefined;
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    try {
      if (!statSync(name).isFile()) return undefined;
      if (process.platform !== "win32") accessSync(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  const found = Bun.which(name);
  return found ?? undefined;
};

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs a command to completion; rejects when it cannot start or ctx aborts. */
export function runProcess(
  ctx: Ctx,
  name: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const e0 = ctxErr(ctx);
    if (e0) return reject(e0);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(name, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    const onAbort = () => {
      child.kill();
    };
    ctx?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      ctx?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      ctx?.removeEventListener("abort", onAbort);
      const aborted = ctxErr(ctx);
      if (aborted) return reject(aborted);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Go runVersionCheck: success means exit code 0. */
export const runVersionCheck: RunCheck = async (ctx, path, ...args) => {
  const r = await runProcess(ctx, path, args);
  if (r.code !== 0) throw new Error(`exit status ${r.code}`);
};

/** Go defaultRunCommand: CombinedOutput; a non-zero exit is an error. */
export const defaultRunCommand: RunCommand = async (ctx, name, ...args) => {
  const r = await runProcess(ctx, name, args);
  if (r.code !== 0) {
    const err = new Error(`exit status ${r.code}`) as Error & { output?: string };
    err.output = r.stdout + r.stderr;
    throw err;
  }
  return r.stdout + r.stderr;
};
