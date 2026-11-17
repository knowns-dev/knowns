// Go -> TS mapping (tests/lspfixtures/yaml_fixture_test.go):
//   TestLSPFixture_YAMLLocalSchema -> "LSP fixture: YAML local schema" > "direct server symbols
//   and schema diagnostics, then MCP code tools"
// The direct half drives the in-process Manager with the YAML adapter (Go: lsp.NewManager +
// adapters.NewYAMLAdapter); the MCP half runs the TS binary. Needs node and yaml-language-server;
// gated behind TEST_LSP_FIXTURES=1 and TEST_LSP_FIXTURE (yaml).
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newYAMLAdapter } from "../../../src/lsp/adapters/yaml.ts";
import { Config } from "../../../src/lsp/config.ts";
import { Manager } from "../../../src/lsp/manager.ts";
import type { DocumentSymbol } from "../../../src/lsp/types.ts";
import { fileURI } from "../../../src/lsp/uri.ts";
import { withProcessEnv } from "../../helpers/process-env.ts";
import {
  cleanupFixtures,
  FixtureMcp,
  initKnownsProject,
  makeProjectDir,
  makeSandbox,
  requireTools,
  shouldRun,
  sleep,
} from "./helpers.ts";

afterAll(cleanupFixtures);

const suite = shouldRun(["node", "yaml-language-server"], "yaml") ? describe : describe.skip;

const SCHEMA = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "service": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "port": {"type": "integer"}
      },
      "required": ["name", "port"]
    }
  },
  "required": ["service"]
}`;

function containsSymbol(symbols: DocumentSymbol[], name: string): boolean {
  return symbols.some((s) => s.name === name || containsSymbol(s.children ?? [], name));
}

suite("LSP fixture: YAML local schema", () => {
  test(
    "direct server symbols and schema diagnostics, then MCP code tools",
    async () => {
      requireTools("node", "yaml-language-server");
      const sb = makeSandbox();
      const dir = makeProjectDir(sb);
      const schemaPath = join(dir, "service.schema.json");
      const configPath = join(dir, "service.yaml");
      writeFileSync(schemaPath, SCHEMA);
      writeFileSync(
        configPath,
        [
          `# yaml-language-server: $schema=${fileURI(schemaPath)}`,
          "service:",
          "  name: payments",
          "  port: not-an-integer",
          "",
        ].join("\n"),
      );
      await initKnownsProject(sb, dir, "lsp-fixture-yaml");

      await withProcessEnv(sb.env, async () => {
        const manager = new Manager(dir, new Config());
        manager.registerAdapter(newYAMLAdapter());
        const ctx = AbortSignal.timeout(30_000);
        try {
          const [server, ok] = await manager.serverForPath(ctx, configPath);
          if (!ok || !server) throw new Error("YAML server was not available for service.yaml");
          const symbols = await server.documentSymbols(ctx, configPath);
          expect(containsSymbol(symbols, "service") && containsSymbol(symbols, "port")).toBe(true);

          const deadline = Date.now() + 20_000;
          for (;;) {
            const diagnostics = await server.diagnostics(ctx, configPath);
            if (diagnostics.some((d) => d.message.toLowerCase().includes("integer"))) break;
            if (Date.now() > deadline) {
              throw new Error(
                `expected local-schema integer diagnostic, got: ${JSON.stringify(diagnostics)}; capabilities: ${JSON.stringify(server.capabilitySnapshot())}`,
              );
            }
            await sleep(250);
          }
        } finally {
          await manager.stopAll(AbortSignal.timeout(10_000)).catch(() => undefined);
        }
      });

      const client = await FixtureMcp.start(sb, dir);
      try {
        await client.callToolUntilRawContains(60_000, "service", "code", {
          action: "symbols",
          path: "service.yaml",
          depth: 2,
        });
        await client.callToolUntilRawContains(60_000, "integer", "code", {
          action: "diagnostics",
          path: "service.yaml",
        });
        const status = await client.requireLiveCapabilityStatus(
          "yaml",
          "document_symbols",
          "diagnostics",
        );
        await client.requireUnsupportedCodeAction(
          status,
          "service.yaml",
          "service",
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
