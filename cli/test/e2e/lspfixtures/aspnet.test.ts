// Go -> TS mapping (tests/lspfixtures/lsp_fixture_test.go, TestLSPFixture_ASPNETCoreWebAPI; its
// three t.Run subtests are three tests here, run in order on one shared fixture):
//   "cli runtime status"    -> "cli runtime status" (`knowns lsp list --json`)
//   "mcp code tools"        -> "mcp code tools" (symbols, definition, references, diagnostics,
//                              replace_body, then `dotnet build`)
//   "http lsp language api" -> "http lsp language api" (`knowns browser`, /api/lsp/languages)
// The fixture is the pinned ASP.NET Core app workshop commit, cloned at test time (no fixture
// files live in the repo). Needs git, dotnet and csharp-ls; gated behind TEST_LSP_FIXTURES=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type BrowserServer,
  cleanupFixtures,
  FixtureMcp,
  freePort,
  initKnownsProject,
  type LanguageStatus,
  makeProjectDir,
  makeSandbox,
  mustRun,
  readFailureFile,
  requireLanguage,
  requireTools,
  runKnownsJSON,
  type Sandbox,
  shouldRun,
  sleep,
  startBrowser,
  waitForJSON,
} from "./helpers.ts";

const REPO = "https://github.com/dotnet-presentations/aspnetcore-app-workshop.git";
const COMMIT = "3b00fd4ed1ae85c725d12ac6f03cae82cf8d16cc";
const PROJECT_SUBDIR = "src/ConferencePlanner";
const PROBE_FILE = "BackEnd/Endpoints/SpeakerEndpoints.cs";
const PROBE_SYMBOL = "MapSpeakerEndpoints";
const EDIT_FILE = "BackEnd/Endpoints/SearchEndpoints.cs";
const EDIT_SYMBOL = "MapSearchEndpoints";
const SYMBOL_WAIT_MS = 3 * 60_000;

afterAll(cleanupFixtures);

const suite = shouldRun(["git", "dotnet", "csharp-ls"]) ? describe : describe.skip;

suite("LSP fixture: ASP.NET Core Web API (C#)", () => {
  let sb: Sandbox;
  let projectDir = "";
  let csharpLogPath = "";

  beforeAll(async () => {
    requireTools("git", "dotnet", "csharp-ls");
    sb = makeSandbox();
    const repoDir = makeProjectDir(sb, "aspnetcore-app-workshop");
    const env = { ...(process.env as Record<string, string>), ...sb.env };
    await mustRun(undefined, 180_000, env, ["git", "init", repoDir]);
    await mustRun(repoDir, 30_000, env, ["git", "remote", "add", "origin", REPO]);
    await mustRun(repoDir, 180_000, env, [
      "git",
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      COMMIT,
    ]);
    await mustRun(repoDir, 60_000, env, ["git", "checkout", "--detach", "FETCH_HEAD"]);
    const head = (await mustRun(repoDir, 30_000, env, ["git", "rev-parse", "HEAD"])).stdout.trim();
    if (head !== COMMIT) throw new Error(`fixture commit mismatch: got ${head} want ${COMMIT}`);
    projectDir = join(repoDir, ...PROJECT_SUBDIR.split("/"));
    if (!existsSync(join(projectDir, "ConferencePlanner.sln"))) {
      throw new Error("fixture solution missing");
    }
    await initKnownsProject(sb, projectDir, "lsp-fixture-dotnet-webapi");
    await mustRun(projectDir, 240_000, env, [
      "dotnet",
      "restore",
      "ConferencePlanner.sln",
      "--nologo",
    ]);
  }, 15 * 60_000);

  afterAll(async () => {
    // Give the short-lived LSP daemon time to expire its lease and close log and process handles
    // before the sandbox (and its home) is removed (Go: a 5s cleanup sleep).
    await sleep(5000);
  });

  test(
    "cli runtime status",
    async () => {
      const statuses = await runKnownsJSON<LanguageStatus[]>(
        sb,
        projectDir,
        90_000,
        "lsp",
        "list",
        "--json",
      );
      const csharp = requireLanguage(statuses, "csharp");
      expect(csharp.status).not.toBe("");
      expect(csharp.installState).not.toBe("");
      expect(csharp.backend).not.toBe("");
      expect(csharp.logPath).not.toBe("");
      csharpLogPath = csharp.logPath;
    },
    5 * 60_000,
  );

  test(
    "mcp code tools",
    async () => {
      const client = await FixtureMcp.start(sb, projectDir);
      try {
        await client.callToolUntilRawContains(
          SYMBOL_WAIT_MS,
          PROBE_SYMBOL,
          "code",
          { action: "symbols", path: PROBE_FILE, depth: 2 },
          [() => readFailureFile("csharp-ls log", csharpLogPath, 4000)],
        );

        const definition = await client.callTool("code", {
          action: "definition",
          path: PROBE_FILE,
          query: PROBE_SYMBOL,
        });
        expect(String(definition.object?.file ?? "").replaceAll("\\", "/")).toEndWith(PROBE_FILE);

        const references = await client.callTool("code", {
          action: "references",
          path: PROBE_FILE,
          query: PROBE_SYMBOL,
        });
        expect(references.array?.length ?? 0).toBeGreaterThan(0);

        const diagnostics = await client.callTool("code", {
          action: "diagnostics",
          path: PROBE_FILE,
        });
        expect(Array.isArray(diagnostics.array)).toBe(true);

        const replacement = await client.callTool("code", {
          action: "replace_body",
          path: EDIT_FILE,
          symbol: EDIT_SYMBOL,
          body: [
            "        public static void MapSearchEndpoints(this IEndpointRouteBuilder routes)",
            "        {",
            '            routes.MapGet("/api/Search/ping", () => Results.Ok("pong"));',
            "        }",
          ].join("\n"),
        });
        expect(replacement.object?.success, `replace_body failed: ${replacement.raw}`).toBe(true);
        expect(Number(replacement.object?.lines_replaced ?? 0)).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
      const env = { ...(process.env as Record<string, string>), ...sb.env };
      await mustRun(projectDir, 180_000, env, [
        "dotnet",
        "build",
        "ConferencePlanner.sln",
        "--no-restore",
        "--nologo",
      ]);
    },
    15 * 60_000,
  );

  test(
    "http lsp language api",
    async () => {
      const port = await freePort();
      const browser: BrowserServer = startBrowser(sb, projectDir, port);
      try {
        const payload = await waitForJSON<{ languages: LanguageStatus[] }>(
          `http://127.0.0.1:${port}/api/lsp/languages`,
          90_000,
        );
        const csharp = requireLanguage(payload.languages, "csharp");
        expect(
          csharp.backend,
          `API csharp backend; stderr=${browser.stderr().slice(0, 800)}`,
        ).not.toBe("");
        expect(csharp.logPath).not.toBe("");
      } finally {
        await browser.stop();
      }
    },
    5 * 60_000,
  );
});
