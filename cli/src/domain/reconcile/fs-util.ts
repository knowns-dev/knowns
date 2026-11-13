// Filesystem helpers of internal/storage/reconciler.go: the stable read, the containment test and
// the Go-shaped errors the reconciler wraps its diagnostics in.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HistoryConflictError } from "../../storage/history/records.ts";

/** ErrReconcileUnsafe. */
export const RECONCILE_UNSAFE_MESSAGE = "filesystem reconciliation refused unsafe canonical input";

/** `fmt.Errorf("%w: ...", ErrReconcileUnsafe)`: errors.Is(err, ErrReconcileUnsafe) holds. */
export class ReconcileUnsafeError extends Error {
  override readonly name = "ReconcileUnsafeError";
  constructor(detail?: string) {
    super(
      detail === undefined ? RECONCILE_UNSAFE_MESSAGE : `${RECONCILE_UNSAFE_MESSAGE}: ${detail}`,
    );
  }
}

export function unsafe(detail: string): ReconcileUnsafeError {
  return new ReconcileUnsafeError(detail);
}

/** `fmt.Errorf("%w: ...", ErrHistoryConflict)`. */
export function conflict(detail: string): HistoryConflictError {
  return new HistoryConflictError(detail);
}

/** ErrNotTombstoned. */
export class NotTombstonedError extends Error {
  override readonly name = "NotTombstonedError";
  constructor(detail?: string) {
    super(
      detail === undefined ? "entity is not tombstoned" : `entity is not tombstoned: ${detail}`,
    );
  }
}

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EEXIST: "file exists",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  ENOTEMPTY: "directory not empty",
  EMFILE: "too many open files",
};

/** Go's `*PathError` text: `<op> <path>: <reason>`. */
export function pathErrorText(e: unknown, op: string, path: string): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const reason = (code && ERRNO_TEXT[code]) ?? (e as Error | undefined)?.message ?? String(e);
  return `${op} ${path}: ${reason}`;
}

/** os.IsNotExist. */
export function isNotExist(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Rethrows with Go's text for a filesystem failure; ENOENT stays detectable through `code`. */
export function asPathError(e: unknown, op: string, path: string): Error {
  const err = new Error(pathErrorText(e, op, path), { cause: e });
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code) (err as NodeJS.ErrnoException).code = code;
  return err;
}

/** filepath.Rel(root, path) inside a containment check: `rel != ".." && !HasPrefix(rel, "../")`. */
export function under(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** filepath.ToSlash. */
export function toSlash(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * stableRead: two reads bracketed by Lstat calls must agree on size, mtime and bytes, and none may
 * be a symlink. A file being written fails with "unexpected EOF" and is retried by a later pass.
 */
export function stableRead(path: string): Buffer {
  const stat = () => {
    try {
      return lstatSync(path, { bigint: true });
    } catch (e) {
      throw asPathError(e, "lstat", path);
    }
  };
  const read = () => {
    try {
      return readFileSync(path);
    } catch (e) {
      throw asPathError(e, "open", path);
    }
  };
  const first = stat();
  if (first.isSymbolicLink()) throw new Error("symlink");
  const a = read();
  const second = stat();
  const b = read();
  const third = stat();
  if (
    second.isSymbolicLink() ||
    third.isSymbolicLink() ||
    first.size !== second.size ||
    second.size !== third.size ||
    first.mtimeNs !== second.mtimeNs ||
    second.mtimeNs !== third.mtimeNs ||
    !a.equals(b)
  ) {
    throw new Error("unexpected EOF");
  }
  return a;
}

/** A tiny async mutex: sync.Mutex for code that awaits while holding it. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
