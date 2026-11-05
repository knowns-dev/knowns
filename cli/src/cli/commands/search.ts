// `knowns search` (internal/cli/search.go): keyword and semantic search over tasks, docs, memories
// and decisions, plus the `--status-check`, `--setup` and `--reindex` maintenance modes.
//
// `--reindex`, `search index` and `search index --wait` live in search-index.ts (runtime queue).
import { arbitraryArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import {
  renderCmd,
  renderField,
  renderHint,
  renderSeparator,
  renderWarning,
  StyleBold,
  StyleDim,
} from "../core/plainoutput.ts";
import {
  formatSearchSemanticIndexReadinessLines,
  groupResults,
  maxScoreOf,
  renderNextSteps,
  renderPrettyResults,
  searchDim,
  searchSuccess,
  searchWarn,
  sprintPlainResults,
} from "./search-support.ts";

type Ctx = CommandContext;

async function openStorage(ctx: Ctx) {
  const { createStorage } = await import("../../storage/adapters.ts");
  return createStorage(await ctx.getStore());
}

async function runStatusCheck(ctx: Ctx): Promise<void> {
  const storage = await openStorage(ctx);
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const { resolveSemanticIndexReadiness } = await import("../../search/readiness.ts");
  const { normalizedSemanticProvider } = await import("./config.ts");

  let ss: ReturnType<typeof storage.config.load>["settings"]["semanticSearch"];
  try {
    ss = storage.config.load().settings.semanticSearch;
  } catch {
    ss = undefined;
  }
  const provider = ss ? normalizedSemanticProvider(ss.provider ?? "") : "ollama";

  let out = "\n";
  out += `${StyleBold.render("Semantic Search Status")}\n`;
  out += `${renderSeparator(40)}\n`;
  out += `${renderField("Provider", provider)}\n`;
  if (ss) {
    out += `${renderField("Model", ss.model ?? "")}\n`;
    out += `${renderField("Enabled", String(ss.enabled === true))}\n`;
    out += `${renderField("Dimensions", String(ss.dimensions ?? 0))}\n`;
    out += `${renderField("Max Tokens", String(ss.maxTokens ?? 0))}\n`;
  } else {
    out += `${renderField("Model", StyleDim.render("not configured"))}\n`;
    out += `${searchDim("    Set up: knowns search --setup")}\n`;
  }

  const readiness = resolveSemanticIndexReadiness(
    storage,
    buildSearchEnvironment({ env: ctx.env }),
  );
  for (const line of formatSearchSemanticIndexReadinessLines(readiness)) out += `${line}\n`;

  out += "\n";
  if (ss?.enabled && readiness.ready) {
    out += `${searchSuccess("  Status: ready (hybrid search active)")}\n`;
  } else if (ss?.enabled && !readiness.optedOut) {
    out += `${searchWarn("  Status: needs search reindex (run: knowns search --reindex)")}\n`;
  } else {
    out += `${searchDim("  Status: keyword-only mode")}\n`;
  }
  out += "\n";
  ctx.print(out);
}

async function runSetup(ctx: Ctx): Promise<void> {
  const { openConfig } = await import("./config.ts");
  const config = await openConfig(await ctx.getStore());
  const project = config.load();

  const ss = project.settings.semanticSearch;
  if (!ss || (ss.model ?? "") === "") {
    ctx.print(`${searchWarn("No embedding model configured.")}\n`);
    ctx.print("\n");
    ctx.print(`${renderHint(`Choose an embedding model with: ${renderCmd("knowns settings")}`)}\n`);
    ctx.print("\n");
    return;
  }

  if (!ss.enabled) {
    try {
      config.set("settings.semanticSearch.enabled", true);
    } catch {
      // Go ignores a failed write here
    }
    ctx.print(`${searchSuccess("Semantic search enabled.")}\n`);
  } else {
    ctx.print(`${StyleDim.render("Semantic search is already enabled.")}\n`);
  }

  ctx.print("\n");
  // fmt.Println of a string that already ends in a newline: one blank line follows.
  ctx.print(
    `${renderNextSteps(renderCmd("knowns search --reindex"), renderCmd('knowns search "your query"'))}\n`,
  );
}

async function runReindex(ctx: Ctx): Promise<void> {
  const storage = await openStorage(ctx);
  const { runReindex: reindex } = await import("./search-index.ts");
  await reindex(ctx, storage, ctx.env);
}

export default defineCommand({
  use: "search <query>",
  short: "Search tasks and documentation",
  example: `  # Search tasks and docs together
  knowns search "auth"

  # Only docs
  knowns search "security patterns" --type doc

  # Learn from tasks that already solved something like this
  knowns search "auth" --type task --status done`,
  args: arbitraryArgs,
  flags: [
    {
      type: "string",
      name: "type",
      usage: "Search type: all|task|doc|memory|decision (default: all)",
      default: "",
    },
    {
      type: "string",
      name: "status",
      usage: "Filter by task, memory, or decision status",
      default: "",
    },
    { type: "string", name: "priority", usage: "Filter tasks by priority", default: "" },
    { type: "string", name: "label", usage: "Filter tasks by label", default: "" },
    {
      type: "string",
      name: "tag",
      usage: "Filter docs, memories, or decisions by tag",
      default: "",
    },
    { type: "string", name: "assignee", usage: "Filter tasks by assignee", default: "" },
    { type: "bool", name: "keyword", usage: "Force keyword-only search", default: false },
    {
      type: "bool",
      name: "include-historical",
      usage: "Include historical entities, including archived Tasks",
      default: false,
    },
    { type: "int", name: "limit", usage: "Limit search results", default: 20 },
    { type: "bool", name: "reindex", usage: "Rebuild the search index", default: false },
    { type: "bool", name: "setup", usage: "Set up semantic search", default: false },
    {
      type: "bool",
      name: "status-check",
      usage: "Show semantic search status",
      default: false,
    },
  ],
  subcommands: [
    defineCommand({
      use: "index",
      short: "Build the configured semantic index",
      flags: [
        {
          type: "bool",
          name: "wait",
          usage: "Block until managed setup and indexing succeed or fail",
          default: false,
        },
      ],
      async run(ctx) {
        const storage = await openStorage(ctx);
        const { runSearchIndex } = await import("./search-index.ts");
        await runSearchIndex(ctx, storage, ctx.flags.bool("wait"), ctx.env);
      },
    }),
  ],
  async run(ctx) {
    if (ctx.flags.bool("status-check")) return runStatusCheck(ctx);
    if (ctx.flags.bool("setup")) return runSetup(ctx);
    if (ctx.flags.bool("reindex")) return runReindex(ctx);

    if (ctx.args.length === 0) throw new Error("search query required (use --help for usage)");

    const query = ctx.args.join(" ");
    const storage = await openStorage(ctx);

    let limit = ctx.flags.int("limit");
    if (limit <= 0) limit = 20;
    const mode = ctx.flags.bool("keyword") ? "keyword" : "hybrid";

    const { searchWithRuntime } = await import("../../search/runtime.ts");
    const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
    const response = await searchWithRuntime(storage, buildSearchEnvironment({ env: ctx.env }), {
      query,
      type: ctx.flags.string("type"),
      mode,
      status: ctx.flags.string("status"),
      priority: ctx.flags.string("priority"),
      assignee: ctx.flags.string("assignee"),
      label: ctx.flags.string("label"),
      tag: ctx.flags.string("tag"),
      limit,
      includeHistorical: ctx.flags.bool("include-historical"),
    });
    const results = response.results;

    if (ctx.json) {
      ctx.printJSON(results);
      return;
    }
    const degraded = response.runtime?.degraded === true;
    if (degraded) ctx.print(`${searchWarn(response.runtime?.message ?? "")}\n`);

    if (results.length === 0) {
      if (ctx.plain) ctx.print("No results found.\n");
      else ctx.print(`${renderWarning(`No results for ${goQuote(query)}`)}\n`);
      return;
    }

    const actualMode = degraded ? "keyword" : mode;
    const maxScore = maxScoreOf(results);
    const grouped = groupResults(results);
    if (ctx.plain) ctx.printPaged(sprintPlainResults(grouped, maxScore));
    else ctx.print(renderPrettyResults(query, actualMode, grouped, maxScore));
  },
});
