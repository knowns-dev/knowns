// Finds Knowns-written MCP entries that start knowns-proxy when that binary cannot be found, so
// `knowns doctor` can say "run knowns sync" (sync rewrites them to the binary that exists).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Env, lookPath } from "./env.ts";
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

export function findMissingProxyEntries(
  projectRoot: string,
  env: Env = process.env,
): MissingProxyEntry[] {
  const out: MissingProxyEntry[] = [];
  for (const { file, parent } of JSON_CONFIGS) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(readFileSync(join(projectRoot, file), "utf8"));
    } catch {
      continue;
    }
    const servers = (cfg as Record<string, unknown> | null)?.[parent];
    const command = entryCommand((servers as Record<string, unknown> | undefined)?.knowns);
    if (command === undefined) continue;
    const base = command.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (base !== PROXY_NAME) continue;
    const found = isAbsolute(command) ? existsSync(command) : lookPath(command, env) !== undefined;
    if (!found) out.push({ file, command });
  }
  return out;
}
