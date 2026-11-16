// Go -> TS mapping (tests/lspfixtures/terraform_fixture_test.go):
//   TestLSPFixture_Terraform -> "LSP fixture: Terraform" > "direct terraform-ls symbols,
//     definition and references, then MCP code tools"
//   TestWaitForTerraformReferencesQueryReportsInsufficientResults -> "waitForReferencesQuery" >
//     "reports insufficient results" (a unit test; it always runs, like the Go one)
// The direct half drives the in-process Manager with the terraform-ls adapter (Go:
// lsp.NewManager + adapters.NewTerraformLSAdapter). Needs terraform-ls and terraform; gated behind
// TEST_LSP_FIXTURES=1 and TEST_LSP_FIXTURE (terraform).
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newTerraformLSAdapter } from "../../../src/lsp/adapters/terraform.ts";
import { Config } from "../../../src/lsp/config.ts";
import type { Ctx } from "../../../src/lsp/context.ts";
import { Manager } from "../../../src/lsp/manager.ts";
import type { DocumentSymbol, Location } from "../../../src/lsp/types.ts";
import { sameFileURI } from "../../../src/lsp/uri.ts";
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

const suite = shouldRun(["terraform-ls", "terraform"], "terraform") ? describe : describe.skip;

function containsSymbol(symbols: DocumentSymbol[], name: string): boolean {
  return symbols.some((s) => s.name.includes(name) || containsSymbol(s.children ?? [], name));
}

const aborted = (ctx: Ctx) => ctx?.aborted === true;

async function waitForDefinition(ctx: Ctx, query: () => Promise<Location>): Promise<Location> {
  let lastErr: unknown;
  while (!aborted(ctx)) {
    try {
      return await query();
    } catch (e) {
      lastErr = e;
      await sleep(250);
    }
  }
  throw lastErr ?? new Error("timed out waiting for a definition");
}

/** Go waitForTerraformReferencesQuery: poll until at least `minimum` locations come back. */
export async function waitForReferencesQuery(
  ctx: Ctx,
  minimum: number,
  query: (ctx: Ctx) => Promise<Location[]>,
): Promise<Location[]> {
  let lastErr: unknown;
  let last: Location[] = [];
  while (!aborted(ctx)) {
    try {
      last = await query(ctx);
      if (last.length >= minimum) return last;
      lastErr = undefined;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  if (lastErr !== undefined) {
    throw new Error(
      `wait for at least ${minimum} Terraform references (last count ${last.length}): ${String(lastErr)}`,
    );
  }
  throw new Error(
    `wait for at least ${minimum} Terraform references: got ${last.length} before timeout`,
  );
}

describe("waitForReferencesQuery", () => {
  test("reports insufficient results", async () => {
    const ctx = AbortSignal.timeout(20);
    let error: Error | undefined;
    try {
      await waitForReferencesQuery(ctx, 2, async () => [
        {
          uri: "file:///main.tf",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ]);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain("got 1 before timeout");
  });
});

suite("LSP fixture: Terraform", () => {
  test(
    "direct terraform-ls symbols, definition and references, then MCP code tools",
    async () => {
      requireTools("terraform-ls", "terraform");
      const sb = makeSandbox();
      const dir = makeProjectDir(sb);
      const mainPath = join(dir, "main.tf");
      writeFileSync(
        mainPath,
        [
          'variable "fixture_name" {',
          "  type = string",
          "}",
          "",
          "locals {",
          "  fixture_value = var.fixture_name",
          "}",
          "",
          'output "fixture_output" {',
          "  value = local.fixture_value",
          "}",
          "",
          'output "fixture_copy" {',
          "  value = local.fixture_value",
          "}",
          "",
        ].join("\n"),
      );
      await initKnownsProject(sb, dir, "lsp-fixture-terraform");

      await withProcessEnv(sb.env, async () => {
        const manager = new Manager(dir, new Config());
        manager.registerAdapter(newTerraformLSAdapter());
        const ctx = AbortSignal.timeout(60_000);
        try {
          const [server, ok] = await manager.serverForPath(ctx, mainPath);
          if (!ok || !server) throw new Error("terraform-ls was not available for main.tf");
          const symbols = await server.documentSymbols(ctx, mainPath);
          for (const name of ["fixture_name", "fixture_output", "fixture_copy"]) {
            expect(containsSymbol(symbols, name), `document symbols missing ${name}`).toBe(true);
          }

          const definition = await waitForDefinition(ctx, () =>
            server.definition(ctx, mainPath, 9, 20),
          );
          expect(sameFileURI(definition.uri, mainPath)).toBe(true);
          expect(definition.range.start.line).toBe(5);

          const references = await waitForReferencesQuery(ctx, 2, (c) =>
            server.references(c, mainPath, 5, 4),
          );
          expect(references.length).toBeGreaterThanOrEqual(2);
          for (const r of references) expect(sameFileURI(r.uri, mainPath)).toBe(true);
        } finally {
          await manager.stopAll(AbortSignal.timeout(10_000)).catch(() => undefined);
        }
      });

      writeFileSync(join(dir, "generated.tf.json"), "fixture_value\n");

      const client = await FixtureMcp.start(sb, dir);
      try {
        await client.callToolUntilRawContains(60_000, "fixture_name", "code", {
          action: "symbols",
          path: "main.tf",
          depth: 2,
        });
        const status = await client.requireLiveCapabilityStatus(
          "terraform",
          "document_symbols",
          "definition",
          "references",
        );
        await client.requireUnsupportedCodeAction(
          status,
          "generated.tf.json",
          "fixture_value",
          "definition",
          "Terraform JSON configuration",
          false,
        );
      } finally {
        await client.close();
      }
    },
    10 * 60_000,
  );
});
