import { type Env, lookPath } from "./env.ts";

/**
 * knowns-proxy was the launcher's name in dev builds. The launcher is `knowns` now (spec
 * mcp-thin-proxy D10), so no entry is written with this name any more; an existing one is still
 * recognised as Knowns's so that `knowns sync` rewrites it to `knowns`.
 */
export const PROXY_NAME = "knowns-proxy";

/** mcpCommand: the local `knowns` (the launcher), else npx (no global install). */
export function mcpCommand(env: Env = process.env): { command: string; args: string[] } {
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
 *   - the bare name `knowns` (or the retired `knowns-proxy`), with args exactly ["mcp", "--stdio"];
 *   -  *   - npx with ["-y", "knowns", "mcp", "--stdio"] (older releases: without "--stdio");
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
  // The pre-proxy releases wrote npx without --stdio; that form is still Knowns's.
  if (base === "npx" && !isPath(command)) {
    return same(["-y", "knowns", "mcp", "--stdio"]) || same(["-y", "knowns", "mcp"]);
  }
  if (!same(["mcp", "--stdio"])) return false;
  if (!isPath(command)) return command === "knowns" || command === PROXY_NAME;
  return base === PROXY_NAME;
}
