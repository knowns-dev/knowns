// Dismissed tray rows of daemon jobs, kept across UI-server and runtime restarts. The queue files
// belong to the daemon (and to 0.34.x readers), so what a person dismissed lives in its own small
// file in the runtime root, shared by every UI server of this user.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../runtime/queue.ts";

export interface DismissStore {
  has(id: string): boolean;
  add(ids: string[]): void;
}

/** A dismissal is only needed while the job can still show: its queue entry and result are long gone after this. */
export const DISMISSED_KEEP_MS = 30 * 24 * 3_600_000;

/** Process memory only: the default of a registry that was given no store (tests, foreground use). */
export function memoryDismissals(): DismissStore {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add: (list) => {
      for (const id of list) ids.add(id);
    },
  };
}

type Stored = Record<string, number>;

function read(path: string, now: number): Stored {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { ids?: Stored };
    const out: Stored = {};
    for (const [id, at] of Object.entries(raw.ids ?? {})) {
      if (typeof at === "number" && now - at < DISMISSED_KEEP_MS) out[id] = at;
    }
    return out;
  } catch {
    return {}; // missing or unreadable: nothing is dismissed
  }
}

/**
 * The runtime-root file. Every read goes to the file (it is tiny and a second UI server may have
 * written it), every add is read-modify-write through a temp file and a rename.
 */
export function fileDismissals(
  path: string = join(runtimeRoot(), "dismissed-operations.json"),
  now: () => number = Date.now,
): DismissStore {
  return {
    has: (id) => id in read(path, now()),
    add: (list) => {
      const t = now();
      const cur = read(path, t);
      for (const id of list) cur[id] = t;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, ids: cur }));
        renameSync(tmp, path);
      } catch {
        // a failed save must not fail the dismiss: the row is gone for this process
      }
    },
  };
}
