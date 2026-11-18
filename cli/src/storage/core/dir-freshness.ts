// Knows whether a set of directories still holds what a listing pass saw, without statting every
// file in them, so a long-lived listing (the server's task and doc index) can skip a rescan.
//
// Every canonical write here is atomicWrite (temp file + rename), which changes the mtime of the
// directory it lands in; a create, a delete and a rename do too. So an unchanged directory
// signature means no file was added, removed or replaced. Three things keep that honest:
//
//  - The racy rule of stat-signature.ts: a directory touched within the window has no signature,
//    so it is never "fresh" and every call rescans (a rescan stats files, it rereads only changed
//    ones). Coarse timestamps (Windows ticks, FAT, SMB) cannot hide a write behind a stale mtime.
//  - The signatures are taken BEFORE the scan (`begin`), so a write that lands during the scan
//    makes the next check differ instead of being absorbed.
//  - An in-place edit (an editor saving without a rename) does not touch the directory. A watcher
//    marks the state dirty when it is alive, and `maxAgeMs` bounds how long a state may be trusted
//    even when it is not (the Linux Bun watcher on a recreated directory never fires).
//
// Everything is advisory: "not fresh" is always safe, only slower.
import { type FSWatcher, statSync, watch } from "node:fs";
import { RACY_WINDOW_MS, statSignatureStrict } from "./stat-signature.ts";

export const DEFAULT_MAX_AGE_MS = 2000;

/**
 * The racy window of a DIRECTORY. A directory whose mtime or ctime is newer than now minus this
 * has no signature, so it is rescanned, never trusted. Why a window and not just "mtime changed":
 * a directory's mtime is only as fine as the file system's clock. Measured on NTFS (Windows 11,
 * Bun 1.3.12): the directory mtime ticks every 15.6 ms, so a rename that follows another change
 * within one tick leaves the mtime as it was (30 of 40 back-to-back renames from another process
 * did not move it; with 10 ms or more between them none were missed). FAT, SMB and NFS tick in
 * 1 to 2 s. The window must cover the coarsest tick, so it is the one the file caches use: 3 s.
 * Inside it a request costs a stat pass of the files (reparsing none), after it nothing.
 * Unlike the file window it is not overridable to a negative value: a test that wants "quiet"
 * passes a clock (`now`) that is past the window instead of switching the rule off.
 */
export const DIR_RACY_MS = RACY_WINDOW_MS;

export interface FreshnessOptions {
  maxAgeMs?: number;
  racyMs?: number;
  now?: () => number;
}

/** The signature of one directory; "missing" when it does not exist (its creation changes it). */
function dirSignature(dir: string, now: number, racyMs: number): string | undefined {
  try {
    const st = statSync(dir, { bigint: true });
    const horizon = BigInt(Math.trunc(now - racyMs));
    if (st.mtimeMs >= horizon || st.ctimeMs >= horizon) return undefined;
    return statSignatureStrict(st);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : undefined;
  }
}

export interface Pass {
  /** Signatures of `dirs` taken before the scan; undefined when any was racy or unreadable. */
  sigs: Map<string, string> | undefined;
  dirs: string[];
}

export class DirFreshness {
  private committed: Map<string, string> | undefined;
  private at = 0;
  private dirty = false;
  private readonly maxAgeMs: number;
  private readonly racyMs: number;
  private readonly now: () => number;
  private watchers: FSWatcher[] = [];
  private watching = "";

  constructor(opts: FreshnessOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.racyMs = opts.racyMs ?? DIR_RACY_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Something may have changed (a watcher event or a write this process made). */
  markDirty(): void {
    this.dirty = true;
  }

  /** True while nothing changed since the last committed pass. Never true after `markDirty`. */
  fresh(): boolean {
    const c = this.committed;
    if (c === undefined || this.dirty) return false;
    const now = this.now();
    if (now - this.at > this.maxAgeMs || now < this.at) return false;
    for (const [dir, sig] of c) {
      if (dirSignature(dir, now, this.racyMs) !== sig) return false;
    }
    return true;
  }

  /** Call before a scan of `dirs`. Clears the dirty flag: an event during the scan sets it again. */
  begin(dirs: string[]): Pass {
    this.dirty = false;
    const now = this.now();
    const sigs = new Map<string, string>();
    for (const dir of dirs) {
      const s = dirSignature(dir, now, this.racyMs);
      if (s === undefined) return { sigs: undefined, dirs };
      sigs.set(dir, s);
    }
    return { sigs, dirs };
  }

  /**
   * Call after a scan. The pass is remembered only when the scan was clean (no file skipped) and
   * read exactly the directories `begin` signed; otherwise the next call scans again.
   */
  commit(pass: Pass, scannedDirs: Iterable<string>, clean: boolean): void {
    const scanned = new Set(scannedDirs);
    const same =
      pass.sigs !== undefined &&
      scanned.size === pass.dirs.length &&
      [...scanned].every((d) => pass.sigs?.has(d));
    if (!clean || !same || pass.sigs === undefined) {
      this.committed = undefined;
      return;
    }
    this.committed = pass.sigs;
    this.at = this.now();
  }

  /** Forgets everything: the next call scans. */
  reset(): void {
    this.committed = undefined;
  }

  /** Best-effort directory watches that mark this dirty; a failed or dead watch costs nothing. */
  watchDirs(dirs: string[]): void {
    const key = dirs.join("\0");
    if (key === this.watching) return;
    this.closeWatchers();
    this.watching = key;
    const self = new WeakRef(this);
    for (const dir of dirs) {
      try {
        const w = watch(dir, { persistent: false }, () => {
          const me = self.deref();
          if (me) me.markDirty();
          else w.close();
        });
        w.on("error", () => {});
        this.watchers.push(w);
      } catch {
        // the directory is missing or cannot be watched: the signatures still guard it
      }
    }
  }

  closeWatchers(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    this.watching = "";
  }
}

/** How long a path whose read keeps failing is still served from the previous scan. */
export const KEEP_PREVIOUS_MS = 2000;

export interface KeptEntry<T> {
  value: T;
  /** When this path's reads started failing; absent while they succeed. */
  badSince?: number;
}

/**
 * What one scan read, keyed by path, and what the scan before it had. A listing that drops an entry
 * because its file vanished between readdir and read (a rename, a replace, a locked file on
 * Windows) shows a gap that fills in a moment later; instead the scan keeps the previous entry,
 * counts the path as skipped (so the pass is not committed as fresh and the next call scans again)
 * and lets a later scan confirm the delete: the file is then absent from readdir. A path that keeps
 * failing for KEEP_PREVIOUS_MS (a corrupt file) is dropped like before.
 */
export interface ScanState<T> {
  skipped: number;
  previous?: ReadonlyMap<string, KeptEntry<T>>;
  seen: Map<string, KeptEntry<T>>;
}

export function newScanState<T>(previous?: ReadonlyMap<string, KeptEntry<T>>): ScanState<T> {
  return { skipped: 0, seen: new Map(), ...(previous && { previous }) };
}

export function readOrKeep<T>(
  st: ScanState<T>,
  path: string,
  read: () => T,
  now: number = Date.now(),
): T | undefined {
  try {
    const value = read();
    st.seen.set(path, { value });
    return value;
  } catch {
    st.skipped++;
    const prev = st.previous?.get(path);
    if (prev === undefined) return undefined;
    const since = prev.badSince ?? now;
    if (now - since > KEEP_PREVIOUS_MS) return undefined;
    st.seen.set(path, { value: prev.value, badSince: since });
    return prev.value;
  }
}
