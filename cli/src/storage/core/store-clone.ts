// Port of internal/storage/store_clone.go: the managed block of a store clone's .gitignore.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE_IGNORE_BEGIN = "# >>> knowns: machine-local state, never synced (store spec D1) >>>";
const STORE_IGNORE_END = "# <<< knowns <<<";

/** Paths a store keeps out of git: rebuildable indexes, local history, machine-local state. */
export const STORE_IGNORE_PATTERNS = [
  "**/.search/",
  "**/history/",
  "**/time.json",
  "**/time-entries.json",
  "**/workspaces.json",
  "**/chats.json",
  "**/.server-port",
] as const;

/**
 * EnsureStoreGitignore: make the .gitignore at the root of a store clone carry the managed block
 * of STORE_IGNORE_PATTERNS, preserving every other line. Returns whether the file changed.
 */
export function ensureStoreGitignore(cloneRoot: string): boolean {
  const path = join(cloneRoot, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`read ${path}: ${(e as Error).message}`);
    }
  }

  const block = `${STORE_IGNORE_BEGIN}\n${STORE_IGNORE_PATTERNS.join("\n")}\n${STORE_IGNORE_END}\n`;
  let content = existing;
  const start = content.indexOf(STORE_IGNORE_BEGIN);
  if (start >= 0) {
    const endRel = content.indexOf(STORE_IGNORE_END, start);
    if (endRel < 0) {
      throw new Error(
        `${path} has an unterminated knowns block; restore the "${STORE_IGNORE_END}" line`,
      );
    }
    let end = endRel + STORE_IGNORE_END.length;
    if (end < content.length && content[end] === "\n") end++;
    content = content.slice(0, start) + block + content.slice(end);
  } else {
    if (content !== "" && !content.endsWith("\n")) content += "\n";
    content += block;
  }

  if (content === existing) return false;
  writeFileSync(path, content, { mode: 0o644 });
  return true;
}
