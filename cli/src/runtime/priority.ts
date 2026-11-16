// The runtime and LSP daemons are background services: they run below normal priority so that
// indexing, watching and language servers never compete with what the user is doing.
// os.setPriority(0, 10) is nice +10 on macOS and Linux and BELOW_NORMAL_PRIORITY_CLASS on Windows.
// Children inherit it (nice is inherited; Windows keeps BELOW_NORMAL for child processes), which is
// intended for what the daemons spawn: language servers, git for store sync, managed Qdrant.
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
