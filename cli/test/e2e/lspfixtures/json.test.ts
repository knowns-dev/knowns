// Go -> TS mapping (tests/lspfixtures/json_fixture_test.go):
//   TestLSPFixture_JSONLocalSchema -> "LSP fixture: JSON local schema" > "direct server symbols
//   and schema diagnostics, then MCP code tools"
// The direct half drives the in-process Manager with the JSON adapter (Go: lsp.NewManager +
// adapters.NewJSONAdapter); the MCP half runs the TS binary. Needs node and
// vscode-json-languageserver; gated behind TEST_LSP_FIXTURES=1 and TEST_LSP_FIXTURE (json).
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newJSONAdapter } from "../../../src/lsp/adapters/json.ts";
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

const suite = shouldRun(["node", "vscode-json-languageserver"], "json") ? describe : describe.skip;

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

export function containsSymbol(symbols: DocumentSymbol[], name: string): boolean {
  return symbols.some((s) => s.name === name || containsSymbol(s.children ?? [], name));
}

suite("LSP fixture: JSON local schema", () => {
  test(
    "direct server symbols and schema diagnostics, then MCP code tools",
    async () => {
      requireTools("node", "vscode-json-languageserver");
      const sb = makeSandbox();
      const dir = makeProjectDir(sb);
      const schemaPath = join(dir, "schema.json");
      const configPath = join(dir, "service.json");
      writeFileSync(schemaPath, SCHEMA);
      writeFileSync(
        configPath,
        `{
  "$schema": ${JSON.stringify(fileURI(schemaPath))},
  "service": {
    "name": "payments",
    "port": "not-an-integer"
  }
	}`,
      );
      writeFileSync(join(dir, "unsupported.jsonc"), "fixture_probe\n");
      await initKnownsProject(sb, dir, "lsp-fixture-json");

      await withProcessEnv(sb.env, async () => {
        const manager = new Manager(dir, new Config());
        manager.registerAdapter(newJSONAdapter());
        const ctx = AbortSignal.timeout(30_000);
        try {
          const [server, ok] = await manager.serverForPath(ctx, configPath);
          if (!ok || !server) throw new Error("JSON server was not available for service.json");
          const symbols = await server.documentSymbols(ctx, configPath);
          expect(containsSymbol(symbols, "service") && containsSymbol(symbols, "port")).toBe(true);

          const deadline = Date.now() + 20_000;
          for (;;) {
            const diagnostics = await server.diagnostics(ctx, configPath);
            if (diagnostics.some((d) => d.message.toLowerCase().includes("integer"))) {
              expect(diagnostics.length).toBeGreaterThan(0);
              break;
            }
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
          path: "service.json",
          depth: 2,
        });
        await client.callToolUntilRawContains(60_000, "integer", "code", {
          action: "diagnostics",
          path: "service.json",
        });
        const status = await client.requireLiveCapabilityStatus(
          "json",
          "document_symbols",
          "diagnostics",
        );
        await client.requireUnsupportedCodeAction(
          status,
          "unsupported.jsonc",
          "fixture_probe",
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
