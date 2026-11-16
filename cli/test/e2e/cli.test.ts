// End to end CLI workflows against the TypeScript CLI (KNOWNS_TS_BIN, else `bun src/main.ts`).
// Ported from the Go suites under tests/ for task KN-NDD5YY (remove Go from the repo).
//
// Go test -> TS test (no existing TS test proved these through a real subprocess: the nearest ones
// are in-process Go-diff suites that go away with the Go binary, so nothing here is a duplicate)
//   e2e_cli_test.go          TestCLI_TaskLifecycle           -> "task lifecycle"
//   e2e_cli_test.go          TestCLI_DocumentWorkflow        -> "document workflow"
//   e2e_cli_test.go          TestCLI_CrossReferences         -> "cross references"
//   e2e_cli_test.go          TestCLI_Search                  -> "keyword search"
//   e2e_cli_test.go          TestCLI_Validation              -> "validation"
//   e2e_cli_test.go          TestCLI_ReopenWorkflow          -> "reopen workflow"
//   e2e_cli_test.go          TestCLI_Sync                    -> "sync"
//   e2e_cli_test.go          TestCLI_SemanticSearch          -> "semantic search" (TEST_SEMANTIC=1)
//   e2e_cli_text_verbatim    TextFlagsStoreBackslashSequencesVerbatim -> "text flags store ..."
//   e2e_cli_text_verbatim    AppendNotesSeparatesEntriesWithBlankLine  -> "append-notes ..."
//   e2e_structural_test.go   TestCLI_StructuralResolve       -> "structural resolve"
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  assertContains,
  extractTaskIDShort,
  registerCleanup,
  requireSuccess,
  runCli,
  setupTestProject,
} from "./harness.ts";

registerCleanup();

function created(dir: string, args: string[]): string {
  const res = runCli(dir, args);
  requireSuccess(res, `${args.join(" ")}`);
  const id = extractTaskIDShort(res.stdout + res.stderr);
  expect(id, `no task id in output:\n${res.stdout}\n${res.stderr}`).not.toBe("");
  return id;
}

function ok(dir: string, ...args: string[]): void {
  requireSuccess(runCli(dir, args), args.join(" "));
}

describe("task lifecycle", () => {
  test("create, criteria, time, plan, notes, done, report", () => {
    const dir = setupTestProject();
    const id = created(dir, [
      "task",
      "create",
      "E2E: Implement Auth Feature",
      "-d",
      "Implement JWT authentication for the API.",
      "--priority",
      "high",
      "-l",
      "e2e-test",
      "-l",
      "auth",
      "-l",
      "feature",
      "-a",
      "@me",
    ]);
    for (const ac of [
      "JWT tokens are generated on login",
      "Tokens expire after 1 hour",
      "Refresh token flow works",
      "Unit tests have >90% coverage",
    ]) {
      ok(dir, "task", "edit", id, "--ac", ac);
    }
    ok(dir, "time", "start", id);
    ok(dir, "task", "edit", id, "-s", "in-progress");
    ok(
      dir,
      "task",
      "edit",
      id,
      "--plan",
      "1. Research JWT best practices\n2. Design token structure\n3. Implement /login endpoint\n4. Implement /refresh endpoint\n5. Add auth middleware\n6. Write unit tests\n7. Update API documentation",
    );
    const notes = [
      "Implemented JWT generation using jsonwebtoken library",
      "Token expiry set to 1 hour, configurable via env",
      "Refresh token flow implemented with 7-day expiry",
      "24 unit tests, 94% coverage achieved",
    ];
    notes.forEach((note, i) => {
      ok(dir, "task", "edit", id, "--check-ac", String(i + 1));
      ok(dir, "task", "edit", id, "--append-notes", note);
    });
    ok(dir, "time", "stop");
    ok(
      dir,
      "task",
      "edit",
      id,
      "--notes",
      "## Summary\nImplemented complete JWT authentication system.\n\n## Changes\n- POST /api/auth/login\n- POST /api/auth/refresh\n- Added auth middleware\n\n## Tests\n- 24 unit tests\n- Coverage: 94%",
    );
    ok(dir, "task", "edit", id, "-s", "done");

    const view = runCli(dir, ["task", id, "--plain"]);
    requireSuccess(view, "view task");
    expect(view.stdout.toLowerCase()).toContain("done");
    expect(view.stdout.match(/\[x\]/gi)?.length ?? 0, view.stdout).toBe(4);

    ok(dir, "time", "report");
  });
});

describe("document workflow", () => {
  test("create, edit, view, append, search", () => {
    const dir = setupTestProject();
    ok(
      dir,
      "doc",
      "create",
      "Security Patterns",
      "-d",
      "Security patterns documentation",
      "-t",
      "test",
      "-t",
      "e2e",
      "-t",
      "security",
      "-f",
      "patterns",
    );
    ok(
      dir,
      "doc",
      "edit",
      "patterns/security-patterns",
      "-c",
      "# Security Patterns\n\n## Overview\nThis document describes security patterns.\n\n## JWT Authentication\n- Use RS256 algorithm\n- Short-lived access tokens (1 hour)\n- Long-lived refresh tokens (7 days)",
    );
    const get = runCli(dir, ["doc", "patterns/security-patterns", "--plain"]);
    requireSuccess(get, "get doc");
    assertContains(get.stdout, "JWT Authentication", "doc content");

    ok(
      dir,
      "doc",
      "edit",
      "patterns/security-patterns",
      "-a",
      "\n\n## References\n- Created by E2E test",
    );
    const again = runCli(dir, ["doc", "patterns/security-patterns", "--plain"]);
    assertContains(again.stdout, "Created by E2E test", "appended content");

    ok(dir, "search", "Security Patterns", "--type", "doc", "--plain");
  });
});

describe("cross references", () => {
  test("a task and a doc that reference each other show the references", () => {
    const dir = setupTestProject();
    ok(dir, "doc", "create", "Test Pattern", "-d", "Test doc", "-t", "test", "-f", "patterns");
    const id = created(dir, [
      "task",
      "create",
      "Task with references",
      "-d",
      "See @doc/patterns/test-pattern for guidelines",
    ]);
    ok(
      dir,
      "doc",
      "edit",
      "patterns/test-pattern",
      "-c",
      `# Test Pattern\n\n## Related Tasks\n- @task-${id}\n\n## See Also\n- @doc/patterns/test-pattern`,
    );
    const task = runCli(dir, ["task", id, "--plain"]);
    requireSuccess(task, "view task");
    assertContains(task.stdout, "patterns/test-pattern", "doc ref in task");
    const doc = runCli(dir, ["doc", "patterns/test-pattern", "--plain"]);
    requireSuccess(doc, "view doc");
    assertContains(doc.stdout, id, "task ref in doc");
  });
});

describe("keyword search", () => {
  test("finds a unique task title", () => {
    const dir = setupTestProject();
    const id = created(dir, [
      "task",
      "create",
      "Unique Search Target XYZ789",
      "-d",
      "This task exists for search testing",
      "-l",
      "search-test",
    ]);
    const res = runCli(dir, ["search", "XYZ789", "--keyword", "--plain"]);
    expect(res.exitCode, res.stderr).toBeLessThanOrEqual(1);
    // The plain listing names the hit by id; Go only checked the exit code, this checks the hit.
    assertContains(res.stdout, id, "search result");
  });
});

describe("validation", () => {
  test("validate runs for every scope (exit 0 clean, 1 warnings)", () => {
    const dir = setupTestProject();
    runCli(dir, ["task", "create", "Validation Test Task", "--ac", "Test criterion"]);
    runCli(dir, ["doc", "create", "Validation Test Doc", "-d", "Test doc", "-t", "test"]);
    for (const args of [
      ["validate", "--plain"],
      ["validate", "--scope", "tasks", "--plain"],
      ["validate", "--scope", "docs", "--plain"],
      ["validate", "--scope", "templates", "--plain"],
      ["validate", "--scope", "sdd", "--plain"],
    ]) {
      const res = runCli(dir, args);
      expect(res.exitCode, `${args.join(" ")}: ${res.stderr}`).toBeLessThanOrEqual(1);
    }
    // Strict mode may turn warnings into errors; it only has to run and exit deliberately.
    const strict = runCli(dir, ["validate", "--strict", "--plain"]);
    expect(strict.exitCode).toBeGreaterThanOrEqual(0);
    expect(strict.exitCode).toBeLessThan(128);
  });
});

describe("reopen workflow", () => {
  test("a done task reopens, gains a criterion and completes again", () => {
    const dir = setupTestProject();
    const id = created(dir, [
      "task",
      "create",
      "Reopen Test Task",
      "-d",
      "Task for reopen testing",
      "--ac",
      "AC 1",
      "--ac",
      "AC 2",
      "--ac",
      "AC 3",
      "--ac",
      "AC 4",
      "-a",
      "@me",
    ]);
    runCli(dir, ["task", "edit", id, "-s", "in-progress"]);
    runCli(dir, ["time", "start", id]);
    for (let i = 1; i <= 4; i++) runCli(dir, ["task", "edit", id, "--check-ac", String(i)]);
    runCli(dir, ["time", "stop"]);
    runCli(dir, ["task", "edit", id, "-s", "done"]);

    ok(dir, "task", "edit", id, "-s", "in-progress");
    ok(dir, "task", "edit", id, "--ac", "Post-completion fix: Handle edge case");
    ok(dir, "time", "start", id);
    ok(dir, "task", "edit", id, "--check-ac", "5");
    ok(dir, "time", "stop");
    ok(dir, "task", "edit", id, "-s", "done");

    const view = runCli(dir, ["task", id, "--plain"]);
    requireSuccess(view, "view task");
    expect(view.stdout.match(/\[x\]/gi)?.length ?? 0, view.stdout).toBe(5);
  });
});

describe("sync", () => {
  test("sync --instructions writes CLAUDE.md", () => {
    const dir = setupTestProject();
    const res = runCli(dir, ["sync", "--instructions", "--platform", "claude"]);
    requireSuccess(res, "sync instructions");
    const out = res.stdout + res.stderr;
    assertContains(out, "Checking agent instruction files");
    assertContains(out, "CLAUDE.md");
    assertContains(out, "Sync complete.");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  test("sync --skills installs skills", () => {
    const dir = setupTestProject();
    const res = runCli(dir, ["sync", "--skills"]);
    requireSuccess(res, "sync skills");
    const out = res.stdout + res.stderr;
    for (const s of ["Syncing", "skill(s)", "Synced", "Sync complete."]) assertContains(out, s);
  });
});

// Opt-in: TEST_SEMANTIC=1. It needs no reachable embedder; every step must survive an absent one.
describe.skipIf(process.env.TEST_SEMANTIC !== "1")("semantic search", () => {
  test("configure, status, reindex, search, doctor", () => {
    const dir = setupTestProject();
    ok(
      dir,
      "task",
      "create",
      "Auth Feature: JWT Implementation",
      "-d",
      "Implement JWT authentication for the API.",
      "--priority",
      "high",
      "-l",
      "auth",
      "-l",
      "feature",
    );
    ok(
      dir,
      "doc",
      "create",
      "Security Patterns",
      "-d",
      "Security patterns documentation",
      "-t",
      "security",
      "-f",
      "patterns",
    );
    ok(
      dir,
      "doc",
      "edit",
      "patterns/security-patterns",
      "-c",
      "# Security Patterns\n\n## JWT Authentication\n- Use RS256 algorithm\n- Short-lived access tokens\n- Refresh token flow",
    );
    for (const [k, v] of [
      ["settings.semanticSearch.enabled", "true"],
      ["settings.semanticSearch.provider", "ollama"],
      ["settings.semanticSearch.model", "qwen3-embedding:0.6b"],
    ] as const) {
      ok(dir, "config", "set", k, v);
    }
    ok(dir, "search", "--status-check");
    requireSuccess(runCli(dir, ["search", "--reindex"], { timeoutMs: 120_000 }), "reindex");
    for (const args of [
      ["search", "authentication security", "--type", "doc", "--plain"],
      ["search", "JWT implementation", "--type", "task", "--plain"],
      ["search", "Security Patterns", "--keyword", "--type", "doc", "--plain"],
    ]) {
      expect(runCli(dir, args).exitCode).toBeLessThanOrEqual(1);
    }
    const code = runCli(dir, [
      "search",
      "authentication security patterns",
      "--type",
      "code",
      "--json",
      "--limit",
      "10",
    ]);
    expect(code.exitCode, code.stderr).toBeLessThanOrEqual(1);
    const parsed = JSON.parse(code.stdout) as Array<{ type?: string }>;
    for (const item of parsed) expect(item.type).toBe("code");
    expect(runCli(dir, ["doctor", "--scope", "search"]).exitCode).toBeLessThanOrEqual(1);
  });
});

describe("text flags", () => {
  // Guards commit ecddf78: flag values reach storage unchanged, so a code snippet, a regex or a
  // Windows path survives a round trip.
  test("store backslash sequences verbatim", () => {
    const dir = setupTestProject();
    const sentinel = 'fmt.Println("a\\nb") and "C:\\new\\table"';
    const id = created(dir, ["task", "create", "CLI verbatim text", "-d", sentinel]);
    ok(dir, "task", "edit", id, "--plan", sentinel, "--notes", sentinel);
    const view = runCli(dir, ["task", id, "--plain"]);
    requireSuccess(view, "view task");
    expect(view.stdout.split(sentinel).length - 1, view.stdout).toBe(3);
  });

  test("append-notes separates entries with a blank line", () => {
    const dir = setupTestProject();
    const id = created(dir, ["task", "create", "CLI append separator"]);
    for (const note of ["first entry", "second entry"])
      ok(dir, "task", "edit", id, "--append-notes", note);
    const view = runCli(dir, ["task", id, "--plain"]);
    requireSuccess(view, "view task");
    expect(view.stdout).toContain("first entry\n\nsecond entry");
  });
});

describe("structural resolve", () => {
  const dir = setupTestProject();
  ok(
    dir,
    "doc",
    "create",
    "CLI Structural Spec",
    "--folder",
    "specs",
    "--tag",
    "spec",
    "--tag",
    "approved",
    "-c",
    "# CLI Structural Spec",
  );
  ok(dir, "task", "create", "CLI Struct Task", "--spec", "specs/cli-structural-spec");

  test("--direction returns the doc root and its edges", () => {
    const res = runCli(dir, [
      "resolve",
      "@doc/specs/cli-structural-spec{implements}",
      "--direction",
      "inbound",
      "--json",
    ]);
    requireSuccess(res, "resolve inbound");
    const out = JSON.parse(res.stdout) as { root?: { kind?: string }; edges?: unknown[] };
    expect(out.root?.kind).toBe("doc");
    expect((out.edges ?? []).length).toBeGreaterThan(0);
  });

  test("--depth prints Root and Edges in plain output", () => {
    const res = runCli(dir, [
      "resolve",
      "@doc/specs/cli-structural-spec{implements}",
      "--direction",
      "inbound",
      "--depth",
      "2",
      "--plain",
    ]);
    requireSuccess(res, "resolve depth 2");
    assertContains(res.stdout, "Root:");
    assertContains(res.stdout, "Edges:");
  });

  test("--relation keeps only that relation", () => {
    const res = runCli(dir, [
      "resolve",
      "@doc/specs/cli-structural-spec{spec}",
      "--direction",
      "inbound",
      "--relation",
      "spec",
      "--json",
    ]);
    requireSuccess(res, "resolve relation filter");
    const out = JSON.parse(res.stdout) as { edges?: Array<{ relation?: string }> };
    for (const e of out.edges ?? []) expect(e.relation).toBe("spec");
  });

  test("--type filter runs", () => {
    requireSuccess(
      runCli(dir, [
        "resolve",
        "@doc/specs/cli-structural-spec{references}",
        "--direction",
        "inbound",
        "--type",
        "task",
        "--json",
      ]),
      "resolve type filter",
    );
  });

  test("without structural flags the basic format is kept", () => {
    const res = runCli(dir, ["resolve", "@doc/specs/cli-structural-spec", "--json"]);
    requireSuccess(res, "resolve basic");
    assertContains(res.stdout, '"found"');
    assertContains(res.stdout, '"reference"');
  });
});
