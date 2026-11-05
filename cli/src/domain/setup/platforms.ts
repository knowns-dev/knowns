// Platform tables and selection rules from internal/cli/init.go and setup.go.
import { join } from "node:path";

/** instructionFile: an agent instruction file generated during init and setup. */
export interface InstructionFile {
  path: string;
  /** Display name passed to generateInstructionContent. */
  platform: string;
  /** Matches an allPlatformIds entry. */
  platformId: string;
}

export const defaultInstructionFiles: readonly InstructionFile[] = [
  { path: "CLAUDE.md", platform: "Claude Code", platformId: "claude-code" },
  { path: "OPENCODE.md", platform: "OpenCode", platformId: "opencode" },
  { path: "GEMINI.md", platform: "Gemini CLI", platformId: "gemini" },
  { path: "AGENTS.md", platform: "Generic AI", platformId: "agents" },
  {
    path: join(".github", "copilot-instructions.md"),
    platform: "GitHub Copilot",
    platformId: "copilot",
  },
];

/** The full ordered list of supported platform identifiers. */
export const allPlatformIds: readonly string[] = [
  "claude-code",
  "opencode",
  "codex",
  "kiro",
  "hermes",
  "antigravity",
  "cursor",
  "gemini",
  "copilot",
  "agents",
];

/** hasPlatform: true if id is in platforms, or platforms is empty (everything enabled). */
export function hasPlatform(platforms: readonly string[], id: string): boolean {
  return platforms.length === 0 || platforms.includes(id);
}

export function hasExplicitPlatform(platforms: readonly string[], id: string): boolean {
  return platforms.includes(id);
}

export function shouldCreateInstructionFile(
  platforms: readonly string[],
  f: InstructionFile,
): boolean {
  if (platforms.length === 0) return true;
  if (
    f.platformId === "agents" &&
    (hasExplicitPlatform(platforms, "codex") || hasExplicitPlatform(platforms, "hermes"))
  ) {
    return true;
  }
  return hasExplicitPlatform(platforms, f.platformId);
}

export function defaultInstructionPlatforms(): string[] {
  return ["claude-code", "agents"];
}

/** setup/sync target names mapped to platform ids; null when the target is unknown. */
export function platformsForSetupTarget(target: string): string[] | null {
  switch (target) {
    case "claude":
      return ["claude-code"];
    case "opencode":
    case "copilot":
    case "kiro":
    case "hermes":
    case "codex":
    case "cursor":
    case "gemini":
    case "agents":
    case "antigravity":
      return [target];
    case "all":
      return [...allPlatformIds];
    default:
      return null;
  }
}

export const SETUP_TARGET_ERROR =
  "expected: claude, opencode, hermes, copilot, kiro, codex, cursor, gemini, antigravity, agents, all";

/** The instruction-file list `knowns agents` reports. */
export interface AgentPlatform {
  name: string;
  fileName: string;
  label: string;
}

export const knownAgentPlatforms: readonly AgentPlatform[] = [
  { name: "claude", fileName: "CLAUDE.md", label: "Claude Code" },
  { name: "opencode", fileName: "OPENCODE.md", label: "OpenCode" },
  { name: "gemini", fileName: "GEMINI.md", label: "Google Gemini" },
  {
    name: "copilot",
    fileName: join(".github", "copilot-instructions.md"),
    label: "GitHub Copilot",
  },
  { name: "agents", fileName: "AGENTS.md", label: "Generic Agents" },
];
