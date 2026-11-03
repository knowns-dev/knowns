// MutationConflictError and DocIdentityConflictError (version_store.go): content-free
// optimistic-concurrency failures. Both satisfy errors.Is(err, ErrHistoryConflict).
import { HistoryConflictError } from "./records.ts";

/** Go's %q for the identifiers and hashes that appear in these messages. */
export function goQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * MutationConflictError is a content-free optimistic-concurrency failure. Only entity identity and
 * hashes are exposed so callers can safely log or return it from public APIs.
 */
export class MutationConflictError extends HistoryConflictError {
  override readonly name: string = "MutationConflictError";
  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly expectedHash: string,
    readonly currentHash: string,
  ) {
    super();
    this.message = `${entityType} ${goQuote(entityId)} mutation conflict: expected hash ${goQuote(expectedHash)}, current hash ${goQuote(currentHash)}`;
  }
}

/** DocIdentityConflictError: an attempted stable-ID reassignment; never exposes content. */
export class DocIdentityConflictError extends HistoryConflictError {
  override readonly name: string = "DocIdentityConflictError";
  constructor(
    readonly entityId: string,
    readonly requestedId: string,
  ) {
    super();
    this.message = `doc ${goQuote(entityId)} stable identity cannot be changed to ${goQuote(requestedId)}`;
  }
}

export function isMutationConflict(err: unknown): err is MutationConflictError {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 16; depth++) {
    if (e instanceof MutationConflictError) return true;
    e = e.cause;
  }
  return false;
}

/** errors.As(err, &MutationConflictError). */
export function asMutationConflict(err: unknown): MutationConflictError | undefined {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 16; depth++) {
    if (e instanceof MutationConflictError) return e;
    e = e.cause;
  }
  return undefined;
}
