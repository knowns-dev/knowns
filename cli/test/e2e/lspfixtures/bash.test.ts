// Go -> TS mapping (tests/lspfixtures/bash_fixture_test.go):
//   TestLSPFixture_Bash -> "LSP fixture: Bash" > "symbols, definition, references and an
//   unsupported capability through MCP code tools"
// Needs bash-language-server; gated behind TEST_LSP_FIXTURES=1 (see helpers.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
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

const suite = shouldRun(["bash-language-server"]) ? describe : describe.skip;

function writeBashFixture(dir: string): void {
  const files: Record<string, string> = {
    "lib.sh": [
      "#!/usr/bin/env bash",
      "fixture_greet() {",
      "  printf 'hello %s\\n' \"$1\"",
      "}",
      "",
    ].join("\n"),
    "main.sh": ["#!/usr/bin/env bash", "source ./lib.sh", 'fixture_greet "Knowns"', ""].join("\n"),
  };
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, content);
    chmodSync(p, 0o755);
  }
}

suite("LSP fixture: Bash", () => {
  test(
    "symbols, definition, references and an unsupported capability through MCP code tools",
    async () => {
      requireTools("bash-language-server");
      const sb = makeSandbox();
      const dir = makeProjectDir(sb);
      writeBashFixture(dir);
      await initKnownsProject(sb, dir, "lsp-fixture-bash");

      const client = await FixtureMcp.start(sb, dir);
      try {
        await client.callToolUntilRawContains(90_000, "fixture_greet", "code", {
          action: "symbols",
          path: "lib.sh",
          depth: 2,
        });

        const definition = await client.callToolUntilRawContains(90_000, "lib.sh", "code", {
          action: "definition",
          path: "main.sh",
          query: "fixture_greet",
        });
        const file = String(definition.object?.file ?? "");
        expect(file.replaceAll("\\", "/").endsWith("/lib.sh") || file === "lib.sh").toBe(true);

        const references = await client.callToolUntilRawContains(90_000, "main.sh", "code", {
          action: "references",
          path: "lib.sh",
          query: "fixture_greet",
        });
        expect(references.array?.length ?? 0).toBeGreaterThan(0);

        const status = await client.requireLiveCapabilityStatus(
          "bash",
          "document_symbols",
          "definition",
          "references",
        );
        await client.requireUnsupportedCodeAction(
          status,
          "lib.sh",
          "fixture_greet",
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
