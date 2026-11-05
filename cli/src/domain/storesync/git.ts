// Port of internal/storesync/git.go: every Git invocation of store sync. Interactive credential
// prompts are disabled (HTTPS prompts off, SSH in batch mode), so a missing credential fails fast
// with Git's own message (store spec D4). Knowns never passes a credential.
import { spawn } from "node:child_process";

/** DefaultGitTimeout bounds every Git operation so an unreachable remote fails, not hangs. */
export const DEFAULT_GIT_TIMEOUT_MS = 2 * 60 * 1000;

/** A failed Git invocation with its standard error. */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    fallback: string,
  ) {
    super(stderr.trim() === "" ? fallback : stderr.trim());
    this.name = "GitError";
  }
}

/** time.Duration.String for the whole-second timeouts used here (2m0s, 30s, 1h0m0s). */
export function goDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

interface RawResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: string | null;
  spawnError?: Error;
}

function run(
  dir: string,
  args: string[],
  env: string[] | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RawResult & { timedOut: boolean }> {
  const sshBase = process.env.GIT_SSH_COMMAND || "ssh";
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: `${sshBase} -o BatchMode=yes -o ConnectTimeout=15`,
  };
  for (const kv of env ?? []) {
    const i = kv.indexOf("=");
    if (i > 0) childEnv[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let done = false;
    const child = spawn("git", args, {
      cwd: dir === "" ? undefined : dir,
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (r: RawResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...r, timedOut });
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) =>
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        code: null,
        signal: null,
        spawnError: e,
      }),
    );
    child.on("close", (code, sig) =>
      finish({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code, signal: sig }),
    );
  });
}

/**
 * gitBytes runs git in dir and returns its standard output as bytes. A zero timeout means
 * DEFAULT_GIT_TIMEOUT_MS. The error is a GitError whose message is Git's own text.
 */
export async function gitBytes(
  signal: AbortSignal | undefined,
  dir: string,
  timeoutMs: number,
  env: string[] | undefined,
  ...args: string[]
): Promise<Buffer> {
  const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_GIT_TIMEOUT_MS;
  const r = await run(dir, args, env, timeout, signal);
  if (r.spawnError || r.code !== 0) {
    if (r.timedOut) {
      throw new GitError(
        args,
        `git ${args[0]} timed out after ${goDuration(timeout)}`,
        "context deadline exceeded",
      );
    }
    const fallback = r.spawnError
      ? r.spawnError.message
      : r.code === null
        ? `signal: ${(r.signal ?? "killed").replace(/^SIG/, "").toLowerCase()}`
        : `exit status ${r.code}`;
    throw new GitError(args, r.stderr.toString("utf8"), fallback);
  }
  return r.stdout;
}

/** Git runs git in dir and returns its standard output as text. */
export async function git(
  signal: AbortSignal | undefined,
  dir: string,
  timeoutMs: number,
  env: string[] | undefined,
  ...args: string[]
): Promise<string> {
  return (await gitBytes(signal, dir, timeoutMs, env, ...args)).toString("utf8");
}

/** How the sync loop reacts to a failed remote operation. */
export type FailureClass = "unreachable" | "credential" | "rejected";

const REJECTED = [
  "non-fast-forward",
  "fetch first",
  "[rejected]",
  "updates were rejected",
  "stale info",
];
const CREDENTIAL = [
  "authentication failed",
  "could not read username",
  "could not read password",
  "terminal prompts disabled",
  "permission denied (publickey",
  "host key verification failed",
  "access denied",
  "http 401",
  "http 403",
  "error: 401",
  "error: 403",
  "returned error: 401",
  "returned error: 403",
  "invalid username or password",
  "repository not found",
];

/** ClassifyFailure sorts a Git error message into a FailureClass. */
export function classifyFailure(message: string): FailureClass {
  const s = message.toLowerCase();
  if (REJECTED.some((m) => s.includes(m))) return "rejected";
  if (CREDENTIAL.some((m) => s.includes(m))) return "credential";
  return "unreachable";
}
