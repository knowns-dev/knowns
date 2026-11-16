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

const isPath = (command: string): boolean => /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);

/**
 * Whether an existing MCP entry is exactly what Knowns writes, so sync may rewrite it. Anything
 * else (extra arguments, a custom binary such as a dogfood build, the user's own server) is theirs
 * and sync leaves it alone. Knowns writes:
 *   - the bare name `knowns` or `knowns-proxy`, with args exactly ["mcp", "--stdio"];
 *   - the absolute path of the knowns-proxy next to the knowns on PATH (proxyCommand), same args;
 *   - npx with ["-y", "knowns", "mcp", "--stdio"];
 * and, for a tool that needs a project root in the entry (Antigravity), a trailing
 * ["--project", <root>] when `allowProject` is set. An absolute path to `knowns` itself is never
 * Knowns's: it is a custom install.
 */
export function isKnownsWritten(
  command: unknown,
  args: unknown,
  options: { allowProject?: boolean } = {},
): boolean {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  let a = args.map(String);
  if (options.allowProject && a.length >= 2 && a[a.length - 2] === "--project") {
    a = a.slice(0, -2);
  }
  const same = (want: string[]): boolean =>
    a.length === want.length && a.every((v, i) => v === want[i]);
  const base = command.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "");
  if (base === "npx" && !isPath(command)) return same(["-y", "knowns", "mcp", "--stdio"]);
  if (!same(["mcp", "--stdio"])) return false;
  if (!isPath(command)) return command === "knowns" || command === PROXY_NAME;
  return base === PROXY_NAME;
}
