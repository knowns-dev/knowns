// Port of TestMCP_StructuralResolve (tests/e2e_structural_test.go, Go) against the TypeScript CLI.
// The CLI half (TestCLI_StructuralResolve) is ported separately.
//
// Go subtest                           -> TS test
// basic resolve backward compat        -> "basic resolve keeps the reference/found shape"
// inbound implements                   -> "inbound implements"
// entity type filter                   -> "entity type filter"
// multi-hop depth 2                    -> "multi-hop depth 2"
// relation type filter                 -> "relation type filter"
//
// Existing TS coverage (cli/test/history/structural.test.ts, test/cli/commands/resolve.test.ts)
// exercises the resolver and the CLI; none drives the `search` tool's resolve action over MCP, so
// this stays as an end-to-end test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupE2e, type McpClient, startWithProject } from "./mcp-client.ts";

afterAll(cleanupE2e);

let client: McpClient;
const taskIds: string[] = [];

beforeAll(async () => {
  ({ client } = await startWithProject());
  await client.call("docs", {
    action: "create",
    title: "Structural Test Spec",
    folder: "specs",
    content: "# Structural Test Spec\n\nA test spec for structural retrieval.",
    tags: ["spec", "approved"],
  });
  for (const title of ["Task Alpha", "Task Beta", "Task Gamma"]) {
    const r = await client.call("tasks", {
      action: "create",
      title,
      spec: "specs/structural-test-spec",
    });
    expect(r.id, `task id for ${title}`).toBeTruthy();
    taskIds.push(r.id as string);
  }
  // A blocked chain: the first task is blocked by the second (via an inline ref).
  await client.call("tasks", {
    action: "update",
    taskId: taskIds[0],
    description: `Blocked by @task-${taskIds[1]}{blocked-by}`,
  });
});
afterAll(async () => {
  await client.close();
});

interface Edge {
  relation?: string;
  origin?: string;
  direction?: string;
  depth?: number;
  source?: { kind?: string };
  target?: { kind?: string };
}
interface Resolved {
  root?: { kind?: string };
  edges?: Edge[];
}

const resolve = async (args: Record<string, unknown>) => {
  const raw = await client.callRaw("search", { action: "resolve", ...args });
  return { raw, parsed: JSON.parse(raw) as Resolved };
};

describe("structural resolve over MCP", () => {
  test("basic resolve keeps the reference/found shape", async () => {
    const raw = await client.callRaw("search", {
      action: "resolve",
      ref: "@doc/specs/structural-test-spec",
    });
    expect(raw).toContain('"found"');
    expect(raw).toContain('"reference"');
  });

  test("inbound implements", async () => {
    const { parsed } = await resolve({
      ref: "@doc/specs/structural-test-spec{implements}",
      direction: "inbound",
      relationTypes: "implements",
    });
    expect(parsed.root?.kind).toBe("doc");
    expect(parsed.edges?.length).toBe(3);
    for (const e of parsed.edges ?? []) {
      expect(e.relation).toBe("implements");
      expect(e.origin).toBe("field-backed");
      expect(e.direction).toBe("inbound");
    }
  });

  test("entity type filter", async () => {
    const { parsed } = await resolve({
      ref: "@doc/specs/structural-test-spec{references}",
      direction: "inbound",
      entityTypes: "task",
    });
    for (const e of parsed.edges ?? []) {
      // The "other" entity (not the doc root) must be a task.
      const other = e.source?.kind === "doc" ? e.target : e.source;
      if (other) expect(other.kind).toBe("task");
    }
  });

  test("multi-hop depth 2", async () => {
    const { parsed } = await resolve({
      ref: "@doc/specs/structural-test-spec{implements}",
      direction: "inbound",
      depth: 2,
    });
    // Depth 2 may add nothing when no depth-2 relation exists; the call must still resolve all
    // depth-1 edges.
    expect((parsed.edges ?? []).filter((e) => (e.depth ?? 1) === 1).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  test("relation type filter", async () => {
    const { parsed } = await resolve({
      ref: "@doc/specs/structural-test-spec{spec}",
      direction: "inbound",
      relationTypes: "spec",
    });
    for (const e of parsed.edges ?? []) expect(e.relation).toBe("spec");
  });
});
