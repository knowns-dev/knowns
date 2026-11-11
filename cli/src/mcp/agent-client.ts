// KN-4FQN0P: who is on the other end of an MCP session. MCP sends clientInfo.name at initialize and no model
// name, so the identity is the client. Only known agent clients are recorded: any other client (the Go e2e
// harness sends "e2e-test") leaves tasks exactly as 0.34.1 would, which keeps byte parity (spec D15).

export interface ClientInfo {
  name: string;
  version?: string;
  title?: string;
}

/** Substring (after lowercasing) -> the slug stored in claims and used for icons. First match wins. */
const KNOWN_AGENTS: [needle: string, slug: string][] = [
  ["claude-code", "claude-code"],
  ["claude code", "claude-code"],
  ["claude-ai", "claude"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["gemini", "gemini-cli"],
  ["opencode", "opencode"],
  ["windsurf", "windsurf"],
  ["cline", "cline"],
  ["roo", "roo-code"],
  ["copilot", "copilot"],
  ["zed", "zed"],
  ["kiro", "kiro"],
  ["amp", "amp"],
  ["pi", "pi"],
];

/** The agent slug for a client, or undefined when it is not a known agent. */
export function agentSlug(info: ClientInfo | undefined): string | undefined {
  const name = info?.name?.trim().toLowerCase();
  if (!name) return undefined;
  for (const [needle, slug] of KNOWN_AGENTS) {
    // Short needles (roo, amp, pi, zed) must be the whole name or a name segment, not a stray substring.
    if (needle.length <= 3 || needle === "zed" || needle === "cline") {
      if (name === needle || name.split(/[^a-z0-9]+/).includes(needle)) return slug;
    } else if (name.includes(needle)) return slug;
  }
  return undefined;
}

/** The actor recorded on history and time entries: "mcp:<slug>" for a known agent, else "mcp". */
export function mcpActor(info: ClientInfo | undefined): string {
  const slug = agentSlug(info);
  return slug ? `mcp:${slug}` : "mcp";
}
