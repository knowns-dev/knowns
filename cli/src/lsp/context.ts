// Go's context.Context maps to an optional AbortSignal. A missing signal is context.Background().
export type Ctx = AbortSignal | undefined;

export function ctxErr(ctx: Ctx): Error | undefined {
  if (!ctx?.aborted) return undefined;
  const reason = ctx.reason;
  if (reason instanceof Error) return reason;
  return new Error("context canceled");
}

export function throwIfAborted(ctx: Ctx): void {
  const e = ctxErr(ctx);
  if (e) throw e;
}

/** context.WithTimeout: a signal that aborts when the parent does or after ms. */
export function withTimeout(parent: Ctx, ms: number): { ctx: AbortSignal; cancel: () => void } {
  const ac = new AbortController();
  const onParent = () => ac.abort(parent?.reason ?? new Error("context canceled"));
  if (parent?.aborted) onParent();
  else parent?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => ac.abort(new Error("context deadline exceeded")), ms);
  return {
    ctx: ac.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/** Rejects when ctx aborts; resolves with the promise otherwise. */
export function raceAbort<T>(ctx: Ctx, p: Promise<T>): Promise<T> {
  if (!ctx) return p;
  if (ctx.aborted) return Promise.reject(ctxErr(ctx));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(ctxErr(ctx));
    ctx.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        ctx.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        ctx.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function sleep(ms: number, ctx?: Ctx): Promise<void> {
  return raceAbort(ctx, new Promise<void>((r) => setTimeout(r, ms)));
}
