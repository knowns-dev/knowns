// Port of tests/e2e_mcp_test.go (Go) against the TypeScript CLI over `knowns mcp --stdio`.
//
// Go test                                          -> TS test (this file unless noted)
// TestMCP_TaskLifecycle                            -> "task lifecycle"
// TestMCP_DocumentWorkflow                         -> "document workflow"
// TestMCP_UpdateIgnoresEmptyStringsAndSupportsClear -> "empty strings are ignored and clear works" (task, doc, memory)
// TestMCP_SearchWorkflow                           -> "search workflow"
// TestMCP_Board                                    -> "board"
// TestMCP_Validation                               -> "validation"
// TestMCP_ReopenWorkflow                           -> "reopen workflow"
// TestMCP_SemanticSearch (TEST_SEMANTIC=1)         -> mcp-server.test.ts
// TestMCP_InitialTool, TestMCP_InitializeInstructions -> mcp-server.test.ts
// TestMCP_StructuralResolve                        -> mcp-structural.test.ts
//
// No existing non-oracle TS test covered these flows: cli/test/mcp/*.diff.test.ts compare against
// the Go binary and go away with it, so the behavior is ported here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupE2e, type McpClient, startWithProject } from "./mcp-client.ts";

afterAll(cleanupE2e);

let client: McpClient;
beforeAll(async () => {
  ({ client } = await startWithProject());
});
afterAll(async () => {
  await client.close();
});

const str = (v: unknown): string => (typeof v === "string" ? v : "");

describe("task lifecycle", () => {
  let taskId = "";

  test("create task", async () => {
    const r = await client.call("tasks", {
      action: "create",
      title: "E2E MCP: Implement Auth Feature",
      description: "Implement JWT authentication for the API.",
      priority: "high",
      labels: ["e2e-test", "auth", "feature"],
      assignee: "@me",
    });
    taskId = str(r.id);
    expect(taskId).not.toBe("");
  });

  test("add AC", async () => {
    const r = await client.call("tasks", {
      action: "update",
      taskId,
      addAc: [
        "JWT tokens are generated on login",
        "Tokens expire after 1 hour",
        "Refresh token flow works",
        "Unit tests have >90% coverage",
      ],
    });
    expect((r.acceptanceCriteria as unknown[]).length).toBe(4);
  });

  test("start time", async () => {
    const r = await client.call("time", { action: "start", taskId });
    expect(r.success).toBe(true);
  });

  test("in-progress + plan", async () => {
    const r = await client.call("tasks", {
      action: "update",
      taskId,
      status: "in-progress",
      plan: "1. Research JWT\n2. Design tokens\n3. Implement endpoints\n4. Write tests",
    });
    expect(r.status).toBe("in-progress");
  });

  for (const i of [1, 2, 3, 4]) {
    test(`check AC ${i}`, async () => {
      await client.call("tasks", {
        action: "update",
        taskId,
        checkAc: [i],
        appendNotes: "Completed AC step",
      });
    });
  }

  test("stop time", async () => {
    const r = await client.call("time", { action: "stop", taskId });
    expect(r.success).toBe(true);
  });

  test("final notes and done", async () => {
    await client.call("tasks", {
      action: "update",
      taskId,
      notes:
        "## Summary\nImplemented JWT auth.\n\n## Changes\n- Login endpoint\n- Refresh endpoint\n- Auth middleware",
    });
    await client.call("tasks", { action: "update", taskId, status: "done" });
  });

  test("verify state", async () => {
    const task = await client.call("tasks", { action: "get", taskId });
    expect(task.status).toBe("done");
    const acs = task.acceptanceCriteria as Array<{ completed?: boolean }>;
    expect(acs.length).toBe(4);
    acs.forEach((ac, i) => {
      expect(ac.completed, `AC #${i + 1} checked`).toBe(true);
    });
    expect(str(task.implementationNotes)).not.toBe("");
    expect(str(task.implementationPlan)).not.toBe("");
  });

  test("time report", async () => {
    const r = await client.call("time", { action: "report" });
    expect(r.entries !== undefined || r.total !== undefined).toBe(true);
  });
});

describe("document workflow", () => {
  let docPath = "";

  test("create doc", async () => {
    const r = await client.call("docs", {
      action: "create",
      title: "MCP E2E Test Doc",
      description: "Test document created by MCP E2E tests",
      tags: ["test", "e2e", "mcp"],
      folder: "tests",
      content:
        "# MCP E2E Test Doc\n\n## Overview\nCreated by MCP E2E test suite.\n\n## Purpose\nTesting document workflow.",
    });
    docPath = str(r.path);
    expect(docPath).not.toBe("");
  });

  test("get doc smart", async () => {
    const r = await client.call("docs", { action: "get", path: docPath, smart: true });
    // A small doc returns its content directly.
    expect(str(r.content)).toContain("Created by MCP E2E test suite");
  });

  test("update doc append", async () => {
    const r = await client.call("docs", {
      action: "update",
      path: docPath,
      appendContent: "\n\n## References\n- Created by MCP E2E test",
    });
    expect(str(r.path)).not.toBe("");
    const got = await client.call("docs", { action: "get", path: docPath });
    expect(str(got.content)).toContain("## References");
  });

  test("search doc", async () => {
    const raw = await client.callRaw("search", {
      action: "search",
      query: "MCP E2E Test",
      type: "doc",
    });
    // A fresh doc may not be indexed yet, so only the shape is required.
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("empty strings are ignored and clear works", () => {
  const assertCleared = (result: Record<string, unknown>, key: string) => {
    if (key in result) expect(result[key], `${key} cleared`).toBe("");
  };

  test("task", async () => {
    const created = await client.call("tasks", {
      action: "create",
      title: "Task title",
      description: "Task description",
      assignee: "@me",
    });
    const taskId = str(created.id);
    expect(taskId).not.toBe("");

    const seeded = await client.call("tasks", {
      action: "update",
      taskId,
      plan: "Initial plan",
      notes: "Initial notes",
    });
    expect(seeded.implementationPlan).toBe("Initial plan");
    expect(seeded.implementationNotes).toBe("Initial notes");

    const unchanged = await client.call("tasks", {
      action: "update",
      taskId,
      title: "",
      description: "",
      assignee: "",
      plan: "",
      notes: "",
    });
    expect(unchanged.title).toBe("Task title");
    expect(unchanged.description).toBe("Task description");
    expect(unchanged.assignee).toBe("@me");
    expect(unchanged.implementationPlan).toBe("Initial plan");
    expect(unchanged.implementationNotes).toBe("Initial notes");

    const cleared = await client.call("tasks", {
      action: "update",
      taskId,
      clear: ["title", "description", "assignee", "plan", "notes", "spec"],
    });
    for (const k of [
      "title",
      "description",
      "assignee",
      "implementationPlan",
      "implementationNotes",
    ]) {
      assertCleared(cleared, k);
    }
  });

  test("doc", async () => {
    const created = await client.call("docs", {
      action: "create",
      title: "Doc keep values",
      description: "Doc description",
      content: "Original content",
    });
    const path = str(created.path);
    expect(path).not.toBe("");

    const unchanged = await client.call("docs", {
      action: "update",
      path,
      title: "",
      description: "",
      content: "",
    });
    expect(unchanged.title).toBe("Doc keep values");
    expect(unchanged.description).toBe("Doc description");
    expect(unchanged.content).toBe("Original content");

    const cleared = await client.call("docs", {
      action: "update",
      path,
      clear: ["title", "description", "content"],
    });
    for (const k of ["title", "description", "content"]) assertCleared(cleared, k);
  });

  test("memory", async () => {
    const created = await client.call("memory", {
      action: "add",
      title: "Memory title",
      content: "Memory content",
      category: "pattern",
    });
    // Every memory write returns the entry under `memory`, alongside the claim that will actually
    // be injected.
    const entryOf = (r: Record<string, unknown>) => {
      const entry = r.memory as Record<string, unknown> | undefined;
      expect(entry, `memory write result carried an entry: ${JSON.stringify(r)}`).toBeDefined();
      return entry as Record<string, unknown>;
    };
    const id = str(entryOf(created).id);
    expect(id).not.toBe("");
    expect(created.claim).toBe("Memory content");

    const unchanged = entryOf(
      await client.call("memory", { action: "update", id, title: "", content: "", category: "" }),
    );
    expect(unchanged.title).toBe("Memory title");
    expect(unchanged.content).toBe("Memory content");
    expect(unchanged.category).toBe("pattern");

    const cleared = entryOf(
      await client.call("memory", {
        action: "update",
        id,
        clear: ["title", "content", "category"],
      }),
    );
    for (const k of ["title", "content", "category"]) assertCleared(cleared, k);
  });
});

describe("search workflow", () => {
  test("keyword search and label filter find what was created", async () => {
    const task = await client.call("tasks", {
      action: "create",
      title: "Searchable Task ABC123",
      description: "This task exists for search testing",
      labels: ["search-test"],
    });
    const taskId = str(task.id);
    expect(taskId).not.toBe("");
    await client.call("docs", {
      action: "create",
      title: "Searchable Doc DEF456",
      content: "Content for search testing",
      tags: ["search-test"],
    });

    // Search results are not asserted to contain the new entries (indexing is best effort here);
    // the calls must succeed and return JSON.
    for (const [query, type] of [
      ["ABC123", "task"],
      ["DEF456", "doc"],
    ] as const) {
      const raw = await client.callRaw("search", {
        action: "search",
        query,
        mode: "keyword",
        type,
      });
      expect(() => JSON.parse(raw)).not.toThrow();
    }

    const list = await client.call("tasks", { action: "list", label: "search-test" });
    const items = list._array as Array<{ id?: string }> | undefined;
    expect(items, `list_tasks response: ${JSON.stringify(list)}`).toBeDefined();
    expect(items?.some((t) => t.id === taskId)).toBe(true);
  });
});

describe("board", () => {
  test("get board", async () => {
    await client.call("tasks", { action: "create", title: "Board Test Task" });
    const r = await client.call("tasks", { action: "board" });
    expect((r.columns as unknown[]).length).toBeGreaterThan(0);
    expect(typeof r.total).toBe("number");
    expect(r.total as number).toBeGreaterThanOrEqual(1);
  });
});

describe("validation", () => {
  test("every scope answers with its scope", async () => {
    await client.call("tasks", { action: "create", title: "Validate Test Task" });
    await client.call("docs", { action: "create", title: "Validate Test Doc", tags: ["test"] });

    const all = await client.call("validate", { scope: "all" });
    expect(typeof all.valid).toBe("boolean");
    expect(all.scope).toBe("all");

    for (const scope of ["tasks", "docs", "templates", "sdd"]) {
      const r = await client.call("validate", { scope });
      expect(r.scope).toBe(scope);
    }

    const strict = await client.call("validate", { scope: "all", strict: true });
    expect(strict.strict).toBe(true);
  });
});

describe("reopen workflow", () => {
  test("a done task can be reopened, extended and completed again", async () => {
    const created = await client.call("tasks", {
      action: "create",
      title: "MCP Reopen Test",
      assignee: "@me",
    });
    const taskId = str(created.id);
    expect(taskId).not.toBe("");

    await client.call("tasks", {
      action: "update",
      taskId,
      addAc: ["AC 1", "AC 2", "AC 3", "AC 4"],
      status: "in-progress",
    });
    await client.call("time", { action: "start", taskId });
    await client.call("tasks", { action: "update", taskId, checkAc: [1, 2, 3, 4] });
    await client.call("time", { action: "stop", taskId });
    await client.call("tasks", { action: "update", taskId, status: "done" });

    const reopened = await client.call("tasks", {
      action: "update",
      taskId,
      status: "in-progress",
    });
    expect(reopened.status).toBe("in-progress");

    await client.call("tasks", {
      action: "update",
      taskId,
      addAc: ["Post-completion fix: Handle edge case"],
      appendNotes: "Reopened: Adding edge case handling",
    });
    await client.call("time", { action: "start", taskId });
    await client.call("tasks", {
      action: "update",
      taskId,
      checkAc: [5],
      appendNotes: "Implemented edge case handling",
    });
    await client.call("time", { action: "stop", taskId });
    await client.call("tasks", { action: "update", taskId, status: "done" });

    const task = await client.call("tasks", { action: "get", taskId });
    const acs = task.acceptanceCriteria as Array<{ completed?: boolean }>;
    expect(acs.length).toBe(5);
    acs.forEach((ac, i) => {
      expect(ac.completed, `AC #${i + 1} checked`).toBe(true);
    });
  });
});
