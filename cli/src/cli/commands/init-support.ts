// Pieces shared by init, setup and sync: the interactive-wizard stand-in, git helpers and the
// post-init hints.
import { existsSync, openSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandContext } from "../core/define.ts";
import { StyleDim } from "../core/plainoutput.ts";

/** The errno text Go's os.PathError carries for a failed open of /dev/tty. */
function ttyOpenReason(code: string | undefined): string {
  switch (code) {
    case "ENXIO":
      return process.platform === "darwin" ? "device not configured" : "no such device or address";
    case "ENOENT":
      return "no such file or directory";
    case "EACCES":
      return "permission denied";
    default:
      return "no such device or address";
  }
}

/**
 * What Go's huh wizard does when there is no terminal: it cannot open /dev/tty and returns an
 * error. With a terminal the wizard would start, which this build does not provide, so that case
 * fails with a message that names the flag-driven alternative.
 */
export function wizardUnavailable(): Error {
  if (process.platform !== "win32") {
    try {
      openSync("/dev/tty", "r+");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return new Error(`huh: could not open a new TTY: open /dev/tty: ${ttyOpenReason(code)}`);
    }
  }
  return new Error(
    "the interactive wizard is not available in the TypeScript build; pass a project name or --no-wizard",
  );
}

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
