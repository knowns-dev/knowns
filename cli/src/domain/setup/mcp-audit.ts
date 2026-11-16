// Finds Knowns-written MCP entries that start knowns-proxy when that binary cannot be found, so
// `knowns doctor` can say "run knowns sync" (sync rewrites them to the binary that exists).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Env, lookPath, userHomeDir } from "./env.ts";
import { PROXY_NAME } from "./mcp-command.ts";

export interface MissingProxyEntry {
  /** Config file relative to the project root. */
  file: string;
  /** The command the entry runs. */
  command: string;
}

const JSON_CONFIGS: Array<{ file: string; parent: "mcpServers" | "mcp" }> = [
  { file: ".mcp.json", parent: "mcpServers" },
  { file: ".cursor/mcp.json", parent: "mcpServers" },
  { file: ".kiro/settings/mcp.json", parent: "mcpServers" },
  { file: "opencode.json", parent: "mcp" },
];

function entryCommand(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as { command?: unknown };
  if (typeof e.command === "string") return e.command;
  if (Array.isArray(e.command) && typeof e.command[0] === "string") return e.command[0];
  return undefined;
}

/** The command of [mcp_servers.knowns] in a Codex config.toml, if there is one. */
export function codexKnownsCommand(toml: string): string | undefined {
  const header = /^\s*\[mcp_servers\.(?:knowns|"knowns")\]\s*$/m.exec(toml);
  if (!header) return undefined;
  const rest = toml.slice(header.index + header[0].length);
  const next = /^\s*\[/m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  const m = /^\s*command\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m.exec(body);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

export function findMissingProxyEntries(
  projectRoot: string,
  env: Env = process.env,
): MissingProxyEntry[] {
  const out: MissingProxyEntry[] = [];
  const check = (label: string, command: string | undefined): void => {
    if (command === undefined) return;
    const base = command.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (base !== PROXY_NAME) return;
    const found = isAbsolute(command) ? existsSync(command) : lookPath(command, env) !== undefined;
    if (!found) out.push({ file: label, command });
  };
  const serversOf = (cfg: unknown, parent: string): Record<string, unknown> | undefined =>
    ((cfg as Record<string, unknown> | null | undefined)?.[parent] as
      | Record<string, unknown>
      | undefined) ?? undefined;

  for (const { file, parent } of JSON_CONFIGS) {
    check(file, entryCommand(serversOf(readJson(join(projectRoot, file)), parent)?.knowns));
  }
  try {
    check(
      ".codex/config.toml",
      codexKnownsCommand(readFileSync(join(projectRoot, ".codex", "config.toml"), "utf8")),
    );
  } catch {
    // no Codex config
  }

  // User-level configs: Antigravity (Gemini) and Claude Code's ~/.claude.json, which keeps
  // servers both at the top level and per project.
  let home: string;
  try {
    home = userHomeDir(env);
  } catch {
    return out; // no home directory: nothing user-level to look at
  }
  check(
    "~/.gemini/antigravity/mcp_config.json",
    entryCommand(
      serversOf(readJson(join(home, ".gemini", "antigravity", "mcp_config.json")), "mcpServers")
        ?.knowns,
    ),
  );
  const claude = readJson(join(home, ".claude.json"));
  check("~/.claude.json", entryCommand(serversOf(claude, "mcpServers")?.knowns));
  const project = serversOf(claude, "projects")?.[projectRoot];
  check("~/.claude.json", entryCommand(serversOf(project, "mcpServers")?.knowns));
  return out;
}
