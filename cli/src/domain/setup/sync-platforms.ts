// Platform selection rules of `knowns sync` (internal/cli/sync.go): which platforms a --platform
// value or the project config selects for skills, instruction shims and platform configs.
import { join } from "node:path";
import { allPlatformIds } from "./platforms.ts";
import { goQuote } from "./runtimeinstall.ts";

/** resolveSyncPlatformSelection: platforms whose skills, hooks and shims sync touches. */
export function resolveSyncPlatformSelection(
  platform: string,
  configPlatforms: readonly string[],
): string[] {
  if (platform === "") return [...configPlatforms];
  const normalized = platform.trim().toLowerCase();
  switch (normalized) {
    case "all":
      return [...allPlatformIds];
    case "claude":
      return ["claude-code"];
    case "claude-code":
    case "opencode":
    case "codex":
    case "kiro":
    case "hermes":
    case "antigravity":
    case "cursor":
    case "gemini":
    case "copilot":
    case "agents":
      return [normalized];
    default:
      throw new Error(
        `unknown platform ${goQuote(platform)} (available: claude, opencode, codex, kiro, hermes, antigravity, cursor, gemini, copilot, agents, all)`,
      );
  }
}

/** resolveSyncPlatformTargets: platforms that also get MCP config / rule files. */
export function resolveSyncPlatformTargets(
  platform: string,
  configPlatforms: readonly string[],
): string[] {
  if (platform === "") return [...configPlatforms];
  const normalized = platform.trim().toLowerCase();
  switch (normalized) {
    case "codex":
    case "cursor":
    case "hermes":
    case "antigravity":
      return [normalized];
    case "all":
      return [...configPlatforms];
    case "claude":
    case "claude-code":
    case "opencode":
    case "kiro":
    case "gemini":
    case "copilot":
    case "agents":
      return [];
    default:
      throw new Error(`unknown platform ${goQuote(platform)}`);
  }
}

/** One instruction shim sync writes (syncInstructionPlatformDef). */
export interface SyncInstructionPlatformDef {
  name: string;
  label: string;
  /** Path relative to the project root. */
  relPath: string;
  configIds: string[];
  aliases: string[];
}

export const syncInstructionPlatformDefs: readonly SyncInstructionPlatformDef[] = [
  {
    name: "claude",
    label: "Claude Code",
    relPath: "CLAUDE.md",
    configIds: ["claude-code"],
    aliases: ["claude", "claude-code"],
  },
  {
    name: "opencode",
    label: "OpenCode",
    relPath: "OPENCODE.md",
    configIds: ["opencode"],
    aliases: ["opencode"],
  },
  {
    name: "gemini",
    label: "Gemini CLI",
    relPath: "GEMINI.md",
    configIds: ["gemini"],
    aliases: ["gemini"],
  },
  {
    name: "copilot",
    label: "GitHub Copilot",
    relPath: join(".github", "copilot-instructions.md"),
    configIds: ["copilot"],
    aliases: ["copilot"],
  },
  {
    name: "agents",
    label: "Generic AI",
    relPath: "AGENTS.md",
    configIds: ["agents", "codex", "hermes"],
    aliases: ["agents", "codex", "hermes"],
  },
];

/**
 * Select the instruction shims: an explicit platform wins (case-insensitive alias match, an error
 * when nothing matches); otherwise a non-empty config list restricts them; otherwise all.
 */
export function selectSyncInstructionDefs(
  platform: string,
  configPlatforms: readonly string[],
): SyncInstructionPlatformDef[] {
  if (platform !== "") {
    const lower = platform.toLowerCase();
    const filtered = syncInstructionPlatformDefs.filter((p) =>
      p.aliases.some((a) => a.toLowerCase() === lower),
    );
    if (filtered.length === 0) {
      throw new Error(
        `unknown platform ${goQuote(platform)} (available: claude, opencode, codex, hermes, gemini, copilot, agents)`,
      );
    }
    return filtered;
  }
  if (configPlatforms.length > 0) {
    const set = new Set(configPlatforms);
    return syncInstructionPlatformDefs.filter((p) => p.configIds.some((id) => set.has(id)));
  }
  return [...syncInstructionPlatformDefs];
}
