// Port of internal/codegen/skill_sync.go (the skill half) and the instruction-file rendering in
// internal/cli/init.go + sync.go. Skills come from the generated embed of
// internal/instructions/skills, so a sync writes the bytes Go embeds.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { guidelineFiles, skillFiles } from "./embedded.generated.ts";

export { guidelineFiles, skillFiles };

// --- embedded skills ---------------------------------------------------------------------------

/** listSkillDirs: top-level embedded directories holding a SKILL.md, in name order. */
export function listSkillDirs(): string[] {
  const dirs = new Set<string>();
  for (const path of Object.keys(skillFiles)) {
    const slash = path.indexOf("/");
    if (slash > 0 && path.slice(slash + 1) === "SKILL.md") dirs.add(path.slice(0, slash));
  }
  return [...dirs].sort();
}

/** BuiltInSkillCount: the number of embedded built-in skills. */
export function builtInSkillCount(): number {
  return listSkillDirs().length;
}

/** The three platform skill directories under a root (project or home). */
export function skillRootsUnder(root: string): string[] {
  return [
    join(root, ".claude", "skills"),
    join(root, ".agents", "skills"),
    join(root, ".kiro", "skills"),
  ];
}

function skillEntries(skillDir: string): [string, string][] {
  const prefix = `${skillDir}/`;
  return Object.entries(skillFiles)
    .filter(([path]) => path.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function copySkill(skillDir: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true, mode: 0o755 });
  for (const [path, content] of skillEntries(skillDir)) {
    const target = join(dst, ...path.slice(skillDir.length + 1).split("/"));
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(target, content);
  }
}

function copySkillsInto(targetDir: string): void {
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw new Error(`create target dir ${targetDir}: ${(e as Error).message}`);
  }
  for (const skillDir of listSkillDirs()) {
    const dst = join(targetDir, skillDir);
    try {
      copySkill(skillDir, dst);
    } catch (e) {
      throw new Error(`copy skill ${skillDir} to ${targetDir}: ${(e as Error).message}`);
    }
  }
}

const needsClaudeSkills = (p: string) => p === "claude-code";
const needsAgentSkills = (p: string) =>
  ["agents", "opencode", "antigravity", "codex", "cursor", "gemini", "hermes"].includes(p);
const needsKiroSkills = (p: string) => p === "kiro";

/**
 * SyncSkillsForPlatforms: copy the embedded skills only to the directories the platforms need;
 * an empty list means every directory.
 */
export function syncSkillsForPlatforms(projectRoot: string, platforms: readonly string[]): void {
  let wantClaude = platforms.length === 0;
  let wantAgent = platforms.length === 0;
  let wantKiro = platforms.length === 0;
  for (const p of platforms) {
    if (needsClaudeSkills(p)) wantClaude = true;
    if (needsAgentSkills(p)) wantAgent = true;
    if (needsKiroSkills(p)) wantKiro = true;
  }
  const targets: string[] = [];
  if (wantClaude) targets.push(join(projectRoot, ".claude", "skills"));
  if (wantAgent) targets.push(join(projectRoot, ".agents", "skills"));
  if (wantKiro) targets.push(join(projectRoot, ".kiro", "skills"));
  for (const t of targets) copySkillsInto(t);
}

/**
 * SyncSkillsToTargets: targets are keyed by platform name with absolute directories. Go iterates
 * a map, so the order is unspecified there; insertion order is used here.
 */
export function syncSkillsToTargets(targets: Record<string, string>): void {
  for (const [platform, dir] of Object.entries(targets)) {
    if (!needsClaudeSkills(platform) && !needsAgentSkills(platform) && !needsKiroSkills(platform)) {
      continue;
    }
    copySkillsInto(dir);
  }
}

/** SyncSkills: every platform directory. */
export function syncSkills(projectRoot: string): void {
  syncSkillsForPlatforms(projectRoot, []);
}

function dirIsStale(dir: string, skillDirs: string[]): boolean {
  for (const skillDir of skillDirs) {
    const embedded = skillFiles[`${skillDir}/SKILL.md`];
    if (embedded === undefined) continue;
    let disk: Buffer;
    try {
      disk = readFileSync(join(dir, skillDir, "SKILL.md"));
    } catch {
      return true;
    }
    if (!disk.equals(Buffer.from(embedded, "utf8"))) return true;
  }
  return false;
}

/** StaleSkillDirs: existing directories whose skill copies differ from the embedded set. */
export function staleSkillDirs(dirs: readonly string[]): string[] {
  const skillDirs = listSkillDirs();
  if (skillDirs.length === 0) return [];
  return dirs.filter((dir) => {
    try {
      if (!statSync(dir).isDirectory()) return false;
    } catch {
      return false;
    }
    return dirIsStale(dir, skillDirs);
  });
}

/** SkillsOutOfSync: any project-level platform directory that drifted. */
export function skillsOutOfSync(projectRoot: string): boolean {
  return staleSkillDirs(skillRootsUnder(projectRoot)).length > 0;
}

// --- instruction files -------------------------------------------------------------------------

export const GUIDELINES_MARKER_START = "<!-- KNOWNS GUIDELINES START -->";
export const GUIDELINES_MARKER_END = "<!-- KNOWNS GUIDELINES END -->";

function compatibilityInstructionTitle(
  relativePath: string,
  platform: string,
  projectName: string,
): string {
  switch (relativePath) {
    case "AGENTS.md":
      return "AGENTS";
    case "CLAUDE.md":
      return "CLAUDE";
    case "GEMINI.md":
      return "GEMINI";
    case "OPENCODE.md":
      return "OPENCODE";
    case join(".github", "copilot-instructions.md"):
      return `${projectName} - GitHub Copilot Instructions`;
    default:
      return platform;
  }
}

/** renderCompatibilityInstructionContent: the managed shim text for one instruction file. */
export function generateInstructionContent(
  relativePath: string,
  platform: string,
  projectRoot: string,
): string {
  const projectName = basename(projectRoot);
  return [
    `# ${compatibilityInstructionTitle(relativePath, platform, projectName)}\n\n`,
    `Compatibility entrypoint for runtimes that auto-detect \`${relativePath}\`.\n\n`,
    `${GUIDELINES_MARKER_START}\n\n`,
    '**CRITICAL: Start with Knowns MCP `initial` when available. Use `help("tool.*")` or `help("workflow.*")` for domain details on demand.**\n\n',
    "## Runtime Guidance\n\n",
    "- Knowns is the repository memory layer for humans and the AI-friendly working layer for agents.\n",
    "- MCP `initial` is the primary AI bootstrap: project state, tool domains, code rules, and workflow routing.\n",
    "- MCP `help` is the primary on-demand source for action schemas and recipes.\n",
    "- Treat this file only as a lightweight compatibility entrypoint.\n\n",
    "## Minimum Rules\n\n",
    "- Use Knowns as the canonical system for tasks, docs, templates, and workflow state.\n",
    "- Never manually edit Knowns-managed task or doc markdown.\n",
    "- Search first, then read only relevant docs and code.\n",
    "- Use `search` for discovery; use MCP `retrieve` tool when a workflow needs structured context with citations. Fall back to CLI `knowns retrieve` if MCP is unavailable.\n",
    '- For code operations, use `code` tool: `find`/`symbols` for structure, `references`/`definition` for navigation, `rename`/`replace`/`replace_body`/`insert`/`delete` for editing. Use `help("code.*")` or `help("workflow.code-edit")` for details.\n',
    "- Plan before implementation unless the user explicitly overrides that workflow.\n",
    "- Validate before considering work complete.\n",
    "- A Memory is a fact the NEXT session needs, written from an outcome you reached. Never from a phrase in a request: a prompt is a request, not a conclusion. If an entry carries nothing beyond the message that prompted it, it is not a Memory.\n",
    "- `pattern`, `convention` and `failure` are claims about the code, so cite something checkable: a symbol, `@doc/<path>` or `@task-<id>`, never a line number. `preference` is the user's own commitment, so cite who said it and when, and give it a `**Why:**` line; the reason is the only thing that lets a rule apply to a case it does not name.\n",
    '- Read with `memory({ action: "list" })` at session start. Write with `memory({ action: "add" })` when work settles something durable: a write nothing conflicts with is live at once, while one matching an existing Memory comes back for review instead of overwriting it.\n\n',
    "## Quick Reference\n\n",
    "```bash\n",
    "knowns doc list --plain               # List docs\n",
    "knowns task list --plain              # List tasks\n",
    "knowns task <id> --plain              # View task\n",
    'knowns doc "<path>" --plain --smart  # View doc\n',
    'knowns search "query" --plain        # Search docs/tasks\n',
    'knowns retrieve "query" --json      # Retrieve structured context pack (CLI fallback)\n',
    "```\n\n",
    `${GUIDELINES_MARKER_END}\n`,
  ].join("");
}

/**
 * syncInstructionMarkerBlock: replace only the managed block of an existing instruction file,
 * keeping user content outside the markers (read and written as latin1 so foreign bytes survive). A file without a valid marker pair gets the block
 * appended.
 */
export function syncInstructionMarkerBlock(filePath: string, newContent: string): void {
  let oldText: string;
  try {
    oldText = readFileSync(filePath).toString("latin1");
  } catch {
    writeFileSync(filePath, newContent);
    return;
  }
  const startIdx = oldText.indexOf(GUIDELINES_MARKER_START);
  const endIdx = oldText.indexOf(GUIDELINES_MARKER_END);
  const newStart = newContent.indexOf(GUIDELINES_MARKER_START);
  const newEnd = newContent.indexOf(GUIDELINES_MARKER_END);
  const newHasBlock = newStart >= 0 && newEnd >= 0 && newEnd > newStart;

  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    if (!newHasBlock) {
      writeFileSync(filePath, newContent);
      return;
    }
    const block = newContent.slice(newStart, newEnd + GUIDELINES_MARKER_END.length);
    let separator = "\n\n";
    if (oldText.endsWith("\n\n")) separator = "";
    else if (oldText.endsWith("\n")) separator = "\n";
    writeFileSync(filePath, Buffer.from(`${oldText}${separator}${block}\n`, "latin1"));
    return;
  }
  if (!newHasBlock) {
    writeFileSync(filePath, newContent);
    return;
  }
  const newBlock = newContent.slice(newStart, newEnd + GUIDELINES_MARKER_END.length);
  const oldBlock = oldText.slice(startIdx, endIdx + GUIDELINES_MARKER_END.length);
  if (newBlock === oldBlock) return;
  writeFileSync(
    filePath,
    Buffer.from(
      oldText.slice(0, startIdx) + newBlock + oldText.slice(endIdx + GUIDELINES_MARKER_END.length),
      "latin1",
    ),
  );
}

/** Whether a path exists (any file type). */
export function pathExists(path: string): boolean {
  return existsSync(path);
}
