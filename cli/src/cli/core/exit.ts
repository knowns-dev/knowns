/** Exit-code plumbing (exit.go). */

/** Marks a command the user interrupted. */
export const ErrCommandCancelled = new Error("command cancelled");

/**
 * An error that carries its own process exit code. Commands without a custom contract exit 1.
 * Throw `exitError(code, cause)` from a handler to choose a different code.
 */
export class CommandExitError extends Error {
  constructor(
    readonly code: number,
    cause?: Error,
  ) {
    super(cause ? cause.message : "command completed with a non-zero status", { cause });
    this.name = "CommandExitError";
  }
}

export function exitError(code: number, cause?: Error): CommandExitError {
  return new CommandExitError(code, cause);
}

/** Maps a CLI error to a process exit code: the carried code, or 1. */
export function exitCode(err: unknown): number {
  if (err === undefined || err === null) return 0;
  let cur: unknown = err;
  for (let depth = 0; depth < 16 && cur instanceof Error; depth++) {
    if (cur instanceof CommandExitError) return cur.code;
    cur = cur.cause;
  }
  return 1;
}

/**
 * Thrown after a helper has already written its own diagnostic and only the exit status is left
 * (Go's `fmt.Fprintf(os.Stderr, ...); os.Exit(1)` sites). The run loop prints nothing for it.
 */
export class SilentExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "SilentExit";
  }
}
