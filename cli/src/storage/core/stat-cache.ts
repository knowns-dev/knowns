// A parse cache validated by the file's own stat, for read-only consumers that would otherwise
// reread and reparse every file on every call (keyword search over a store with hundreds of tasks).
//
// A hit needs the same device-independent identity the OS gives a file version: inode, size and the
// nanosecond mtime and ctime. Every canonical write in this codebase goes through atomicWrite
// (temp file + rename), which gives the new version a new inode and mtime, and an in-place edit
// changes mtime and ctime, so a stale entry is only possible if a file is rewritten with the same
// size inside one timestamp tick of the filesystem; the entries are therefore advisory: callers must
// treat a miss, an error or `clear()` as always safe, because the answer is the same, only slower.
//
// Values are shared between callers and must be treated as read-only.
import { type BigIntStats, statSync } from "node:fs";

interface Entry<T> {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  value: T;
}

export class StatCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  /** maxEntries bounds memory: past it the cache is dropped and refills from the files. */
  constructor(private readonly maxEntries = 20_000) {}

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** The cached value for path while its file is unchanged; otherwise parse() and remember. */
  read(path: string, parse: () => T): T {
    let st: BigIntStats;
    try {
      st = statSync(path, { bigint: true });
    } catch {
      this.entries.delete(path);
      return parse(); // let parse report the missing or unreadable file the way it always did
    }
    const hit = this.entries.get(path);
    if (
      hit &&
      hit.ino === st.ino &&
      hit.size === st.size &&
      hit.mtimeNs === st.mtimeNs &&
      hit.ctimeNs === st.ctimeNs
    ) {
      return hit.value;
    }
    // Stat first, parse second: a write landing in between makes the entry look stale on the next
    // call (its stat differs from the one stored), never fresh.
    const value = parse();
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(path, {
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      ctimeNs: st.ctimeNs,
      value,
    });
    return value;
  }
}
