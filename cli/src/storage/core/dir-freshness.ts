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
import { statSignature } from "./stat-signature.ts";

export const DEFAULT_MAX_AGE_MS = 2000;

export interface FreshnessOptions {
  maxAgeMs?: number;
  now?: () => number;
}

/** The signature of one directory; "missing" when it does not exist (its creation changes it). */
function dirSignature(dir: string, now: number): string | undefined {
  try {
    return statSignature(statSync(dir, { bigint: true }), now);
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
  private readonly now: () => number;
  private watchers: FSWatcher[] = [];
  private watching = "";

  constructor(opts: FreshnessOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
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
      if (dirSignature(dir, now) !== sig) return false;
    }
    return true;
  }

  /** Call before a scan of `dirs`. Clears the dirty flag: an event during the scan sets it again. */
  begin(dirs: string[]): Pass {
    this.dirty = false;
    const now = this.now();
    const sigs = new Map<string, string>();
    for (const dir of dirs) {
      const s = dirSignature(dir, now);
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
