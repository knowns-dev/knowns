// Port of the server-level tests of tests/e2e_mcp_test.go (Go) against the TypeScript CLI.
//
// Go test                      -> TS test
// TestMCP_InitialTool          -> "initial tool"
// TestMCP_InitializeInstructions -> "initialize instructions"
// TestMCP_SemanticSearch       -> "semantic search" (still gated behind TEST_SEMANTIC=1)
//
// The Go semantic test needed no reachable embedder: the subsets CI runs are keyword and hybrid,
// and hybrid degrades to keyword results when the embedder is unreachable.
import { afterAll, describe, expect, test } from "bun:test";
import { McpSession } from "../mcp/harness.ts";
import { run, tsSide } from "../rollback/binaries.ts";
import { cleanupE2e, McpClient, setupProject, startWithProject } from "./mcp-client.ts";

afterAll(cleanupE2e);

describe("server instructions", () => {
  test("initial tool returns operating instructions", async () => {
    const project = setupProject();
    const client = await McpClient.start(project.dir, project.home);
    try {
      const raw = await client.callRaw("initial", {});
      expect(raw).not.toBe("");
      expect(raw).toContain("Session Ready");
      expect(raw).toContain("Code Intelligence Rules");
      expect(raw).toContain("Workflow");
    } finally {
      await client.close();
    }
  });

  test("initialize instructions mention the initial tool", async () => {
    const project = setupProject();
    const session = new McpSession("ts", {
      cwd: project.dir,
      home: project.home,
    });
    try {
      const resp = await session.initialize();
      const instructions = (resp.result as { instructions?: string } | undefined)?.instructions;
      expect(typeof instructions).toBe("string");
      expect(instructions).toContain("initial");
    } finally {
      await session.close();
    }
  });
});

describe.skipIf(process.env.TEST_SEMANTIC !== "1")("semantic search (TEST_SEMANTIC=1)", () => {
  test("search modes, type filters and the removed graph action", async () => {
    const { client, project } = await startWithProject();
    try {
      await client.call("tasks", {
        action: "create",
        title: "Semantic Auth Task",
        description: "Implement JWT authentication with RS256",
        labels: ["auth", "semantic-test"],
      });
      await client.call("docs", {
        action: "create",
        title: "Semantic Security Doc",
        content:
          "# Security Patterns\n\n## JWT Authentication\n- RS256 algorithm\n- Short-lived tokens\n- Refresh flow",
        tags: ["security", "semantic-test"],
      });

      // The model is chosen through the CLI (MCP has no model tools). `config set` only records
      // the choice: nothing is downloaded and nothing has to be running.
      const set = run(
        tsSide(),
        ["config", "set", "settings.semanticSearch.model", "qwen3-embedding:0.6b"],
        project.dir,
        {
          HOME: project.home,
          USERPROFILE: project.home,
          NO_COLOR: "1",
          KNOWNS_RUNTIME_INLINE: "1",
        },
      );
      expect(set.code, `config set model: ${set.stderr}${set.stdout}`).toBe(0);

      // reindex_search was removed in the consolidated MCP tool refactor (the Go test skipped it).
      for (const [query, mode, type] of [
        ["JWT authentication", "keyword", undefined],
        ["authentication security patterns", "hybrid", undefined],
        ["security", undefined, "doc"],
        ["authentication", undefined, "task"],
      ] as const) {
        const raw = await client.callRaw("search", {
          action: "search",
          query,
          ...(mode ? { mode } : {}),
          ...(type ? { type } : {}),
        });
        expect(raw).not.toBe("");
      }

      // type=code is a real chunk type: the call succeeds and may only return code results.
      const codeRaw = await client.callRaw("search", {
        action: "search",
        query: "authentication security patterns",
        type: "code",
        mode: "hybrid",
        limit: 10,
      });
      const parsed = JSON.parse(codeRaw) as { results?: Array<{ type: string }> };
      for (const r of parsed.results ?? []) expect(r.type).toBe("code");

      // tree-sitter was removed: the graph action answers with an explicit removal error.
      const graph = await client.callRaw("code", { action: "graph" });
      expect(graph).toContain("Action 'graph' has been removed.");
    } finally {
      await client.close();
    }
  }, 120_000);
});
