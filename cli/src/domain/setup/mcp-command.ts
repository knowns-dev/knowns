import { type Env, lookPath } from "./env.ts";

/** mcpCommand: the local binary when `knowns` is on PATH, else npx (works without a global install). */
export function mcpCommand(env: Env = process.env): { command: string; args: string[] } {
  if (lookPath("knowns", env) !== undefined) return { command: "knowns", args: ["mcp", "--stdio"] };
  return { command: "npx", args: ["-y", "knowns", "mcp", "--stdio"] };
}

/** mcpCommandFlat: the same command as one array (OpenCode's format). */
export function mcpCommandFlat(env: Env = process.env): string[] {
  const { command, args } = mcpCommand(env);
  return [command, ...args];
}
