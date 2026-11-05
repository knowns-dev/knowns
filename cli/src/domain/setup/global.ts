// Port of the user-level half of internal/cli/setup_global.go: global skills, global MCP configs
// and the global instruction files written by `knowns setup <target> --global`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncSkillsToTargets } from "../instructions/index.ts";
import type { Env } from "./env.ts";
import { setupGlobalHermesMcp } from "./hermes.ts";
import { isMap, type JsonMap, writeJsonMap } from "./json-files.ts";
import { mcpCommand } from "./mcp-command.ts";
import { hasPlatform } from "./platforms.ts";
import { setCodexMcpServer } from "./runtimeinstall.ts";

export { setupGlobalHermesMcp };

/** A JSON file that may be missing or malformed; Go ignores an unmarshal error here. */
function readLenient(path: string): JsonMap {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMap(v) ? v : {};
  } catch {
    return {};
  }
}

/** upsertGlobalMCPJSON: set mcpServers.<serverKey> in a JSON file. */
export function upsertGlobalMcpJson(configPath: string, serverKey: string, env: Env): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o755 });
  const config = readLenient(configPath);
  const servers = isMap(config.mcpServers) ? config.mcpServers : {};
  const { command, args } = mcpCommand(env);
  servers[serverKey] = { command, args };
  config.mcpServers = servers;
  writeJsonMap(configPath, config);
}

export const setupGlobalClaudeCodeMcp = (home: string, env: Env) =>
  upsertGlobalMcpJson(join(home, ".claude.json"), "knowns", env);

export function setupGlobalClaudeDesktopMcp(home: string, env: Env, platform = process.platform) {
  let configPath: string;
  switch (platform) {
    case "darwin":
      configPath = join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
      break;
    case "win32":
      configPath = join(env.APPDATA ?? "", "Claude", "claude_desktop_config.json");
      break;
    default:
      configPath = join(home, ".config", "claude", "claude_desktop_config.json");
  }
  upsertGlobalMcpJson(configPath, "knowns", env);
}

export function setupGlobalOpenCodeMcp(home: string, env: Env): void {
  const configPath = join(home, ".config", "opencode", "opencode.json");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o755 });
  const config = readLenient(configPath);
  const mcp = isMap(config.mcp) ? config.mcp : {};
  const { command, args } = mcpCommand(env);
  mcp.knowns = { command, args };
  config.mcp = mcp;
  writeJsonMap(configPath, config);
}

export function setupGlobalGeminiMcp(home: string, env: Env): void {
  const configPath = join(home, ".gemini", "settings.json");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o755 });
  const config = readLenient(configPath);
  const servers = isMap(config.mcpServers) ? config.mcpServers : {};
  const { command, args } = mcpCommand(env);
  servers.knowns = { command, args };
  config.mcpServers = servers;
  writeJsonMap(configPath, config);
}

export const setupGlobalKiroMcp = (home: string, env: Env) =>
  upsertGlobalMcpJson(join(home, ".kiro", "settings", "mcp.json"), "knowns", env);

export const setupGlobalCursorMcp = (home: string, env: Env) =>
  upsertGlobalMcpJson(join(home, ".cursor", "mcp.json"), "knowns", env);

export function setupGlobalCodexMcp(home: string, env: Env): void {
  const configPath = join(home, ".codex", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o755 });
  const { command, args } = mcpCommand(env);
  let content = "";
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    content = "";
  }
  writeFileSync(configPath, setCodexMcpServer(content, command, args), { mode: 0o644 });
}

/** syncGlobalSkills: skills under ~/.claude, ~/.kiro and the shared ~/.agents directories. */
export function syncGlobalSkills(home: string, platforms: readonly string[]): void {
  const targets: Record<string, string> = {};
  if (hasPlatform(platforms, "claude-code"))
    targets["claude-code"] = join(home, ".claude", "skills");
  if (hasPlatform(platforms, "kiro")) targets.kiro = join(home, ".kiro", "skills");
  for (const p of ["codex", "opencode", "hermes", "antigravity", "gemini", "cursor", "agents"]) {
    if (hasPlatform(platforms, p)) {
      targets.agents = join(home, ".agents", "skills");
      break;
    }
  }
  syncSkillsToTargets(targets);
}

/** generateGlobalInstructionContent. */
export function generateGlobalInstructionContent(platform: string): string {
  switch (platform) {
    case "claude-code":
      return `# CLAUDE

Global Knowns integration. Project-level MCP configuration takes precedence when available.

## Knowns

Knowns is the repository memory and workflow layer for AI-native development.

- When working in a project with a .knowns/ directory, use Knowns MCP for project-specific context.
- Use Knowns MCP tools for tasks, docs, templates, and workflow state.
- Search first, then read only relevant docs and code.
- Plan before implementation unless the user explicitly overrides.
`;
    case "kiro":
      return `# Knowns Global Steering

Global Knowns integration for Kiro. Project-level configuration takes precedence when available.

## Knowns

Knowns is the repository memory and workflow layer for AI-native development.

- When working in a project with a .knowns/ directory, use Knowns MCP for project-specific context.
- Use Knowns MCP tools for tasks, docs, templates, and workflow state.
- Search first, then read only relevant docs and code.
`;
    default:
      return "";
  }
}

/** writeGlobalInstructionFile: ~/.claude/CLAUDE.md or ~/.kiro/steering/knowns.md. */
export function writeGlobalInstructionFile(home: string, platform: string): void {
  let filePath: string;
  switch (platform) {
    case "claude-code":
      filePath = join(home, ".claude", "CLAUDE.md");
      break;
    case "kiro":
      filePath = join(home, ".kiro", "steering", "knowns.md");
      break;
    default:
      return;
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o755 });
  writeFileSync(filePath, generateGlobalInstructionContent(platform), { mode: 0o644 });
}
