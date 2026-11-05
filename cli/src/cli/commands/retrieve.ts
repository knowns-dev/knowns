// `knowns retrieve` (internal/cli/search.go runRetrieve): ranked context for docs, tasks,
// memories and decisions, with citations.
import { arbitraryArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import { splitCSV } from "../core/helpers.ts";
import { renderWarning } from "../core/plainoutput.ts";
import { renderPrettyRetrieval, searchWarn, sprintPlainRetrieval } from "./search-support.ts";

export default defineCommand({
  use: "retrieve <query>",
  short: "Retrieve ranked context for docs, tasks, and memories",
  args: arbitraryArgs,
  flags: [
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
    { type: "bool", name: "keyword", usage: "Force keyword-only retrieval", default: false },
    {
      type: "bool",
      name: "expand-references",
      usage: "Expand @doc/@task/@memory/@decision references into the result",
      default: false,
    },
    {
      type: "bool",
      name: "include-historical",
      usage: "Include historical entities; Task retrieval adds done and archived Tasks",
      default: false,
    },
    {
      type: "string",
      name: "source-types",
      usage: "Comma-separated source types: doc,task,memory,decision",
      default: "",
    },
    { type: "int", name: "limit", usage: "Limit ranked candidates", default: 20 },
  ],
  async run(ctx) {
    if (ctx.args.length === 0) throw new Error("retrieve query required (use --help for usage)");
    const query = ctx.args.join(" ");

    const { createStorage } = await import("../../storage/adapters.ts");
    const storage = createStorage(await ctx.getStore());

    let limit = ctx.flags.int("limit");
    if (limit <= 0) limit = 20;
    const mode = ctx.flags.bool("keyword") ? "keyword" : "hybrid";
    const sourceTypes = splitCSV(ctx.flags.string("source-types"));

    const { retrieveWithRuntime } = await import("../../search/runtime.ts");
    const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
    const { response, runtime } = await retrieveWithRuntime(
      storage,
      buildSearchEnvironment({ env: ctx.env }),
      {
        query,
        mode,
        limit,
        // Go's splitCSV returns a nil slice for an empty flag; keep it absent rather than [].
        ...(sourceTypes.length > 0 && { sourceTypes }),
        expandReferences: ctx.flags.bool("expand-references"),
        status: ctx.flags.string("status"),
        priority: ctx.flags.string("priority"),
        assignee: ctx.flags.string("assignee"),
        label: ctx.flags.string("label"),
        tag: ctx.flags.string("tag"),
        includeHistorical: ctx.flags.bool("include-historical"),
      },
    );

    if (ctx.json) {
      ctx.printJSON(runtime ? { ...response, _runtime: runtime } : response);
      return;
    }
    if (runtime?.degraded) ctx.print(`${searchWarn(runtime.message ?? "")}\n`);

    if ((response.candidates ?? []).length === 0) {
      if (ctx.plain) ctx.print("No retrieval results found.\n");
      else ctx.print(`${renderWarning(`No retrieval results for ${goQuote(query)}`)}\n`);
      return;
    }

    if (ctx.plain) ctx.printPaged(sprintPlainRetrieval(response));
    else ctx.print(renderPrettyRetrieval(response));
  },
});
