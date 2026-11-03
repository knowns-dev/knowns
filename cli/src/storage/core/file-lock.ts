// Cross-process advisory file lock that interoperates with the Go binary.
//
// Go (internal/storage/task_lifecycle_lock_{unix,windows}.go) locks an open lock file like this:
//
//   unix     flock(fd, LOCK_EX | LOCK_NB), retried every 20 ms until it succeeds or ctx is done;
//            EWOULDBLOCK/EAGAIN means "held elsewhere", any other errno fails immediately.
//            Unlock is flock(fd, LOCK_UN), then the file is closed.
//   windows  LockFileEx(handle, EXCLUSIVE | FAIL_IMMEDIATELY, 0, 1, 0, &overlapped): the first
//            byte, retried every 20 ms; ERROR_LOCK_VIOLATION means "held elsewhere".
//            Unlock is UnlockFileEx on the same byte.
//
// The lock file is opened O_CREAT|O_RDWR with mode 0600, is never written, never deleted, and has
// no contents and no stale handling: the kernel drops the lock when the process dies. To interop,
// this module uses the same primitive on the same file, via bun:ffi (no native addon, NFR-4):
//   libc flock on darwin and linux, kernel32 CreateFileW + LockFileEx on windows.
//
// Windows note: the lock is taken on a HANDLE we open with CreateFileW rather than on the fd that
// fs.openSync returns, because a CRT/libuv fd is not a Win32 HANDLE and Bun does not expose the
// translation. The share mode (READ|WRITE|DELETE) matches what Go's os.OpenFile uses, so the two
// processes can both hold handles to the file while LockFileEx arbitrates the byte range.

import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** Poll interval while the lock is held elsewhere; the same 20 ms Go uses. */
export const LOCK_POLL_MS = 20;

export interface LockOptions {
  /** Abort waiting for the lock (Go's context cancellation). */
  signal?: AbortSignal;
  /** Give up after this many milliseconds (Go's context deadline). */
  timeoutMs?: number;
  /** Poll interval override, mainly for tests. */
  pollMs?: number;
}

export class LockError extends Error {
  override readonly name = "LockError";
  constructor(
    message: string,
    readonly path: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** A held OS lock. Release exactly once. */
export interface HeldLock {
  readonly path: string;
  release(): void;
}

interface Backend {
  /** Open the lock file (creating it) and try once to take the exclusive lock. */
  tryLock(path: string): HeldLock | null;
}

let backend: Backend | undefined;

function loadBackend(): Backend {
  backend ??= process.platform === "win32" ? windowsBackend() : unixBackend();
  return backend;
}

// --- unix ------------------------------------------------------------------------------------

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;

function unixBackend(): Backend {
  const candidates =
    process.platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  let lib: ReturnType<typeof open> | undefined;
  function open(name: string) {
    return dlopen(name, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    });
  }
  let lastError: unknown;
  for (const name of candidates) {
    try {
      lib = open(name);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!lib) {
    throw new LockError(`cannot load libc for flock: ${String(lastError)}`, "");
  }
  const symbols = lib.symbols as unknown as {
    flock(fd: number, op: number): number;
    [key: string]: unknown;
  };
  const errnoFn = symbols[errnoSymbol] as () => number;
  // EWOULDBLOCK == EAGAIN: 35 on darwin, 11 on linux.
  const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
  const errno = (): number => {
    const p = errnoFn();
    return p ? read.i32(p) : 0;
  };

  return {
    tryLock(path: string): HeldLock | null {
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
      const rc = symbols.flock(fd, LOCK_EX | LOCK_NB);
      if (rc === 0) {
        let released = false;
        return {
          path,
          release() {
            if (released) return;
            released = true;
            symbols.flock(fd, LOCK_UN);
            closeSync(fd);
          },
        };
      }
      const code = errno();
      closeSync(fd);
      if (code === EWOULDBLOCK || code === EINTR) return null;
      throw new LockError(`flock failed (errno ${code})`, path, code);
    },
  };
}

// --- windows ---------------------------------------------------------------------------------

const GENERIC_READ_WRITE = 0xc0000000;
const FILE_SHARE_ALL = 0x7; // READ | WRITE | DELETE
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const ERROR_LOCK_VIOLATION = 33;
const INVALID_HANDLE_VALUE = -1n;

function windowsBackend(): Backend {
  const lib = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    LockFileEx: {
      args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UnlockFileEx: {
      args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const k = lib.symbols;

  return {
    tryLock(path: string): HeldLock | null {
      const wide = Buffer.from(`${path}\0`, "utf16le");
      const handle = k.CreateFileW(
        wide,
        GENERIC_READ_WRITE,
        FILE_SHARE_ALL,
        null,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        null,
      ) as bigint;
      if (handle === INVALID_HANDLE_VALUE) {
        const code = k.GetLastError() as number;
        throw new LockError(`CreateFileW failed (error ${code})`, path, code);
      }
      // OVERLAPPED is 32 bytes on x64/arm64; zero Offset/OffsetHigh selects byte 0.
      const overlapped = Buffer.alloc(32);
      const ok = k.LockFileEx(
        handle,
        LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0,
        1,
        0,
        overlapped,
      ) as number;
      if (ok !== 0) {
        let released = false;
        return {
          path,
          release() {
            if (released) return;
            released = true;
            k.UnlockFileEx(handle, 0, 1, 0, Buffer.alloc(32));
            k.CloseHandle(handle);
          },
        };
      }
      const code = k.GetLastError() as number;
      k.CloseHandle(handle);
      if (code === ERROR_LOCK_VIOLATION) return null;
      throw new LockError(`LockFileEx failed (error ${code})`, path, code);
    },
  };
}

// --- public API ------------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignal(opts: LockOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  if (opts.timeoutMs !== undefined) signals.push(AbortSignal.timeout(opts.timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/**
 * Take the exclusive OS lock on `path`, polling every 20 ms while another process (or another
 * descriptor in this process) holds it. Creates the parent directory (0755) and the file (0600).
 * Rejects with the signal's reason if aborted or timed out first.
 */
export async function acquireFileLock(path: string, opts: LockOptions = {}): Promise<HeldLock> {
  const signal = combineSignal(opts);
  if (signal?.aborted) throw signal.reason;
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const be = loadBackend();
  const poll = opts.pollMs ?? LOCK_POLL_MS;
  for (;;) {
    const held = be.tryLock(path);
    if (held) return held;
    await sleep(poll, signal);
  }
}

/** Non-blocking attempt: the held lock, or null when somebody else holds it. */
export function tryAcquireFileLock(path: string): HeldLock | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  return loadBackend().tryLock(path);
}

// In-process queue per lock file. flock locks conflict between descriptors of one process too, so
// without this, same-process callers would burn the 20 ms poll against each other. Waiters are
// served in order and an aborted waiter leaves the queue.
const queues = new Map<string, Promise<void>>();

/**
 * Run `fn` while holding the exclusive cross-process lock on `path`. Callers in this process queue
 * in FIFO order; other processes (including the Go binary) are arbitrated by the OS lock.
 * Not re-entrant: acquiring the same path inside `fn` waits forever, exactly as in Go.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => T | Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const signal = combineSignal(opts);
  const previous = queues.get(path) ?? Promise.resolve();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const tail = previous.then(() => gate);
  queues.set(path, tail);
  tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path);
  });

  try {
    // Wait for our turn in-process, or leave the queue if aborted first.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      previous.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    const held = await acquireFileLock(
      path,
      signal ? { ...opts, signal, timeoutMs: undefined } : opts,
    );
    try {
      return await fn();
    } finally {
      held.release();
    }
  } finally {
    openGate();
  }
}
