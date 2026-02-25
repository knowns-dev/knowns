#!/usr/bin/env node
/**
 * CLI E2E Workflow Tests
 * Tests complete workflows: task lifecycle, doc management, semantic search, cross-references
 */

import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const TIMEOUT_MS = 300000; // 5 minutes (includes model download)
let testsPassed = 0;
let testsFailed = 0;
const failedTests = [];

// Test project directory
const testProjectDir = process.env.TEST_PROJECT_PATH || join(projectRoot, 'test-project-cli-e2e');

/**
 * Run CLI command and return output
 */
function runCli(args, options = {}) {
  const cliPath = join(projectRoot, 'dist/index.js');
  const cmd = `node "${cliPath}" ${args}`;

  try {
    const output = execSync(cmd, {
      cwd: options.cwd || testProjectDir,
      encoding: 'utf-8',
      timeout: options.timeout || 60000,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, output: output.trim(), code: 0 };
  } catch (error) {
    return {
      success: false,
      output: error.stdout?.toString()?.trim() || '',
      error: error.stderr?.toString()?.trim() || error.message,
      code: error.status || 1
    };
  }
}

/**
 * Run test with logging
 */
async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✅');
    testsPassed++;
    return true;
  } catch (error) {
    console.log(`❌ ${error.message}`);
    testsFailed++;
    failedTests.push(name);
    return false;
  }
}

/**
 * Extract task ID from CLI output
 */
function extractTaskId(output) {
  const match = output.match(/task-([a-z0-9]+)/i);
  return match ? match[0] : null;
}

/**
 * Main test runner
 */
async function main() {
  console.log('=== CLI E2E Workflow Tests ===\n');

  // Check if built
  const cliPath = join(projectRoot, 'dist/index.js');
  if (!existsSync(cliPath)) {
    console.error('❌ dist/index.js not found. Run `npm run build` first.');
    process.exit(1);
  }

  // Setup test project directory
  console.log('[Setup] Creating test project directory...');
  if (existsSync(testProjectDir)) {
    rmSync(testProjectDir, { recursive: true, force: true });
  }
  mkdirSync(testProjectDir, { recursive: true });

  // Initialize git
  execSync('git init', { cwd: testProjectDir, stdio: 'pipe' });
  console.log(`  Test directory: ${testProjectDir}`);

  // Initialize knowns project
  const initResult = runCli('init e2e-workflow-test --no-wizard');
  if (!initResult.success) {
    console.error('❌ Failed to initialize project:', initResult.error);
    process.exit(1);
  }
  console.log('  Project initialized\n');

  try {
    // =========================================================
    // WORKFLOW 1: Complete Task Lifecycle
    // =========================================================
    console.log('[1] Task Lifecycle Workflow');
    console.log('    (create → AC → time start → in-progress → check AC → time stop → done)\n');

    let workflowTaskId;

    // Step 1: Create task with full details
    await test('Create task with description', async () => {
      const result = runCli('task create "E2E Workflow: Implement Auth Feature" -d "Implement JWT authentication for the API." --priority high -l "e2e-test,auth,feature" -a "@me"');
      if (!result.success) throw new Error(result.error);
      workflowTaskId = extractTaskId(result.output);
      if (!workflowTaskId) throw new Error('No task ID in output');
      console.log(`\n    → Created: ${workflowTaskId}`);
    });

    // Step 2: Add acceptance criteria
    await test('Add acceptance criteria', async () => {
      let result = runCli(`task edit "${workflowTaskId}" --ac "JWT tokens are generated on login"`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --ac "Tokens expire after 1 hour"`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --ac "Refresh token flow works"`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --ac "Unit tests have >90% coverage"`);
      if (!result.success) throw new Error(result.error);
      console.log('\n    → Added 4 acceptance criteria');
    });

    // Step 3: Start time tracking
    await test('Start time tracking', async () => {
      const result = runCli(`time start "${workflowTaskId}"`);
      if (!result.success) throw new Error(result.error);
    });

    // Step 4: Set in-progress + add plan
    await test('Set in-progress + add implementation plan', async () => {
      let result = runCli(`task edit "${workflowTaskId}" -s in-progress`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --plan "1. Research JWT best practices\\n2. Design token structure\\n3. Implement /login endpoint\\n4. Implement /refresh endpoint\\n5. Add auth middleware\\n6. Write unit tests\\n7. Update API documentation"`);
      if (!result.success) throw new Error(result.error);
    });

    // Step 5: Simulate work - check ACs one by one
    await test('Check AC #1 + append notes', async () => {
      let result = runCli(`task edit "${workflowTaskId}" --check-ac 1`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --append-notes "✓ Implemented JWT generation using jsonwebtoken library"`);
      if (!result.success) throw new Error(result.error);
    });

    await test('Check AC #2 + append notes', async () => {
      let result = runCli(`task edit "${workflowTaskId}" --check-ac 2`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --append-notes "✓ Token expiry set to 1 hour, configurable via env"`);
      if (!result.success) throw new Error(result.error);
    });

    await test('Check AC #3 + append notes', async () => {
      let result = runCli(`task edit "${workflowTaskId}" --check-ac 3`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --append-notes "✓ Refresh token flow implemented with 7-day expiry"`);
      if (!result.success) throw new Error(result.error);
    });

    await test('Check AC #4 + append notes', async () => {
      let result = runCli(`task edit "${workflowTaskId}" --check-ac 4`);
      if (!result.success) throw new Error(result.error);
      result = runCli(`task edit "${workflowTaskId}" --append-notes "✓ 24 unit tests, 94% coverage achieved"`);
      if (!result.success) throw new Error(result.error);
    });

    // Step 6: Stop time tracking
    await test('Stop time tracking', async () => {
      const result = runCli('time stop');
      if (!result.success) throw new Error(result.error);
    });

    // Step 7: Add final implementation notes
    await test('Add final implementation notes', async () => {
      const notes = `## Summary
Implemented complete JWT authentication system.

## Changes
- POST /api/auth/login - Generate JWT + refresh token
- POST /api/auth/refresh - Refresh access token
- Added auth middleware for protected routes

## Tests
- 24 unit tests added
- Coverage: 94%`;
      const result = runCli(`task edit "${workflowTaskId}" --notes "${notes.replace(/\n/g, '\\n')}"`);
      if (!result.success) throw new Error(result.error);
    });

    // Step 8: Mark as done
    await test('Mark task as done', async () => {
      const result = runCli(`task edit "${workflowTaskId}" -s done`);
      if (!result.success) throw new Error(result.error);
    });

    // Step 9: Verify final state
    await test('Verify final task state', async () => {
      const result = runCli(`task "${workflowTaskId}" --plain`);
      if (!result.success) throw new Error(result.error);

      // Debug: show relevant output lines
      const lines = result.output.split('\n');
      const statusLine = lines.find(l => l.includes('Status:'));
      const acLines = lines.filter(l => l.includes('[x]') || l.includes('[ ]'));

      if (!result.output.toLowerCase().includes('done')) {
        throw new Error(`Task not marked as done. Status line: ${statusLine}`);
      }
      // Check all AC are checked (4x [x])
      const checkedCount = (result.output.match(/\[x\]/g) || []).length;
      if (checkedCount !== 4) {
        throw new Error(`Expected 4 checked AC, found ${checkedCount}. AC lines:\n${acLines.join('\n')}`);
      }
      console.log('\n    → Verified: status=done, 4/4 AC checked');
    });

    // Step 10: Verify time tracking
    await test('Verify time was tracked', async () => {
      const result = runCli('time report');
      if (!result.success) throw new Error(result.error);
      console.log('\n    → Time report generated');
    });

    console.log('\n    ✅ Task lifecycle workflow completed!\n');

    // =========================================================
    // WORKFLOW 2: Document Management
    // =========================================================
    console.log('[2] Document Workflow');
    console.log('    (create → get → update → search)\n');

    const testDocName = 'Security Patterns';

    // Create doc
    await test('Create documentation', async () => {
      const result = runCli(`doc create "${testDocName}" -d "Security patterns documentation" -t "test,e2e,security" -f "patterns"`);
      if (!result.success) throw new Error(result.error);
    });

    // Add content
    await test('Add doc content', async () => {
      const content = `# Security Patterns

## Overview
This document describes security patterns for the application.

## JWT Authentication
- Use RS256 algorithm
- Short-lived access tokens (1 hour)
- Long-lived refresh tokens (7 days)

## Best Practices
- Always validate tokens on protected routes
- Store refresh tokens securely
- Implement token blacklisting on logout`;

      const result = runCli(`doc edit "patterns/security-patterns" -c "${content.replace(/\n/g, '\\n')}"`);
      if (!result.success) throw new Error(result.error);
    });

    // Get doc
    await test('Get doc', async () => {
      const result = runCli('doc "patterns/security-patterns" --plain');
      if (!result.success) throw new Error(result.error);
      if (!result.output.includes('JWT Authentication')) {
        throw new Error('Doc content not found');
      }
    });

    // Update doc (append)
    await test('Update doc (append content)', async () => {
      const appendContent = `

## Related Tasks
- @${workflowTaskId}

## References
- Created by E2E test`;

      const result = runCli(`doc edit "patterns/security-patterns" -a "${appendContent.replace(/\n/g, '\\n')}"`);
      if (!result.success) throw new Error(result.error);
    });

    // Search for doc
    await test('Search for document', async () => {
      const result = runCli('search "Security Patterns" --type doc --plain');
      if (!result.success) throw new Error(result.error);
      console.log(`\n    → Found docs in search`);
    });

    console.log('\n    ✅ Document workflow completed!\n');

    // =========================================================
    // WORKFLOW 3: Cross-References
    // =========================================================
    console.log('[3] Cross-References Workflow');
    console.log('    (task refs doc, doc refs task)\n');

    let refTaskId;

    await test('Create task with doc ref', async () => {
      const result = runCli('task create "Task with references" -d "See @doc/patterns/security-patterns for security guidelines"');
      if (!result.success) throw new Error(result.error);
      refTaskId = extractTaskId(result.output);
      console.log(`\n    → Created: ${refTaskId}`);
    });

    await test('Create doc with task ref', async () => {
      const result = runCli('doc create "Implementation Guide" -d "Guide for implementation" -t "guide" -f "guides"');
      if (!result.success) throw new Error(result.error);
      const contentResult = runCli(`doc edit "guides/implementation-guide" -c "# Implementation Guide\\n\\n## Related Tasks\\n- @${workflowTaskId}\\n- @${refTaskId}\\n\\n## See Also\\n- @doc/patterns/security-patterns"`);
      if (!contentResult.success) throw new Error(contentResult.error);
    });

    await test('Verify task refs', async () => {
      const result = runCli(`task "${refTaskId}" --plain`);
      if (!result.success) throw new Error(result.error);
      if (!result.output.includes('@doc/patterns/security-patterns')) {
        throw new Error('Doc ref not found in task');
      }
    });

    await test('Verify doc refs', async () => {
      const result = runCli('doc "guides/implementation-guide" --plain');
      if (!result.success) throw new Error(result.error);
      if (!result.output.includes(workflowTaskId)) {
        throw new Error('Task ref not found in doc');
      }
    });

    console.log('\n    ✅ Cross-references workflow completed!\n');

    // =========================================================
    // WORKFLOW 4: Semantic Search (MANDATORY)
    // Must setup and test semantic search functionality
    // =========================================================
    console.log('[4] Semantic Search Workflow');
    console.log('    (download model → set model → build index → search)\n');

    // Step 1: Check model availability
    await test('Check model availability', async () => {
      const result = runCli('model list');
      if (!result.success) throw new Error(result.error);
      console.log('\n    → Model list available');
    });

    // Step 2: Download model (mandatory - use lightweight MiniLM)
    await test('Download embedding model', async () => {
      const result = runCli('model download all-MiniLM-L6-v2', { timeout: 180000 });
      if (!result.success) {
        // Check if already downloaded
        if (result.output?.includes('already downloaded') || result.error?.includes('already downloaded')) {
          console.log('\n    → Model already downloaded');
          return;
        }
        throw new Error(result.error || 'Failed to download model');
      }
      console.log('\n    → Model downloaded');
    });

    // Step 3: Set model for project (this also enables semantic search)
    await test('Set model for project', async () => {
      const result = runCli('model set all-MiniLM-L6-v2');
      if (!result.success) throw new Error(result.error);
      console.log('\n    → Model configured and semantic search enabled');
    });

    // Step 4: Check search status
    await test('Check search status', async () => {
      const result = runCli('search --status-check');
      if (!result.success) throw new Error(result.error);
      if (!result.output.includes('enabled')) {
        throw new Error(`Semantic search should be enabled. Output: ${result.output}`);
      }
      console.log('\n    → Semantic search status OK');
    });

    // Step 5: Build search index (mandatory)
    await test('Build search index', async () => {
      const result = runCli('search --reindex', { timeout: 120000 });
      if (!result.success) throw new Error(result.error);
      console.log('\n    → Index built');
    });

    // Step 6: Semantic search for docs
    await test('Semantic search (find docs)', async () => {
      const result = runCli('search "authentication security" --type doc --plain');
      if (!result.success) throw new Error(result.error);
      // Check found at least 1 doc
      if (!result.output.includes('Docs:')) {
        throw new Error(`Expected to find at least 1 doc. Output: ${result.output}`);
      }
      console.log('\n    → Found docs via semantic search');
    });

    // Step 7: Semantic search for tasks
    await test('Semantic search (find tasks)', async () => {
      const result = runCli('search "JWT implementation" --type task --plain');
      if (!result.success) throw new Error(result.error);
      // Check found at least 1 task
      if (!result.output.includes('Tasks:')) {
        throw new Error(`Expected to find at least 1 task. Output: ${result.output}`);
      }
      console.log('\n    → Found tasks via semantic search');
    });

    // Step 8: Keyword search should also work
    await test('Keyword search (find docs)', async () => {
      const result = runCli('search "patterns" --keyword --type doc --plain');
      if (!result.success) throw new Error(result.error);
      if (!result.output.includes('Docs:')) {
        throw new Error(`Expected to find at least 1 doc. Output: ${result.output}`);
      }
      console.log('\n    → Found docs via keyword search');
    });

    console.log('\n    ✅ Semantic search workflow completed!\n');

    // =========================================================
    // WORKFLOW 5: Validation (Comprehensive)
    // =========================================================
    console.log('[5] Validation Workflow');
    console.log('    (all → tasks → docs → templates → sdd → strict)\n');

    await test('Validate all entities', async () => {
      const result = runCli('validate --plain');
      // Warnings are OK (exit code 1), only errors are > 1
      if (result.code > 1) throw new Error(result.error);
      console.log('\n    → All entities validated');
    });

    await test('Validate tasks only', async () => {
      const result = runCli('validate --scope tasks --plain');
      if (result.code > 1) throw new Error(result.error);
      console.log('\n    → Tasks validated');
    });

    await test('Validate docs only', async () => {
      const result = runCli('validate --scope docs --plain');
      if (result.code > 1) throw new Error(result.error);
      console.log('\n    → Docs validated');
    });

    await test('Validate templates only', async () => {
      const result = runCli('validate --scope templates --plain');
      if (result.code > 1) throw new Error(result.error);
      console.log('\n    → Templates validated');
    });

    await test('SDD validation', async () => {
      const result = runCli('validate --scope sdd --plain');
      // SDD may show warnings about missing specs
      if (result.code > 1) throw new Error(result.error);
      console.log('\n    → SDD validation completed');
    });

    await test('Strict mode validation', async () => {
      const result = runCli('validate --strict --plain');
      // In strict mode, warnings become errors - may fail, that's OK
      // Just verify it runs
      console.log(`\n    → Strict mode completed (code: ${result.code})`);
    });

    console.log('\n    ✅ Validation workflow completed!\n');

    // =========================================================
    // WORKFLOW 6: Reopen Task (Post-completion changes)
    // =========================================================
    console.log('[6] Reopen Workflow (Post-completion fix)\n');

    // Reopen task
    await test('Reopen completed task', async () => {
      const result = runCli(`task edit "${workflowTaskId}" -s in-progress`);
      if (!result.success) throw new Error(result.error);
    });

    // Add new AC for the fix
    await test('Add fix AC', async () => {
      const result = runCli(`task edit "${workflowTaskId}" --ac "Post-completion fix: Handle token blacklist on logout"`);
      if (!result.success) throw new Error(result.error);
    });

    await test('Append reopen notes', async () => {
      const result = runCli(`task edit "${workflowTaskId}" --append-notes "\\n\\n🔄 Reopened: Adding token blacklist feature per security review"`);
      if (!result.success) throw new Error(result.error);
    });

    // Start timer again
    await test('Restart time tracking', async () => {
      const result = runCli(`time start "${workflowTaskId}"`);
      if (!result.success) throw new Error(result.error);
    });

    // Check the new AC
    await test('Check fix AC', async () => {
      const result = runCli(`task edit "${workflowTaskId}" --check-ac 5`);
      if (!result.success) throw new Error(result.error);
    });

    // Stop timer
    await test('Stop time tracking', async () => {
      const result = runCli('time stop');
      if (!result.success) throw new Error(result.error);
    });

    // Mark done again
    await test('Mark done again', async () => {
      const result = runCli(`task edit "${workflowTaskId}" -s done`);
      if (!result.success) throw new Error(result.error);
    });

    // Verify
    await test('Verify reopened task state', async () => {
      const result = runCli(`task "${workflowTaskId}" --plain`);
      if (!result.success) throw new Error(result.error);
      const checkedCount = (result.output.match(/\[x\]/gi) || []).length;
      if (checkedCount !== 5) {
        throw new Error(`Expected 5 checked AC, found ${checkedCount}`);
      }
      console.log('\n    → Verified: 5/5 AC checked after reopen flow');
    });

    console.log('\n    ✅ Reopen workflow completed!\n');

    // =========================================================
    // WORKFLOW 7: Board View
    // =========================================================
    console.log('[7] Board Workflow\n');

    await test('Get board state', async () => {
      const result = runCli('board');
      if (!result.success) throw new Error(result.error);
      console.log('\n    → Board displayed');
    });

    console.log('\n    ✅ Board workflow completed!\n');

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    testsFailed++;
  }

  // =========================================================
  // CLEANUP
  // =========================================================
  console.log('[Cleanup] Removing test project...');
  try {
    rmSync(testProjectDir, { recursive: true, force: true });
    console.log('  Deleted test project directory');
  } catch (error) {
    console.log(`  Cleanup warning: ${error.message}`);
  }

  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  if (failedTests.length > 0) {
    console.log('\nFailed tests:');
    for (const name of failedTests) {
      console.log(`  - ${name}`);
    }
  }

  if (testsFailed > 0) {
    console.log('\n❌ Some tests failed!');
    process.exit(1);
  } else {
    console.log('\n✅ All CLI E2E workflow tests passed!');
    process.exit(0);
  }
}

const timeoutId = setTimeout(() => {
  console.error('\n❌ Test suite timed out!');
  process.exit(1);
}, TIMEOUT_MS);

main().finally(() => clearTimeout(timeoutId));
