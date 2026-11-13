// `knowns template ...` (internal/cli/template.go): list, view, run, create.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Template, TemplateResult } from "../../models/template.ts";
import { arbitraryArgs, exactArgs } from "../core/args.ts";
import type { Command } from "../core/command.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import {
  renderKeyValue,
  renderSectionHeader,
  renderSeparator,
  renderSuccess,
  StyleBold,
  StyleDim,
  StyleInfo,
  StyleSuccess,
  StyleTitle,
  StyleWarning,
} from "../core/plainoutput.ts";
import { renderBlock } from "./doc-support.ts";

async function openStorage(ctx: CommandContext) {
  const { createStorage } = await import("../../storage/adapters.ts");
  return createStorage(await ctx.getStore());
}

/** fmt's %-Ns: left-justify to N characters (runes), never truncating. */
function padRunes(s: string, n: number): string {
  const len = [...s].length;
  return len >= n ? s : s + " ".repeat(n - len);
}

/** Go slices strings by byte; reproduce that for the truncated list columns. */
function byteSlice(s: string, n: number): string {
  return Buffer.from(s, "utf8").subarray(0, n).toString("utf8");
}

function displayName(t: Template): string {
  return t.imported && (t.importName ?? "") !== "" ? `${t.importName}/${t.name}` : t.name;
}

// --- template list -------------------------------------------------------------------------------

const templateListCmd = defineCommand({
  use: "list",
  short: "List available templates",
  flags: [
    { type: "bool", name: "local", usage: "Show only local templates", default: false },
    { type: "bool", name: "imported", usage: "Show only imported templates", default: false },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const localOnly = ctx.flags.bool("local");
    const importedOnly = ctx.flags.bool("imported");

    let templates: Template[];
    try {
      templates = storage.templates.list();
    } catch (e) {
      throw new Error(`list templates: ${(e as Error).message}`);
    }
    if (localOnly || importedOnly) {
      templates = templates.filter((t) => {
        if (localOnly && t.imported) return false;
        if (importedOnly && !t.imported) return false;
        return true;
      });
    }

    if (ctx.json) {
      ctx.printJSON(templates.length === 0 && !localOnly && !importedOnly ? null : templates);
      return;
    }
    if (templates.length === 0) {
      ctx.print(`${StyleDim.render("No templates found.")}\n`);
      return;
    }

    let out = "";
    if (ctx.plain) {
      for (const t of templates) {
        out += `TEMPLATE: ${displayName(t)}\n`;
        if ((t.description ?? "") !== "") out += `  DESCRIPTION: ${t.description}\n`;
        if (t.imported) out += `  IMPORTED FROM: ${t.importName ?? ""}\n`;
        if ((t.doc ?? "") !== "") out += `  DOC: ${t.doc}\n`;
        if ((t.prompts ?? []).length > 0) {
          out += `  VARIABLES: ${(t.prompts ?? []).map((p) => p.name).join(", ")}\n`;
        }
        out += "\n";
      }
    } else {
      out += `${StyleBold.render(padRunes("NAME", 30))}  ${StyleBold.render(padRunes("DESCRIPTION", 40))}  ${StyleBold.render("TYPE")}\n`;
      out += `${renderSeparator(80)}\n`;
      for (const t of templates) {
        let name = displayName(t);
        if (Buffer.byteLength(name, "utf8") > 28) name = `${byteSlice(name, 25)}...`;
        let desc = t.description ?? "";
        if (Buffer.byteLength(desc, "utf8") > 38) desc = `${byteSlice(desc, 35)}...`;
        const type = t.imported ? StyleInfo.render("imported") : StyleDim.render("local");
        out += `${padRunes(name, 30)}  ${padRunes(desc, 40)}  ${type}\n`;
      }
    }
    ctx.print(out);
  },
});

// --- template view -------------------------------------------------------------------------------

function templatePlain(t: Template): string {
  let out = `NAME: ${t.name}\n`;
  if ((t.description ?? "") !== "") out += `DESCRIPTION: ${t.description}\n`;
  if ((t.version ?? "") !== "") out += `VERSION: ${t.version}\n`;
  if ((t.author ?? "") !== "") out += `AUTHOR: ${t.author}\n`;
  if (t.imported) out += `IMPORTED FROM: ${t.importName ?? ""}\n`;
  if ((t.doc ?? "") !== "") out += `DOC: ${t.doc}\n`;
  if ((t.destination ?? "") !== "") out += `DESTINATION: ${t.destination}\n`;
  if ((t.path ?? "") !== "") out += `PATH: ${t.path}\n`;
  if ((t.prompts ?? []).length > 0) {
    out += "PROMPTS:\n";
    for (const p of t.prompts ?? []) {
      out += `  - ${p.name} (${p.type})`;
      if (p.message !== "") out += `: ${p.message}`;
      if (p.validate === "required") out += " [required]";
      if ((p.initial ?? "") !== "") out += ` (default: ${p.initial})`;
      out += "\n";
    }
  }
  if ((t.actions ?? []).length > 0) {
    out += "ACTIONS:\n";
    (t.actions ?? []).forEach((a, i) => {
      out += `  ${i + 1}. ${a.type}`;
      if ((a.path ?? "") !== "") out += ` → ${a.path}`;
      if ((a.template ?? "") !== "") out += ` (template: ${a.template})`;
      out += "\n";
    });
  }
  return out;
}

function templateDetailed(t: Template): string {
  let out = `${StyleTitle.render(t.name)}\n`;
  if ((t.description ?? "") !== "") out += `${renderBlock(StyleDim, t.description ?? "")}\n`;
  if ((t.version ?? "") !== "") out += `${renderKeyValue("Version", t.version ?? "")}\n`;
  if ((t.author ?? "") !== "") out += `${renderKeyValue("Author", t.author ?? "")}\n`;
  if (t.imported) out += `${renderKeyValue("Imported from", t.importName ?? "")}\n`;
  if ((t.doc ?? "") !== "") out += `${renderKeyValue("Doc", t.doc ?? "")}\n`;
  if ((t.destination ?? "") !== "")
    out += `${renderKeyValue("Destination", t.destination ?? "")}\n`;
  if ((t.path ?? "") !== "") out += `${renderKeyValue("Path", t.path ?? "")}\n`;
  if ((t.prompts ?? []).length > 0) {
    out += `\n${renderSectionHeader("Prompts")}\n`;
    for (const p of t.prompts ?? []) {
      out += `  ${StyleDim.render("-")} ${StyleBold.render(p.name)} ${StyleDim.render(`(${p.type})`)}`;
      if (p.message !== "") out += `: ${p.message}`;
      if (p.validate === "required") out += ` ${StyleWarning.render("[required]")}`;
      if ((p.initial ?? "") !== "") out += ` ${StyleDim.render(`(default: ${p.initial})`)}`;
      out += "\n";
    }
  }
  if ((t.actions ?? []).length > 0) {
    out += `\n${renderSectionHeader(`Actions (${(t.actions ?? []).length})`)}\n`;
    (t.actions ?? []).forEach((a, i) => {
      out += `  ${StyleDim.render(`${i + 1}.`)} ${StyleInfo.render(`[${a.type}]`)}`;
      if ((a.path ?? "") !== "") out += ` ${a.path}`;
      if ((a.template ?? "") !== "") out += ` ${StyleDim.render(`(template: ${a.template})`)}`;
      if (a.skipIfExists) out += ` ${StyleWarning.render("[skip-if-exists]")}`;
      out += "\n";
    });
  }
  if (t.messages && (t.messages.success ?? "") !== "") {
    out += `\n${StyleDim.render("Success message:")} ${t.messages.success}\n`;
  }
  return out;
}

async function runTemplateView(ctx: CommandContext, name: string): Promise<void> {
  const storage = await openStorage(ctx);
  let tmpl: Template;
  try {
    tmpl = storage.templates.get(name);
  } catch {
    throw new Error(`template ${goQuote(name)} not found`);
  }
  if (ctx.json) ctx.printJSON(tmpl);
  else if (ctx.plain) ctx.print(templatePlain(tmpl));
  else ctx.print(templateDetailed(tmpl));
}

const templateViewCmd = defineCommand({
  use: "view <name>",
  short: "View template details",
  args: exactArgs(1),
  run: (ctx) => runTemplateView(ctx, ctx.args[0] ?? ""),
});

// --- template run --------------------------------------------------------------------------------

const templateRunCmd = defineCommand({
  use: "run <name>",
  short: "Run a code generation template",
  args: exactArgs(1),
  flags: [
    { type: "bool", name: "dry-run", usage: "Preview without writing files", default: false },
    {
      type: "stringArray",
      name: "var",
      shorthand: "v",
      usage: "Template variable (key=value, repeatable)",
    },
  ],
  async run(ctx) {
    const name = ctx.args[0] ?? "";
    const storage = await openStorage(ctx);

    let tmpl: Template;
    try {
      tmpl = storage.templates.get(name);
    } catch {
      throw new Error(`template ${goQuote(name)} not found`);
    }

    const dryRun = ctx.flags.bool("dry-run");
    const vars: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const v of ctx.flags.strings("var")) {
      const idx = v.indexOf("=");
      if (idx === -1) {
        throw new Error(`invalid variable format ${goQuote(v)}: expected key=value`);
      }
      vars[v.slice(0, idx)] = v.slice(idx + 1);
    }

    for (const p of tmpl.prompts ?? []) {
      if (p.validate === "required" && !(p.name in vars)) {
        if ((p.initial ?? "") !== "") vars[p.name] = p.initial ?? "";
        else {
          throw new Error(
            `required variable ${goQuote(p.name)} not provided (use -v ${p.name}=<value>)`,
          );
        }
      }
      if (!(p.name in vars) && (p.initial ?? "") !== "") vars[p.name] = p.initial ?? "";
    }

    const { Engine } = await import("../../domain/codegen/index.ts");
    const engine = new Engine(storage.store.projectRoot);

    let result: TemplateResult;
    try {
      result = engine.run(tmpl, vars, dryRun);
    } catch (e) {
      throw new Error(`run template: ${(e as Error).message}`);
    }

    if (ctx.json) {
      ctx.printJSON(result);
      return;
    }

    let out = "";
    if (dryRun)
      out += `${StyleWarning.render("Dry run")}${StyleDim.render(" — no files were written.")}\n\n`;
    if ((result.created ?? []).length > 0) {
      out += `${StyleSuccess.render("Created:")}\n`;
      for (const f of result.created ?? []) out += `  ${StyleSuccess.render("+")} ${f}\n`;
    }
    if ((result.modified ?? []).length > 0) {
      out += `${StyleWarning.render("Modified:")}\n`;
      for (const f of result.modified ?? []) out += `  ${StyleWarning.render("~")} ${f}\n`;
    }
    if ((result.skipped ?? []).length > 0) {
      out += `${StyleDim.render("Skipped:")}\n`;
      for (const f of result.skipped ?? []) out += `  ${StyleDim.render("-")} ${f}\n`;
    }
    const success = tmpl.messages?.success ?? "";
    if (!dryRun && success !== "") {
      out += "\n";
      let rendered: string;
      try {
        rendered = engine.renderString(success, vars);
      } catch {
        rendered = success; // fall back to the raw message if rendering fails
      }
      out += `${renderBlock(StyleSuccess, rendered)}\n`;
    }
    ctx.print(out);
  },
});

// --- template create -----------------------------------------------------------------------------

const templateCreateCmd = defineCommand({
  use: "create <name>",
  short: "Create a new template scaffold",
  args: exactArgs(1),
  flags: [
    {
      type: "string",
      name: "description",
      shorthand: "d",
      usage: "Template description",
      default: "",
    },
    {
      type: "string",
      name: "doc",
      usage: "Link to documentation (e.g., 'patterns/controller')",
      default: "",
    },
  ],
  async run(ctx) {
    const name = ctx.args[0] ?? "";
    const storage = await openStorage(ctx);
    const description = ctx.flags.string("description");
    const doc = ctx.flags.string("doc");

    try {
      storage.templates.create(name, description);
    } catch (e) {
      throw new Error(`create template: ${(e as Error).message}`);
    }

    if (doc !== "") {
      const configPath = join(storage.store.root, "templates", name, "_template.yaml");
      try {
        const content = readFileSync(configPath, "utf8");
        // strings.Replace(content, `doc: ""`, fmt.Sprintf("doc: %q", doc), 1)
        const updated = content.replace('doc: ""', () => `doc: ${goQuote(doc)}`);
        try {
          writeFileSync(configPath, updated, { mode: 0o644 });
        } catch {
          // best effort, like Go's ignored error
        }
      } catch {
        // unreadable: leave the scaffold as created
      }
    }

    let out = `${renderSuccess(`Created template: ${name}`)}\n`;
    if (doc !== "") out += `${renderKeyValue("Linked doc", doc)}\n`;
    out += `${StyleDim.render("Edit the template at:")} .knowns/templates/${name}/\n`;
    ctx.print(out);
  },
});

// --- template ------------------------------------------------------------------------------------

export default defineCommand({
  use: "template",
  short: "Manage code generation templates",
  long: "List, view, run, and create code generation templates.",
  args: arbitraryArgs,
  async run(ctx) {
    const first = ctx.args[0];
    if (first === undefined) {
      (ctx.cmd as Command).help();
      return;
    }
    await runTemplateView(ctx, first);
  },
  subcommands: [templateListCmd, templateViewCmd, templateRunCmd, templateCreateCmd],
});
