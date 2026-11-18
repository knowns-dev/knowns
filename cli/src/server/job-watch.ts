// A server that does not run the daemon loop (`knowns browser --foreground`, the D6 fallback) still
// shows job changes live: one fs.watch on the runtime queues directory, debounced, then the job
// source re-reads the queues and reports the diff (spec activity-tray, NFR-4). No polling, and it
// exists only while an event stream is open.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { dirname } from "node:path";
import { queuePath } from "../runtime/queue.ts";

export const JOB_WATCH_DEBOUNCE_MS = 100;

export function watchJobQueues(poke: () => void, debounceMs = JOB_WATCH_DEBOUNCE_MS): () => void {
  const dir = dirname(queuePath("x"));
  let w: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const fire = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) poke();
    }, debounceMs);
    timer.unref?.();
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    w = watch(dir, { persistent: false }, fire);
    w.on("error", () => {
      try {
        w?.close();
      } catch {
        // already closed
      }
      w = undefined;
    });
  } catch {
    // no watch: the snapshot on connect still shows the queue
  }
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      w?.close();
    } catch {
      // already closed
    }
  };
}
