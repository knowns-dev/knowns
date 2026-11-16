// The runtime daemon is a background service: it runs below normal priority so that indexing and
// watching never compete with what the user is doing. The LSP daemon is NOT lowered: it answers
// interactive `code` requests, as do its language servers and the managed Qdrant that serves vector
// searches, so those children get their priority back (see restoreNormalPriority).
// os.setPriority(0, 10) is nice +10 on macOS and Linux and BELOW_NORMAL_PRIORITY_CLASS on Windows.
// Children inherit it (nice is inherited; Windows keeps BELOW_NORMAL for child processes), which is
// intended for background children such as git for store sync.
import { setPriority } from "node:os";

export const BACKGROUND_PRIORITY = 10;

/** Lowers this process's priority. Returns false when the platform refuses (never throws). */
export function lowerProcessPriority(
  env: Record<string, string | undefined> = process.env,
  set: (pid: number, priority: number) => void = setPriority,
): boolean {
  if (env.KNOWNS_RUNTIME_NORMAL_PRIORITY === "1") return false;
  try {
    set(0, BACKGROUND_PRIORITY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives a child that serves interactive requests normal priority again. Raising priority needs
 * privilege on Linux and macOS (a plain user cannot lower a nice value), so it works on Windows and
 * for privileged users and is a no-op elsewhere; it never throws.
 */
export function restoreNormalPriority(
  pid: number,
  set: (pid: number, priority: number) => void = setPriority,
): boolean {
  try {
    set(pid, 0);
    return true;
  } catch {
    return false;
  }
}
