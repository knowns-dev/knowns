// Go -> TS mapping (tests/lspfixtures/markdown_fixture_test.go):
//   TestLSPFixture_MarkdownMarksman -> "LSP fixture: Markdown (Marksman)" > "symbols and a
//   broken-link diagnostic through MCP code tools"
// Needs marksman; gated behind TEST_LSP_FIXTURES=1 (see helpers.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupFixtures,
  FixtureMcp,
  initKnownsProject,
  makeProjectDir,
  makeSandbox,
  requireTools,
  shouldRun,
} from "./helpers.ts";

afterAll(cleanupFixtures);

const suite = shouldRun(["marksman"]) ? describe : describe.skip;

suite("LSP fixture: Markdown (Marksman)", () => {
  test(
    "symbols and a broken-link diagnostic through MCP code tools",
    async () => {
      requireTools("marksman");
      const sb = makeSandbox();
      const dir = makeProjectDir(sb);
      writeFileSync(join(dir, ".marksman.toml"), "");
      writeFileSync(
        join(dir, "README.md"),
        [
          "# Markdown Fixture",
          "",
          "## Overview",
          "",
          "This unresolved wiki link must be diagnosed: [[missing-note]].",
        ].join("\n"),
      );
      writeFileSync(join(dir, "existing-note.md"), "# Existing Note\n");
      await initKnownsProject(sb, dir, "lsp-fixture-markdown");

      const client = await FixtureMcp.start(sb, dir);
      try {
        await client.callToolUntilRawContains(60_000, "Overview", "code", {
          action: "symbols",
          path: "README.md",
          depth: 2,
        });
        const diagnostics = await client.callToolUntilRawContains(60_000, "missing-note", "code", {
          action: "diagnostics",
          path: "README.md",
        });
        expect(diagnostics.raw).toContain("Link to non-existent document");
        const status = await client.requireLiveCapabilityStatus(
          "markdown",
          "document_symbols",
          "diagnostics",
        );
        await client.requireUnsupportedCodeAction(
          status,
          "README.md",
          "Overview",
          "implementations",
          "implementation capability",
          true,
        );
      } finally {
        await client.close();
      }
    },
    10 * 60_000,
  );
});
