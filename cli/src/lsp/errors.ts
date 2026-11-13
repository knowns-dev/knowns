// Error helpers that mirror Go's fmt.Errorf("%w") and errors.Is/As for the LSP module.

/** An error that wraps another one, like fmt.Errorf("...: %w", err). */
export class WrappedError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "WrappedError";
    this.cause = cause;
  }
}

/** Walks the cause chain the way errors.Is does. */
export function errorIs(err: unknown, target: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 32; depth++) {
    if (cur === target) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Walks the cause chain for the first instance of a class, like errors.As. */
export function errorAs<T>(err: unknown, ctor: new (...args: never[]) => T): T | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 32; depth++) {
    if (cur instanceof ctor) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The Go sentinel is errors.New; identity is what errors.Is compares, so keep one instance. */
export const ErrServerUnavailable: Error = new Error("LSP not available for this language");
export const ErrExtensionAlreadyRegistered: Error = new Error(
  "extension already registered for another language",
);

/** io.EOF: a protocol stream that closed while a reply was pending. */
export const EOF: Error = new Error("EOF");
