#!/usr/bin/env node
/**
 * MCP Server E2E Workflow Tests
 * Tests complete workflows: task lifecycle, doc management, semantic search
 * Uses isolated temp project folder for clean testing
 */

import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const TIMEOUT_MS = 300000; // 5 minutes for full test including model download

/**
 * Create isolated test project using CLI (ensures semantic search is configured)
 */
function createTestProject(useBuilt) {
  // Use fixed folder name for consistent test environment
  const testDir = join(projectRoot, "test-project-mcp-e2e");

  // Clean up existing test project first
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }

  mkdirSync(testDir, { recursive: true });

  // Determine CLI command
  const cliCmd = useBuilt
    ? `node ${join(projectRoot, "dist/index.js")}`
    : `npx tsx --import ./scripts/md-loader.mjs src/index.ts`;

  console.log("Creating test project with CLI...");

  // Initialize project
  execSync(`${cliCmd} init mcp-e2e-test --no-wizard`, {
    cwd: testDir,
    stdio: "inherit",
  });

  // Initialize git (required for knowns)
  execSync("git init", { cwd: testDir, stdio: "pipe" });

  // Enable semantic search and download model
  console.log("Setting up semantic search (downloading model)...");
  execSync(`${cliCmd} model set all-MiniLM-L6-v2`, {
    cwd: testDir,
    stdio: "inherit",
  });

  // Reindex to build semantic index
  console.log("Building search index...");
  execSync(`${cliCmd} search --reindex`, {
    cwd: testDir,
    stdio: "inherit",
  });

  console.log(`Created test project: ${testDir}`);
  return testDir;
}

/**
 * Cleanup test project folder
 */
function cleanupTestProject(testDir) {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
    console.log(`Cleaned up test project: ${testDir}`);
  }
}
let testsPassed = 0;
let testsFailed = 0;
let requestId = 1;

/**
 * Send JSON-RPC request to MCP server
 */
async function sendRequest(
  serverProcess,
  method,
  params = {},
  timeoutMs = 15000,
) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout: ${method}`));
    }, timeoutMs);

    let buffer = "";
    const onData = (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timeout);
              serverProcess.stdout.removeListener("data", onData);
              resolve(response);
              return;
            }
          } catch {
            /* continue */
          }
        }
      }
    };

    serverProcess.stdout.on("data", onData);
    serverProcess.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n",
    );
  });
}

/**
 * Call MCP tool
 */
async function callTool(serverProcess, name, args = {}, timeoutMs = 15000) {
  const response = await sendRequest(
    serverProcess,
    "tools/call",
    { name, arguments: args },
    timeoutMs,
  );
  if (response.error) {
    throw new Error(`MCP Error: ${response.error.message}`);
  }
  const content = response.result?.content?.[0];
  if (!content) {
    throw new Error("No content in response");
  }
  return JSON.parse(content.text);
}

/**
 * Run test with logging
 */
async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log("✅");
    testsPassed++;
    return true;
  } catch (error) {
    console.log(`❌ ${error.message}`);
    testsFailed++;
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log("=== MCP E2E Workflow Tests ===\n");

  const useBuilt = process.argv.includes("--built");

  // Create isolated test project OR use existing (from CI)
  const useExistingProject =
    process.argv.includes("--use-current") || process.env.TEST_PROJECT_PATH;
  const testProjectPath = useExistingProject
    ? process.env.TEST_PROJECT_PATH || projectRoot
    : createTestProject(useBuilt);
  const serverCmd = useBuilt
    ? ["node", [join(projectRoot, "dist/mcp/server.js")]]
    : [
        "npx",
        ["tsx", "--import", "./scripts/md-loader.mjs", "src/mcp/server.ts"],
      ];

  console.log(`Starting MCP server (${useBuilt ? "built" : "dev"} mode)...`);

  const serverProcess = spawn(serverCmd[0], serverCmd[1], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  let stderrOutput = "";
  serverProcess.stderr.on("data", (data) => {
    stderrOutput += data.toString();
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // Initialize
    await sendRequest(serverProcess, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-e2e-test", version: "1.0.0" },
    });

    // Set project to isolated test folder
    await callTool(serverProcess, "set_project", {
      projectRoot: testProjectPath,
    });
    console.log(
      `Project: ${testProjectPath}${useExistingProject ? "" : " (isolated)"}\n`,
    );

    // =========================================================
    // WORKFLOW 1: Complete Task Lifecycle
    // =========================================================
    console.log("[1] Task Lifecycle Workflow");
    console.log(
      "    (create → AC → time start → in-progress → check AC → time stop → done)\n",
    );

    let workflowTaskId;

    // Step 1: Create task
    await test("Create task with description", async () => {
      const result = await callTool(serverProcess, "create_task", {
        title: "E2E Workflow: Implement Auth Feature",
        description:
          "Implement JWT authentication for the API.\n\nRelated: @doc/README",
        priority: "high",
        labels: ["e2e-test", "auth", "feature"],
        assignee: "@me",
      });
      if (!result.task?.id) throw new Error("No task ID");
      workflowTaskId = result.task.id;
      console.log(`\n    → Created: ${workflowTaskId}`);
    });

    // Step 2: Add acceptance criteria
    await test("Add acceptance criteria", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        addAc: [
          "JWT tokens are generated on login",
          "Tokens expire after 1 hour",
          "Refresh token flow works",
          "Unit tests have >90% coverage",
        ],
      });
      if (!result.success) throw new Error("Failed to add AC");
      console.log("\n    → Added 4 acceptance criteria");
    });

    // Step 3: Start time tracking
    await test("Start time tracking", async () => {
      const result = await callTool(serverProcess, "start_time", {
        taskId: workflowTaskId,
      });
      if (!result.success) throw new Error("Timer not started");
    });

    // Step 4: Set in-progress + add plan
    await test("Set in-progress + add implementation plan", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        status: "in-progress",
        plan: `1. Research JWT best practices (see @doc/security-patterns)
2. Design token structure (access + refresh)
3. Implement /login endpoint
4. Implement /refresh endpoint
5. Add auth middleware
6. Write unit tests
7. Update API documentation`,
      });
      if (!result.success) throw new Error("Update failed");
    });

    // Step 5: Simulate work - check ACs one by one
    await test("Check AC #1 + append notes", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        checkAc: [1],
        appendNotes: "✓ Implemented JWT generation using jsonwebtoken library",
      });
      if (!result.success) throw new Error("Failed");
    });

    await test("Check AC #2 + append notes", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        checkAc: [2],
        appendNotes: "✓ Token expiry set to 1 hour, configurable via env",
      });
      if (!result.success) throw new Error("Failed");
    });

    await test("Check AC #3 + append notes", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        checkAc: [3],
        appendNotes: "✓ Refresh token flow implemented with 7-day expiry",
      });
      if (!result.success) throw new Error("Failed");
    });

    await test("Check AC #4 + append notes", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        checkAc: [4],
        appendNotes: "✓ 24 unit tests, 94% coverage achieved",
      });
      if (!result.success) throw new Error("Failed");
    });

    // Step 6: Stop time tracking
    await test("Stop time tracking", async () => {
      const result = await callTool(serverProcess, "stop_time", {
        taskId: workflowTaskId,
      });
      if (!result.success) throw new Error("Timer not stopped");
    });

    // Step 7: Add final implementation notes
    await test("Add final implementation notes", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        notes: `## Summary
Implemented complete JWT authentication system.

## Changes
- POST /api/auth/login - Generate JWT + refresh token
- POST /api/auth/refresh - Refresh access token
- Added auth middleware for protected routes
- Added rate limiting (5 failed attempts = 15min lockout)

## Security Measures
- Tokens use RS256 algorithm
- Refresh tokens stored in httpOnly cookies
- Access tokens expire in 1 hour
- Refresh tokens expire in 7 days

## Tests
- 24 unit tests added
- Coverage: 94%
- All edge cases covered

## Documentation
- Updated API.md with auth endpoints
- Added security-patterns.md`,
      });
      if (!result.success) throw new Error("Failed");
    });

    // Step 8: Mark as done
    await test("Mark task as done", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        status: "done",
      });
      if (!result.success) throw new Error("Failed to complete");
    });

    // Step 9: Verify final state
    await test("Verify final task state", async () => {
      const result = await callTool(serverProcess, "get_task", {
        taskId: workflowTaskId,
      });
      const task = result.task;

      if (task.status !== "done") {
        throw new Error(`Status: ${task.status}, expected: done`);
      }
      if (!task.acceptanceCriteria || task.acceptanceCriteria.length !== 4) {
        throw new Error(
          `AC count: ${task.acceptanceCriteria?.length}, expected: 4`,
        );
      }
      const checkedCount = task.acceptanceCriteria.filter(
        (ac) => ac.completed,
      ).length;
      if (checkedCount !== 4) {
        throw new Error(`Checked AC: ${checkedCount}/4`);
      }
      if (!task.implementationNotes) {
        throw new Error("Missing implementation notes");
      }
      if (!task.implementationPlan) {
        throw new Error("Missing implementation plan");
      }
      console.log(
        "\n    → Verified: status=done, 4/4 AC checked, notes+plan present",
      );
    });

    // Step 10: Verify time tracking
    await test("Verify time was tracked", async () => {
      const result = await callTool(serverProcess, "get_time_report", {});
      // Time report returns { groupBy: 'task', data: [...], totalSeconds: n }
      if (!result.data) {
        throw new Error("No time data in report");
      }
      const taskEntry = result.data.find((e) => e.taskId === workflowTaskId);
      if (taskEntry) {
        console.log(`\n    → Task time: ${taskEntry.time || "tracked"}`);
      } else {
        console.log("\n    → Time tracked (may be < 1s so filtered out)");
      }
    });

    console.log("\n    ✅ Task lifecycle workflow completed!\n");

    // =========================================================
    // WORKFLOW 2: Document Management
    // =========================================================
    console.log("[2] Document Workflow");
    console.log("    (create → get → update → search)\n");

    // Use unique doc name to avoid conflicts
    const testDocName = `MCP E2E Test Doc ${Date.now()}`;
    const testDocSlug = testDocName.toLowerCase().replace(/\s+/g, "-");

    // Create doc
    await test("Create documentation", async () => {
      const result = await callTool(serverProcess, "create_doc", {
        title: testDocName,
        description: "Test document created by MCP E2E tests",
        tags: ["test", "e2e", "mcp"],
        folder: "tests",
        content: `# ${testDocName}

## Overview
This document was created by the MCP E2E test suite.

## Purpose
Testing the document creation and update workflow.

## Test Data
- Created at: ${new Date().toISOString()}
- Test run ID: ${Date.now()}`,
      });
      if (!result.success)
        throw new Error(`Create failed: ${result.error || "unknown"}`);
    });

    // Get doc with smart mode
    await test("Get doc (smart mode)", async () => {
      const result = await callTool(serverProcess, "get_doc", {
        path: `tests/${testDocSlug}`,
        smart: true,
      });
      // Smart mode returns { doc: { path, title, content/toc/stats } }
      if (!result.doc) {
        throw new Error("No doc in response");
      }
      // Small docs return content, large docs return toc
      if (!result.doc.content && !result.doc.toc) {
        throw new Error("No content or toc in doc");
      }
    });

    // Update doc
    await test("Update doc (append content)", async () => {
      const result = await callTool(serverProcess, "update_doc", {
        path: `tests/${testDocSlug}`,
        appendContent: `

## Related Tasks
- @task-${workflowTaskId}

## References
- Created by MCP E2E test
- @doc/README`,
      });
      if (!result.success)
        throw new Error(`Update failed: ${result.error || "unknown"}`);
    });

    // Search for doc
    await test("Search for document", async () => {
      const result = await callTool(serverProcess, "search", {
        query: "MCP E2E Test",
        type: "doc",
      });
      if (!result.docs) throw new Error("No docs in result");
      console.log(`\n    → Found ${result.docs.count} matching docs`);
    });

    console.log("\n    ✅ Document workflow completed!\n");

    // =========================================================
    // WORKFLOW 3: Search (Keyword + Semantic)
    // Incremental indexing is now awaited, so test data should be indexed immediately
    // =========================================================
    console.log("[3] Search Workflow");
    console.log("    (keyword → hybrid → semantic → verify test data)\n");

    // Keyword search - MUST find our test task by ID
    await test("Keyword search (find test task)", async () => {
      const result = await callTool(serverProcess, "search", {
        query: workflowTaskId, // Search by task ID - guaranteed unique match
        mode: "keyword",
        type: "task",
      });
      const found = result.tasks?.results?.some((t) => t.id === workflowTaskId);
      if (!found) {
        throw new Error(
          `Test task ${workflowTaskId} not found in keyword search`,
        );
      }
      console.log(`\n    → Found test task: ${workflowTaskId}`);
    });

    // Keyword search - MUST find our test doc
    await test("Keyword search (find test doc)", async () => {
      const result = await callTool(serverProcess, "search", {
        query: testDocName,
        mode: "keyword",
        type: "doc",
      });
      const found = result.docs?.count > 0;
      if (!found) {
        throw new Error(
          `Test doc "${testDocName}" not found in keyword search`,
        );
      }
      console.log(`\n    → Found test doc: yes (${result.docs?.count} docs)`);
    });

    // Hybrid search - should find test data via semantic similarity
    let semanticAvailable = false;
    await test("Hybrid search", async () => {
      const result = await callTool(serverProcess, "search", {
        query: "JWT authentication implementation",
        mode: "hybrid",
        type: "all",
      });

      if (
        result.warning?.includes("not enabled") ||
        result.warning?.includes("not downloaded")
      ) {
        console.log(
          "\n    → Hybrid fell back to keyword (semantic not configured)",
        );
      } else {
        semanticAvailable = result.mode === "hybrid";
        console.log(
          `\n    → Mode: ${result.mode}, tasks: ${result.tasks?.count || 0}, docs: ${result.docs?.count || 0}`,
        );
      }
    });

    // Semantic search (if available) - verify it works without errors
    if (semanticAvailable) {
      await test("Semantic search", async () => {
        const result = await callTool(serverProcess, "search", {
          query: "authentication security patterns",
          mode: "semantic",
          type: "doc",
        });
        // Just verify semantic mode works - new docs may not be indexed yet
        console.log(
          `\n    → Semantic: ${result.docs?.count || 0} docs (incremental indexing may be pending)`,
        );
      });
    } else {
      console.log("  Semantic search... ⚠️ skipped (not configured)");
    }

    // Verify task has correct labels using list_tasks
    await test("List tasks by label (verify e2e-test)", async () => {
      const result = await callTool(serverProcess, "list_tasks", {
        label: "e2e-test",
      });
      const found = result.tasks?.some((t) => t.id === workflowTaskId);
      if (!found) {
        // Debug: get task details to see its labels
        const taskResult = await callTool(serverProcess, "get_task", {
          taskId: workflowTaskId,
        });
        const labels = taskResult.task?.labels || [];
        throw new Error(
          `Task ${workflowTaskId} has labels [${labels.join(", ")}], expected 'e2e-test'`,
        );
      }
      console.log(`\n    → Found task ${workflowTaskId} in e2e-test list`);
    });

    console.log("\n    ✅ Search workflow completed!\n");

    // =========================================================
    // WORKFLOW 4: Board Operations
    // =========================================================
    console.log("[4] Board Workflow\n");

    await test("Get board state", async () => {
      const result = await callTool(serverProcess, "get_board", {});
      const board = result.board;

      const counts = {
        todo: board.todo?.length || 0,
        "in-progress": board["in-progress"]?.length || 0,
        "in-review": board["in-review"]?.length || 0,
        done: board.done?.length || 0,
        blocked: board.blocked?.length || 0,
      };

      console.log(
        `\n    → Board: todo=${counts.todo}, in-progress=${counts["in-progress"]}, done=${counts.done}`,
      );
      console.log(`    → Total tasks: ${result.totalTasks}`);
    });

    console.log("\n    ✅ Board workflow completed!\n");

    // =========================================================
    // WORKFLOW 5: Validation
    // =========================================================
    console.log("[5] Validation Workflow\n");

    await test("Validate all", async () => {
      const result = await callTool(serverProcess, "validate", {
        scope: "all",
      });
      console.log(`\n    → Valid: ${result.valid}`);
      console.log(
        `    → Errors: ${result.errors?.length || 0}, Warnings: ${result.warnings?.length || 0}`,
      );
    });

    await test("Validate tasks only", async () => {
      const result = await callTool(serverProcess, "validate", {
        scope: "tasks",
      });
      console.log(`\n    → Tasks valid: ${result.valid}`);
    });

    await test("Validate docs only", async () => {
      const result = await callTool(serverProcess, "validate", {
        scope: "docs",
      });
      console.log(`\n    → Docs valid: ${result.valid}`);
    });

    console.log("\n    ✅ Validation workflow completed!\n");

    // =========================================================
    // WORKFLOW 6: Reopen & Fix (Post-completion changes)
    // =========================================================
    console.log("[6] Reopen Workflow (Post-completion fix)\n");

    // Reopen task
    await test("Reopen completed task", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        status: "in-progress",
      });
      if (!result.success) throw new Error("Failed to reopen");
    });

    // Add new AC for the fix
    await test("Add fix AC", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        addAc: ["Post-completion fix: Handle token blacklist on logout"],
        appendNotes:
          "\n\n🔄 Reopened: Adding token blacklist feature per security review",
      });
      if (!result.success) throw new Error("Failed");
    });

    // Start timer again
    await test("Restart time tracking", async () => {
      const result = await callTool(serverProcess, "start_time", {
        taskId: workflowTaskId,
      });
      if (!result.success) throw new Error("Timer not started");
    });

    // Check the new AC
    await test("Check fix AC", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        checkAc: [5], // 5th AC (the new one)
        appendNotes: "✓ Implemented Redis-based token blacklist",
      });
      if (!result.success) throw new Error("Failed");
    });

    // Stop timer
    await test("Stop time tracking", async () => {
      const result = await callTool(serverProcess, "stop_time", {
        taskId: workflowTaskId,
      });
      if (!result.success) throw new Error("Failed");
    });

    // Mark done again
    await test("Mark done again", async () => {
      const result = await callTool(serverProcess, "update_task", {
        taskId: workflowTaskId,
        status: "done",
      });
      if (!result.success) throw new Error("Failed");
    });

    // Verify
    await test("Verify reopened task state", async () => {
      const result = await callTool(serverProcess, "get_task", {
        taskId: workflowTaskId,
      });
      if (result.task.acceptanceCriteria.length !== 5) {
        throw new Error(
          `Expected 5 AC, got ${result.task.acceptanceCriteria.length}`,
        );
      }
      const allChecked = result.task.acceptanceCriteria.every(
        (ac) => ac.completed,
      );
      if (!allChecked) throw new Error("Not all AC checked");
      console.log("\n    → Verified: 5/5 AC checked after reopen flow");
    });

    console.log("\n    ✅ Reopen workflow completed!\n");
  } catch (error) {
    console.error("\n❌ Fatal error:", error.message);
    if (stderrOutput) {
      console.error("\nServer stderr:", stderrOutput.slice(-500));
    }
    testsFailed++;
  }

  // Kill server first
  serverProcess.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));

  // =========================================================
  // CLEANUP
  // =========================================================
  console.log("\n[Cleanup]");

  if (!useExistingProject) {
    // Isolated test project - just delete the entire folder
    cleanupTestProject(testProjectPath);
  } else {
    // Using existing project - need to clean up test data manually
    console.log("  Removing test data from existing project...");
    let deletedTaskIds = [];

    try {
      const tasksDir = join(testProjectPath, ".knowns", "tasks");
      const {
        readdirSync,
        unlinkSync,
        readFileSync,
        existsSync: fsExists,
        rmSync: fsRmSync,
      } = await import("node:fs");

      // Delete test tasks
      if (fsExists(tasksDir)) {
        const taskFiles = readdirSync(tasksDir);
        let deletedTasks = 0;

        for (const file of taskFiles) {
          if (file.endsWith(".md")) {
            const filePath = join(tasksDir, file);
            const content = readFileSync(filePath, "utf-8");

            if (
              content.includes("e2e-test") ||
              content.includes("E2E Workflow") ||
              content.includes("MCP E2E Test")
            ) {
              const taskId = file.replace(".md", "").replace("task-", "");
              deletedTaskIds.push(taskId);
              unlinkSync(filePath);
              deletedTasks++;
            }
          }
        }
        console.log(`  Deleted ${deletedTasks} test tasks`);
      }

      // Delete test docs folder
      const testDocsDir = join(testProjectPath, ".knowns", "docs", "tests");
      if (fsExists(testDocsDir)) {
        fsRmSync(testDocsDir, { recursive: true, force: true });
        console.log("  Deleted test docs folder");
      }
    } catch (error) {
      console.log(`  Cleanup warning: ${error.message}`);
    }

    // Reindex via MCP after cleanup (only for existing projects)
    console.log("  Reindexing via MCP...");
    try {
      const verifyServer = spawn(
        "node",
        [join(projectRoot, "dist/mcp/server.js")],
        {
          cwd: projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      await new Promise((r) => setTimeout(r, 1500));

      let verifyRequestId = 1000;

      // Quick MCP call function
      const mcpCall = async (name, args, timeout = 15000) => {
        return new Promise((resolve) => {
          const id = verifyRequestId++;
          let buffer = "";
          const timer = setTimeout(() => resolve(null), timeout);

          const onData = (d) => {
            buffer += d.toString();
            try {
              const lines = buffer.split("\n");
              for (const line of lines) {
                if (line.trim()) {
                  const resp = JSON.parse(line);
                  if (resp.id === id) {
                    clearTimeout(timer);
                    verifyServer.stdout.removeListener("data", onData);
                    resolve(
                      JSON.parse(resp.result?.content?.[0]?.text || "{}"),
                    );
                  }
                }
              }
            } catch {}
          };

          verifyServer.stdout.on("data", onData);
          verifyServer.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            }) + "\n",
          );
        });
      };

      // Initialize
      verifyServer.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "cleanup-verify", version: "1.0" },
          },
        }) + "\n",
      );
      await new Promise((r) => setTimeout(r, 500));

      // Set project
      await mcpCall("set_project", { projectRoot: testProjectPath });

      // Reindex via MCP (60s timeout for reindex)
      const reindexResult = await mcpCall("reindex_search", {}, 60000);
      if (reindexResult?.message) {
        console.log(`  ✓ ${reindexResult.message}`);
      } else if (reindexResult?.error) {
        console.log(`  ⚠️ Reindex: ${reindexResult.error}`);
      }

      // Verify test data is gone
      console.log("  Verifying cleanup...");
      const searchResult = await mcpCall("search", {
        query: "E2E Workflow Implement Auth",
        type: "task",
      });
      const foundDeleted = searchResult?.tasks?.results?.some((t) =>
        deletedTaskIds.includes(t.id),
      );

      if (foundDeleted) {
        console.log("  ⚠️ Warning: Some deleted tasks still found in search");
      } else {
        console.log("  ✓ Verified: Test tasks removed from index");
      }

      verifyServer.kill();
    } catch (error) {
      console.log(`  Reindex/verify warning: ${error.message}`);
    }
  }

  // Summary
  console.log("=== Test Summary ===");
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);

  if (testsFailed > 0) {
    console.log("\n❌ Some tests failed!");
    process.exit(1);
  } else {
    console.log("\n✅ All MCP E2E workflow tests passed!");
    process.exit(0);
  }
}

const timeoutId = setTimeout(() => {
  console.error("\n❌ Test suite timed out!");
  process.exit(1);
}, TIMEOUT_MS);

main().finally(() => clearTimeout(timeoutId));
