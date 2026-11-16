import { type Env, lookPath } from "./env.ts";

/**
 * The name the D8 prototype shipped its MCP proxy under. Spec mcp-thin-proxy D10 dropped it: the
 * `knowns` command is itself the launcher, so no config ever names a proxy. The name survives only
 * so Knowns-written entries from dev builds are recognised and rewritten.
 */
export const LEGACY_PROXY_NAME = "knowns-proxy";

/**
 * mcpCommand: what an MCP config runs. Always the bare `knowns` (project MCP files are committed and
 * shared, so they never carry a machine path or a binary teammates may not have); npx when no
 * `knowns` is installed at all.
 */
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
 *   - the bare name `knowns` with args exactly ["mcp", "--stdio"];
 *   - npx with ["-y", "knowns", "mcp", "--stdio"] (older releases: without "--stdio");
 * and, for a tool that needs a project root in the entry (Antigravity), a trailing
 * ["--project", <root>] when `allowProject` is set. Dev builds also wrote `knowns-proxy`, bare or by
 * path, with the same args: that is still Knowns's and is rewritten to `knowns`. An absolute path
 * to `knowns` itself is never Knowns's: it is a custom install.
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
  if (!isPath(command)) return command === "knowns" || command === LEGACY_PROXY_NAME;
  return base === LEGACY_PROXY_NAME;
}
