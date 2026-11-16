import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, lookPath } from "./env.ts";

/** The native MCP proxy shipped next to `knowns` (spec mcp-thin-proxy D8, FR-11). */
export const PROXY_NAME = "knowns-proxy";

/**
 * proxyCommand: how an MCP config should start the proxy, or undefined when there is none.
 * The bare name when it is on PATH (the convention every Knowns MCP entry already follows), else
 * the absolute path of the copy next to the `knowns` on PATH (install.sh keeps both in one
 * directory). KNOWNS_MCP_PROXY=0 at config time opts out (FR-9).
 */
export function proxyCommand(
  env: Env = process.env,
  platform = process.platform,
): string | undefined {
  if ((env.KNOWNS_MCP_PROXY ?? "").trim() === "0") return undefined;
  if (lookPath(PROXY_NAME, env, platform) !== undefined) return PROXY_NAME;
  const knowns = lookPath("knowns", env, platform);
  if (knowns === undefined) return undefined;
  let dir: string;
  try {
    dir = dirname(realpathSync(knowns));
  } catch {
    dir = dirname(knowns);
  }
  const sibling = join(dir, platform === "win32" ? `${PROXY_NAME}.exe` : PROXY_NAME);
  return existsSync(sibling) ? sibling : undefined;
}

/** mcpCommand: the proxy when there is one, else the local binary, else npx (no global install). */
export function mcpCommand(env: Env = process.env): { command: string; args: string[] } {
  const proxy = proxyCommand(env);
  if (proxy !== undefined) return { command: proxy, args: ["mcp", "--stdio"] };
  if (lookPath("knowns", env) !== undefined) return { command: "knowns", args: ["mcp", "--stdio"] };
  return { command: "npx", args: ["-y", "knowns", "mcp", "--stdio"] };
}

/** mcpCommandFlat: the same command as one array (OpenCode's format). */
export function mcpCommandFlat(env: Env = process.env): string[] {
  const { command, args } = mcpCommand(env);
  return [command, ...args];
}

/**
 * Whether an existing MCP entry was written by Knowns: it starts `mcp` through knowns,
 * knowns-proxy or npx. Anything else is the user's own and sync leaves it alone.
 */
export function isKnownsWritten(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  const a = args.map(String);
  const base = command.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "");
  if (base === "knowns" || base === PROXY_NAME) return a.includes("mcp");
  return base === "npx" && a.includes("knowns") && a.includes("mcp");
}
