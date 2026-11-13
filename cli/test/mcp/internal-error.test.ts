// Approved divergence (D12, TSR-A3N6KY): a failure that escapes the tool handler's own recovery
// (the readiness wait or a lifecycle hook) still answers the request with INTERNAL_ERROR. 0.34.1
// left it unanswered, so the client waited on that id forever.
import { describe, expect, test } from "bun:test";
import { INTERNAL_ERROR, McpServer, type ServerOptions } from "../../src/mcp/server.ts";

async function call(opts: Partial<ServerOptions>): Promise<unknown[]> {
  const server = new McpServer({ name: "t", version: "0", instructions: "", ...opts });
  server.addTool(
    { name: "echo", description: "", inputSchema: { type: "object", properties: {} } } as never,
    async () => ({ text: "ok" }) as never,
  );
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: {} } },
  ];
  async function* input(): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }
  const out: unknown[] = [];
  const served = server.serve(input(), (text) => {
    for (const line of text.split("\n")) if (line !== "") out.push(JSON.parse(line));
  });
  await Promise.race([served, Bun.sleep(2000)]);
  await Bun.sleep(50);
  return out;
}

const replyTo = (out: unknown[], id: number) =>
  out.find((r) => (r as { id?: unknown }).id === id) as
    | { error?: { code: number; message: string }; result?: unknown }
    | undefined;

describe("MCP server internal errors", () => {
  test("a readiness failure answers the call with INTERNAL_ERROR", async () => {
    const out = await call({
      ready: async () => {
        throw new Error("project detection failed");
      },
    });
    const reply = replyTo(out, 7);
    expect(reply?.error?.code).toBe(INTERNAL_ERROR);
    expect(reply?.error?.message).toBe("project detection failed");
  });

  test("a throwing lifecycle hook answers the call with INTERNAL_ERROR", async () => {
    const out = await call({
      hooks: {
        afterCallTool: () => {
          throw new Error("audit write failed");
        },
      },
    });
    const reply = replyTo(out, 7);
    expect(reply?.error?.code).toBe(INTERNAL_ERROR);
    expect(reply?.error?.message).toBe("audit write failed");
  });

  test("a normal call still gets its result", async () => {
    const reply = replyTo(await call({}), 7);
    expect(reply?.error).toBeUndefined();
    expect(reply?.result).toBeDefined();
  });
});
