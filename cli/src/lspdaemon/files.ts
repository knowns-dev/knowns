// Ports of token.go, lock.go and state.go: the on-disk discovery files of the daemon.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { sleep } from "../lsp/context.ts";
import type { Paths, TransportEndpoint } from "./identity.ts";
import { endpoint, ensureDir } from "./identity.ts";

export const ErrEmptyToken = new Error("lsp daemon token is empty");

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isCode(e: unknown, code: string): boolean {
  return (e as { code?: string } | undefined)?.code === code;
}

/** ReadToken: reads and trims the project daemon token. */
export function readToken(paths: Paths): string {
  const data = readFileSync(paths.tokenPath, "utf8");
  const token = data.trim();
  if (token === "") throw ErrEmptyToken;
  return token;
}

function readTokenWithRetry(paths: Paths): string {
  let last: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return readToken(paths);
    } catch (e) {
      if (e !== ErrEmptyToken) throw e;
      last = e;
      sleepSync(10);
    }
  }
  throw last ?? ErrEmptyToken;
}

/** EnsureToken: reads the project token or atomically creates a user-only one. */
export function ensureToken(paths: Paths): string {
  try {
    const token = readTokenWithRetry(paths);
    try {
      chmodSync(paths.tokenPath, 0o600);
    } catch {
      // best effort
    }
    return token;
  } catch (e) {
    if (!isCode(e, "ENOENT")) throw e;
  }
  ensureDir(paths);
  const token = randomBytes(32).toString("hex");
  const tmp = `${paths.tokenPath}.${token.slice(0, 12)}.tmp`;
  let fd: number;
  try {
    fd = openSync(tmp, "wx", 0o600);
  } catch (e) {
    if (!isCode(e, "EEXIST")) throw e;
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    fd = openSync(tmp, "wx", 0o600);
  }
  try {
    try {
      writeSync(fd, `${token}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best effort
    }
    try {
      linkSync(tmp, paths.tokenPath);
    } catch (e) {
      if (isCode(e, "EEXIST")) return readTokenWithRetry(paths);
      throw e;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
  try {
    chmodSync(paths.tokenPath, 0o600);
  } catch {
    // best effort
  }
  return token;
}

/** TokenEqual: constant-time comparison. */
export function tokenEqual(expected: string, actual: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(actual, "utf8").digest();
  return expected.length === actual.length && timingSafeEqual(a, b);
}

// ---- lock ----

export interface LockOptions {
  timeoutMs?: number;
  staleAgeMs?: number;
  pollIntervalMs?: number;
}

export class Lock {
  private released = false;
  constructor(readonly path: string) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      unlinkSync(this.path);
    } catch (e) {
      if (!isCode(e, "ENOENT")) throw e;
    }
  }
}

export function acquireProjectLock(paths: Paths, opts: LockOptions = {}): Promise<Lock> {
  return acquireLock(paths.lockPath, opts);
}

/** AcquireLock: exclusive lock file; stale files (older than staleAge) are removed. */
export async function acquireLock(path: string, opts: LockOptions = {}): Promise<Lock> {
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 3000;
  const staleAge = opts.staleAgeMs && opts.staleAgeMs > 0 ? opts.staleAgeMs : 10_000;
  const poll = opts.pollIntervalMs && opts.pollIntervalMs > 0 ? opts.pollIntervalMs : 50;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeout;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, String(process.pid));
      } catch (e) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
        throw e;
      }
      closeSync(fd);
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort
      }
      return new Lock(path);
    }
    try {
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > staleAge) {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
        continue;
      }
    } catch {
      // vanished between open and stat; retry immediately
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${path}`);
    await sleep(poll);
  }
}

// ---- state ----

export interface State {
  project_root: string;
  project_key: string;
  pid?: number;
  endpoint: TransportEndpoint;
  updated_at: string;
}

export function newState(paths: Paths, pid: number): State {
  const s: State = {
    project_root: paths.project.root,
    project_key: paths.project.key,
    endpoint: endpoint(paths),
    updated_at: new Date().toISOString(),
  };
  if (pid !== 0) s.pid = pid;
  return s;
}

function writeUserOnlyFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

/** WriteState: MarshalIndent("", "  ") plus a trailing newline, user-only. */
export function writeState(paths: Paths, state: State): void {
  const s: State = { ...state };
  if (!s.project_root) s.project_root = paths.project.root;
  if (!s.project_key) s.project_key = paths.project.key;
  if (!s.endpoint?.address) s.endpoint = endpoint(paths);
  if (!s.updated_at) s.updated_at = new Date().toISOString();
  const ordered = {
    project_root: s.project_root,
    project_key: s.project_key,
    ...(s.pid ? { pid: s.pid } : {}),
    endpoint: { kind: s.endpoint.kind, address: s.endpoint.address },
    updated_at: s.updated_at,
  };
  writeUserOnlyFile(paths.statePath, `${JSON.stringify(ordered, null, 2)}\n`);
}

export function readState(paths: Paths): State {
  return JSON.parse(readFileSync(paths.statePath, "utf8")) as State;
}
