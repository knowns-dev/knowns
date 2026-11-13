// errors.Join and errors.As over TypeScript errors: a Joined error exposes every member, and the
// helpers walk both `cause` chains and joined members.

/** errors.Join: members' messages joined by a newline. */
export class JoinedError extends Error {
  override readonly name = "JoinedError";
  constructor(readonly errors: Error[]) {
    super(errors.map((e) => e.message).join("\n"));
  }
}

/** errors.Join(...errs): undefined when there is nothing to join. */
export function joinErrors(errs: (Error | undefined)[]): Error | undefined {
  const list = errs.filter((e): e is Error => e !== undefined);
  if (list.length === 0) return undefined;
  return new JoinedError(list);
}

/** Wraps with `%w` semantics: the message gets a prefix, the cause stays reachable. */
export function wrap(prefix: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${prefix}: ${message}`, { cause });
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** errors.As: the first error in the cause/joined tree that satisfies `match`. */
export function findError<T extends Error>(
  err: unknown,
  match: (e: Error) => e is T,
): T | undefined {
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth: number): T | undefined => {
    if (!(e instanceof Error) || seen.has(e) || depth > 32) return undefined;
    seen.add(e);
    if (match(e)) return e;
    if (e instanceof JoinedError) {
      for (const member of e.errors) {
        const found = visit(member, depth + 1);
        if (found) return found;
      }
    }
    return visit(e.cause, depth + 1);
  };
  return visit(err, 0);
}

/** Go's isNotFound: any error whose text contains "not found". */
export function isNotFound(err: unknown): boolean {
  return err !== undefined && err !== null && toError(err).message.includes("not found");
}

const partials = new WeakMap<object, unknown>();

/**
 * Go methods return (value, err) with a meaningful partial value; here the error is thrown and the
 * partial value rides on it. Read it back with `partialOf`.
 */
export function withPartial<E extends Error>(err: E, value: unknown): E {
  partials.set(err, value);
  return err;
}

export function partialOf<T>(err: unknown): T | undefined {
  return err instanceof Error ? (partials.get(err) as T | undefined) : undefined;
}
