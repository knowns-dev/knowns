// Sentinel errors of internal/search, kept as classes so `errors.Is` through a wrapped chain
// becomes `errorChainHas`. Messages are the exact Go texts: they surface in the degraded notice.

export class SemanticUnavailableError extends Error {
  override name = "SemanticUnavailableError";
}

export class SemanticNotConfiguredError extends Error {
  override name = "SemanticNotConfiguredError";
  constructor() {
    super("semantic search not configured or disabled");
  }
}

export class SemanticRuntimeDisabledError extends Error {
  override name = "SemanticRuntimeDisabledError";
  constructor(reason?: string) {
    super(reason ? `semantic runtime disabled: ${reason}` : "semantic runtime disabled");
  }
}

/** fmt.Errorf("<prefix>: %w: %w", errSemanticUnavailable, cause). */
export function semanticUnavailable(prefix: string, cause?: unknown): SemanticUnavailableError {
  let message = `${prefix}: semantic search unavailable`;
  if (cause !== undefined) message += `: ${errorMessage(cause)}`;
  return new SemanticUnavailableError(message, cause === undefined ? undefined : { cause });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** errors.Is for a class sentinel: walks the `cause` chain. */
export function errorChainHas(
  err: unknown,
  ctor: abstract new (...args: never[]) => Error,
): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    if (cur instanceof ctor) return true;
    seen.add(cur);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}
