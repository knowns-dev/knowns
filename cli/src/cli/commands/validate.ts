// `knowns validate` (internal/cli/validate.go): runs the shared validation engine and renders it.
import { defineCommand } from "../core/define.ts";
import {
  renderSuccess,
  StyleBold,
  StyleDim,
  StyleError,
  StyleInfo,
  StyleWarning,
} from "../core/plainoutput.ts";

export default defineCommand({
  use: "validate",
  short: "Validate tasks, docs, and templates",
  flags: [
    {
      type: "string",
      name: "scope",
      usage: "Validation scope: all|tasks|docs|templates|sdd",
      default: "all",
    },
    { type: "bool", name: "strict", usage: "Treat warnings as errors", default: false },
    { type: "bool", name: "fix", usage: "Auto-fix supported issues", default: false },
    {
      type: "string",
      name: "entity",
      usage: "Validate a specific entity (task ID or doc path)",
      default: "",
    },
    {
      type: "bool",
      name: "include-global",
      usage: "Also validate the user-level global memory layer, shared by every project",
      default: false,
    },
  ],
  async run(ctx) {
    const { createStorage } = await import("../../storage/adapters.ts");
    const { run } = await import("../../domain/validate/index.ts");
    const storage = createStorage(await ctx.getStore());

    const result = run(storage, {
      scope: ctx.flags.string("scope"),
      entity: ctx.flags.string("entity"),
      strict: ctx.flags.bool("strict"),
      fix: ctx.flags.bool("fix"),
      includeGlobalMemory: ctx.flags.bool("include-global"),
    });

    if (ctx.json) {
      ctx.printJSON({
        issues: result.issues,
        errors: result.errorCount,
        warnings: result.warningCount,
        info: result.infoCount,
        valid: result.valid,
      });
      return;
    }

    if (ctx.plain) {
      let out = "";
      for (const iss of result.issues) {
        out += `${iss.level.toUpperCase()} [${iss.entity ?? ""}] ${iss.message}\n`;
      }
      out += `\nSUMMARY: ${result.errorCount} errors, ${result.warningCount} warnings, ${result.infoCount} info\n`;
      out += result.valid ? "VALID: true\n" : "VALID: false\n";
      ctx.print(out);
    } else if (result.issues.length === 0) {
      ctx.print(`${renderSuccess("Validation passed. No issues found.")}\n`);
    } else {
      let out = "";
      for (const iss of result.issues) {
        const prefix =
          iss.level === "error"
            ? StyleError.render("ERROR  ")
            : iss.level === "warning"
              ? StyleWarning.render("WARN   ")
              : StyleInfo.render("INFO   ");
        out += `${prefix} ${StyleDim.render(`[${iss.entity ?? ""}]`)} ${iss.message}\n`;
      }
      out += "\n";
      const parts: string[] = [];
      if (result.errorCount > 0) parts.push(StyleError.render(`${result.errorCount} error(s)`));
      if (result.warningCount > 0) {
        parts.push(StyleWarning.render(`${result.warningCount} warning(s)`));
      }
      if (result.infoCount > 0) parts.push(StyleInfo.render(`${result.infoCount} info`));
      out += `${StyleBold.render("Summary:")} ${parts.join(StyleDim.render(", "))}\n`;
      ctx.print(out);
    }

    if (result.errorCount > 0) {
      throw new Error(`validation failed with ${result.errorCount} error(s)`);
    }
  },
});
