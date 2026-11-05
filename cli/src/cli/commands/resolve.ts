// `knowns resolve <semantic-ref>` (internal/cli/resolve.go).
import { isStructural } from "../../models/index.ts";
import { exactArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { getStoreErr, splitCSV } from "../core/helpers.ts";
import {
  plainResolution,
  plainStructuralResult,
  prettyResolution,
  prettyStructuralResult,
} from "./resolve-support.ts";

export default defineCommand({
  use: "resolve <semantic-ref>",
  short: "Resolve a semantic reference",
  args: exactArgs(1),
  flags: [
    {
      type: "string",
      name: "direction",
      usage: "Traversal direction: outbound (default), inbound, or both",
      default: "",
    },
    { type: "int", name: "depth", usage: "Max traversal hops (1-3, default 1)", default: 0 },
    {
      type: "string",
      name: "relation",
      usage: "Filter by relation kinds (comma-separated)",
      default: "",
    },
    {
      type: "string",
      name: "type",
      usage: "Filter result entities by kind (comma-separated)",
      default: "",
    },
  ],
  async run(ctx) {
    const { createStorage } = await import("../../storage/adapters.ts");
    const { resolveRaw, resolveStructural } = await import("./resolve-support.ts");
    const storage = createStorage(await getStoreErr(ctx.cmd));

    const relation = ctx.flags.string("relation");
    const entityType = ctx.flags.string("type");
    const params = {
      direction: ctx.flags.string("direction"),
      depth: ctx.flags.int("depth"),
      ...(relation !== "" && { relationTypes: splitCSVFlag(relation) }),
      ...(entityType !== "" && { entityTypes: splitCSVFlag(entityType) }),
    };
    const ref = ctx.args[0] as string;
    // Go writes straight to the command's stdout: no pager, no --page footer.
    if (isStructural(params)) {
      const result = await resolveStructural(storage, ref, params);
      if (ctx.json) ctx.printJSON(result);
      else ctx.print(ctx.plain ? plainStructuralResult(result) : prettyStructuralResult(result));
      return;
    }
    const resolution = await resolveRaw(storage, ref);
    if (ctx.json) ctx.printJSON(resolution);
    else ctx.print(ctx.plain ? plainResolution(resolution) : prettyResolution(resolution));
  },
});

/** splitCSVFlag: trimmed non-empty parts (same as the shared splitCSV except for the empty string). */
function splitCSVFlag(s: string): string[] {
  return splitCSV(s);
}
