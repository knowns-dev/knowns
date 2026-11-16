// KNOWNS_MCP_PROXY=0 (spec D5, FR-9): the client-side opt-out. `mcp --stdio` and `browser` then
// behave exactly as in 0.35.x. The opt-out is never passed on to a daemon this client starts.
export function proxyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.KNOWNS_MCP_PROXY ?? "").trim() !== "0";
}
