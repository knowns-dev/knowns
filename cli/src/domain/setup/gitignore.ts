// Port of writeKnownsGitignore and removeLegacyGitignoreBlock (internal/cli/init.go): the
// .knowns/.gitignore the git tracking settings imply.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitTracking, gitTrackingModeDefaults } from "../../models/config.ts";

export const KNOWNS_GITIGNORE_BEGIN = "# >>> KNOWNS >>>";
export const KNOWNS_GITIGNORE_END = "# <<< KNOWNS <<<";

/** removeLegacyGitignoreBlock: drop the old marker block from the root .gitignore. */
export function removeLegacyGitignoreBlock(dir: string): void {
  const path = join(dir, ".gitignore");
  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!existing.includes(KNOWNS_GITIGNORE_BEGIN)) return;
  let cleaned: string[] = [];
  let inside = false;
  for (const line of existing.split("\n")) {
    if (line.trim() === KNOWNS_GITIGNORE_BEGIN) {
      inside = true;
      continue;
    }
    if (line.trim() === KNOWNS_GITIGNORE_END) {
      inside = false;
      continue;
    }
    if (!inside) cleaned.push(line);
  }
  while (cleaned.length > 0 && (cleaned[cleaned.length - 1] as string).trim() === "") {
    cleaned = cleaned.slice(0, -1);
  }
  const content = cleaned.length > 0 ? `${cleaned.join("\n")}\n` : "";
  try {
    writeFileSync(path, content, { mode: 0o644 });
  } catch {
    // Go ignores the write error.
  }
}

/**
 * writeKnownsGitignore: .knowns/.gitignore for the tracking mode and per-section toggles (an
 * explicit toggle beats the mode default). Also removes the legacy root .gitignore block.
 */
export function writeKnownsGitignore(
  dir: string,
  mode: string,
  tracking: GitTracking | undefined,
): void {
  removeLegacyGitignoreBlock(dir);
  const knownsDir = join(dir, ".knowns");
  const gitignorePath = join(knownsDir, ".gitignore");
  if (mode === "git-tracked" || mode === "git-ignored") {
    mkdirSync(knownsDir, { recursive: true, mode: 0o755 });
  }
  const defaults = gitTrackingModeDefaults(mode);
  const gt: GitTracking = tracking ?? {};
  const tracked = (section: "tasks" | "docs" | "templates" | "memories" | "decisions"): boolean =>
    gt[section] ?? defaults[section];

  if (mode === "git-tracked") {
    let buf = "# Managed by Knowns CLI — do not edit manually.\n";
    buf += "# Run 'knowns init' to regenerate.\n\n";
    buf += "# Runtime & cache\n";
    buf += ".search/\n.working-memory/\nruntime/\nworktrees/\n.server-port\n.DS_Store\n";
    if (!tracked("tasks")) buf += "\n# Per-section tracking disabled\ntasks/\ntombstones/tasks/\n";
    if (!tracked("docs")) buf += "docs/\n";
    if (!tracked("templates")) buf += "templates/\n";
    if (!tracked("memories")) buf += "memories/\n";
    if (!tracked("decisions")) buf += "decisions/\n";
    writeFileSync(gitignorePath, buf, { mode: 0o644 });
    return;
  }
  if (mode === "git-ignored") {
    let buf = "# Managed by Knowns CLI — do not edit manually.\n";
    buf += "# Run 'knowns init' to regenerate.\n\n";
    buf += "# Ignore everything by default\n*\n\n";
    buf += "# Track these\n!.gitignore\n!config.json\n";
    if (tracked("docs")) buf += "!docs/\n!docs/**\n";
    if (tracked("templates")) buf += "!templates/\n!templates/**\n";
    if (tracked("tasks")) {
      buf += "!tasks/\n!tasks/**\n!tombstones/\n!tombstones/tasks/\n!tombstones/tasks/**\n";
    }
    if (tracked("memories")) buf += "!memories/\n!memories/**\n";
    if (tracked("decisions")) buf += "!decisions/\n!decisions/**\n";
    writeFileSync(gitignorePath, buf, { mode: 0o644 });
    return;
  }
  if (mode === "none") {
    if (existsSync(gitignorePath)) rmSync(gitignorePath, { force: true });
  }
}
