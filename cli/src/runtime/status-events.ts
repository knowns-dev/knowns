// A change in what `runtime ps` shows (leases, projects, watchers, queued or running jobs), as an
// event. The daemon loop reports its status key and queue fingerprint every tick; listeners hear
// about it only when either changed, never for the periodic status refresh. The daemon-served UI
// forwards it to open tabs so the Runtime page does not have to poll for it.
const listeners = new Set<() => void>();
let last: string | undefined;

/** Returns the unsubscribe function. */
export function onRuntimeStatusChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Called by the daemon loop each tick with the pieces that make up the visible status. */
export function emitRuntimeStatus(statusKey: string, queueFingerprint: string): void {
  const sig = `${statusKey}\u0000${queueFingerprint}`;
  if (last === undefined) {
    last = sig; // the first tick is the baseline, not a change
    return;
  }
  if (sig === last) return;
  last = sig;
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // a listener must not break the loop
    }
  }
}
