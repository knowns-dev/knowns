// Pieces shared by init, setup and sync: git helpers and the post-init hints.
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandContext } from "../core/define.ts";
import { StyleDim } from "../core/plainoutput.ts";

/** isGitRepo: a .git entry in dir or any parent. */
export function isGitRepo(dir: string): boolean {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, ".git"))) return true;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

/** Whether the project already has AI integration files (hasExistingAIIntegrationFiles). */
export function hasExistingAiIntegrationFiles(projectRoot: string): boolean {
  const paths = [
    "CLAUDE.md",
    "OPENCODE.md",
    "GEMINI.md",
    "AGENTS.md",
    join(".github", "copilot-instructions.md"),
    join(".kiro", "steering", "knowns.md"),
    join(".kiro", "settings", "mcp.json"),
  ];
  return paths.some((rel) => {
    try {
      statSync(join(projectRoot, rel));
      return true;
    } catch {
      return false;
    }
  });
}

/** printSetupSuggestion. */
export function printSetupSuggestion(ctx: CommandContext, projectRoot: string): void {
  ctx.print(
    `${StyleDim.render(
      hasExistingAiIntegrationFiles(projectRoot)
        ? "  Run 'knowns setup all' to update existing AI tool integrations"
        : "  Run 'knowns setup all' to configure AI tool integrations",
    )}\n`,
  );
}
