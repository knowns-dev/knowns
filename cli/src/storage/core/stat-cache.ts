// A parse cache validated by the file's own stat, for read-only consumers that would otherwise
// reread and reparse every file on every call (keyword search over a store with hundreds of tasks).
//
// A hit needs the same identity the OS gives a file version: inode, size and the nanosecond mtime
// and ctime. Every canonical write in this codebase goes through atomicWrite (temp file + rename),
// which gives the new version a new inode and mtime. That is not enough on its own: inode numbers
// are reused after a rename, and timestamps tick coarsely (about 15 ms on Windows, 10 ms to 2 s on
// FAT, SMB and NFS), so a same-size rewrite inside one tick can look identical (an agent ticking
// `- [ ]` to `- [x]` and searching at once). Git's racy-timestamp rule closes that gap: an entry
// whose file was modified less than RACY_MARGIN_MS before the entry was cached cannot be trusted
// and is read again, so only files that have been quiet for a moment are ever served from memory.
//
// The racy rule is the shared one in stat-signature.ts: a file touched within its window gets no
// signature, so it is read again and never cached.
//
// Memory is bounded by an approximate byte budget with least-recently-used eviction. A listing
// pass (see `pass`) drops the entries of files that no longer exist under its directory.
//
// Entries are advisory: a miss, an error or `clear()` is always safe, only slower. Values are shared
// between callers and are deep-frozen so no caller can corrupt them for the others.
import { type BigIntStats, statSync } from "node:fs";
import { RACY_WINDOW_MS, statSignature } from "./stat-signature.ts";

export { RACY_WINDOW_MS };
/** Default budget for the parsed values (the lexical memo built on them is about as large again). */
export const DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024;
/** Parsed objects take several times the file's bytes; a floor covers small files. */
const costOf = (fileBytes: bigint): number => Number(fileBytes) * 4 + 512;

interface Entry<T> {
  sig: string;
  cost: number;
  value: T;
}

export interface StatCacheOptions {
  budgetBytes?: number;
  /** The clock, for tests. */
  now?: () => number;
  /** Key paths the Windows way (case-insensitive, either separator); tests force it on. */
  windows?: boolean;
}

/** Freezes an object graph so a shared value cannot be changed by a later stage. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value; // a typed array cannot be frozen
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return value;
}

let clock: () => number = Date.now;

/** Replaces the clock caches created without their own use (tests; undefined restores it). */
export function setCacheClock(now: (() => number) | undefined): void {
  clock = now ?? Date.now;
}

export class StatCache<T> {
  // Map order is recency order: a hit moves the entry to the end, eviction takes from the front.
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;
  private readonly budget: number;
  private readonly now: () => number;
  private readonly windows: boolean;

  /**
   * The key of a path. On Windows a prefix written with "/" must match keys written with "\\", and
   * NTFS ignores case, so both are folded; elsewhere the path is the key.
   */
  private key(path: string): string {
    return this.windows ? path.replaceAll("\\", "/").toLowerCase() : path;
  }

  constructor(opts: StatCacheOptions = {}) {
    this.windows = opts.windows ?? process.platform === "win32";
    this.budget = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    this.now = opts.now ?? (() => clock());
  }

  get size(): number {
    return this.entries.size;
  }

  /** Approximate bytes held. */
  get cost(): number {
    return this.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** Forgets every entry under a directory (a project was closed or switched away from). */
  dropPrefix(prefix: string): void {
    const p = this.key(prefix);
    for (const [path, e] of [...this.entries]) {
      if (path.startsWith(p)) this.remove(path, e);
    }
  }

  /**
   * A listing pass over one directory tree: reads go through the cache, and `end()` forgets the
   * entries under `prefix` that the pass did not touch (deleted or moved files).
   */
  pass(prefix: string): { read: (path: string, parse: () => T) => T; end: () => void } {
    const touched = new Set<string>();
    const p = this.key(prefix);
    return {
      read: (path, parse) => {
        touched.add(this.key(path));
        return this.read(path, parse);
      },
      end: () => {
        for (const [path, e] of [...this.entries]) {
          if (path.startsWith(p) && !touched.has(path)) this.remove(path, e);
        }
      },
    };
  }

  /** The cached value for path while its file is unchanged; otherwise parse() and remember. */
  read(pathIn: string, parse: () => T): T {
    const path = this.key(pathIn);
    let st: BigIntStats;
    try {
      st = statSync(pathIn, { bigint: true });
    } catch {
      this.forget(path);
      return parse(); // let parse report the missing or unreadable file the way it always did
    }
    // No signature while the file is racy (touched moments ago): read it again, cache nothing.
    const sig = statSignature(st, this.now());
    if (sig === undefined) {
      this.forget(path);
      return deepFreeze(parse());
    }
    const hit = this.entries.get(path);
    if (hit && hit.sig === sig) {
      this.entries.delete(path); // most recently used
      this.entries.set(path, hit);
      return hit.value;
    }
    // Stat first, parse second: a write landing in between makes the entry look stale on the next
    // call (its stat differs from the one stored), never fresh.
    const value = deepFreeze(parse());
    this.forget(path);
    const entry: Entry<T> = { sig, cost: costOf(st.size), value };
    this.entries.set(path, entry);
    this.bytes += entry.cost;
    this.evict();
    return value;
  }

  private evict(): void {
    for (const [path, e] of this.entries) {
      if (this.bytes <= this.budget) break;
      this.remove(path, e);
    }
  }

  private forget(path: string): void {
    const e = this.entries.get(path);
    if (e) this.remove(path, e);
  }

  private remove(path: string, e: Entry<T>): void {
    this.entries.delete(path);
    this.bytes -= e.cost;
  }
}
