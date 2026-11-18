// A file-identity signature for caches that skip rereading an unchanged file.
//
// Two writes of the same size inside one timestamp tick (a Linux jiffy, a Windows tick, 2 s on FAT
// and coarse on SMB/NFS) leave an identical mtime, so a signature alone cannot prove "unchanged"
// for a file touched moments ago. Like git's racy-timestamp rule, a signature is only issued for a
// file whose mtime and ctime are older than RACY_WINDOW_MS; a recently touched file has no
// signature, so it is always reread and never cached. The numbers come from { bigint: true } stats,
// because a Number inode or nanosecond time rounds on Windows (NTFS file ids exceed 2^53).
import type { BigIntStats } from "node:fs";

export const RACY_WINDOW_MS = 3000;

/** KNOWNS_STAT_RACY_MS overrides the window (tests use -1 to exercise the cache on fresh files). */
function racyWindowMs(): number {
  const raw = process.env.KNOWNS_STAT_RACY_MS;
  return raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : RACY_WINDOW_MS;
}

/**
 * The same signature without the racy gate, for a writer that holds the file's lock and knows the
 * content it just wrote (the queue's write-through cache). Never use it for a lock-free reader.
 */
export function statSignatureStrict(st: BigIntStats): string {
  return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
}

/** The signature of a stat taken with { bigint: true }, or undefined while the file is racy. */
export function statSignature(st: BigIntStats, now: number = Date.now()): string | undefined {
  const horizon = BigInt(Math.trunc(now - racyWindowMs()));
  if (st.mtimeMs >= horizon || st.ctimeMs >= horizon) return undefined;
  return statSignatureStrict(st);
}
