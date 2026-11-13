/**
 * Renders one markdown page per visible command (tools/gendocs/render.go, ported). The output is
 * byte-identical to the Go generator for the same command tree, including its quirks: the example
 * block is trimmed as a whole (so only its first line loses the indent), and the version is left
 * out because it changes every release and would turn the drift gate into noise.
 */
import { goTrimSpace } from "../../storage/core/util.ts";
import type { Command } from "../core/command.ts";
import type { FlagSet } from "../core/flags.ts";

/**
 * Root commands cobra adds only when the CLI executes, so the Go command tree a generator walks
 * never had them. The TS root registers `completion` eagerly; it stays out of the reference.
 */
const EXECUTE_TIME_ROOT_COMMANDS = new Set(["completion"]);

/** `knowns task create` lives in knowns_task_create.md, matching the command path. */
export function pageName(c: Command): string {
  return `${c.commandPath().replaceAll(" ", "_")}.md`;
}

function listed(c: Command): boolean {
  if (c.name() === "help") return false;
  if (c.parent() && !c.parent()?.parent() && EXECUTE_TIME_ROOT_COMMANDS.has(c.name())) {
    return false;
  }
  return c.isAvailableCommand();
}

/** Every visible command, as filename -> contents. */
export function renderTree(root: Command): Map<string, string> {
  const pages = new Map<string, string>();
  const walk = (c: Command): void => {
    if (c !== root && !listed(c)) return;
    pages.set(pageName(c), renderPage(c));
    for (const sub of c.commands()) walk(sub);
  };
  walk(root);
  return pages;
}

export function renderPage(c: Command): string {
  let b = `# ${c.commandPath()}\n\n`;
  const short = goTrimSpace(c.short);
  if (short !== "") b += `${short}\n\n`;
  const long = goTrimSpace(c.long);
  if (long !== "" && long !== short) b += `${long}\n\n`;

  if (c.runnable()) b += `## Usage\n\n\`\`\`\n${c.useLine()}\n\`\`\`\n\n`;
  const example = goTrimSpace(c.example);
  if (example !== "") b += `## Examples\n\n\`\`\`bash\n${example}\n\`\`\`\n\n`;

  b += flagTable("Flags", c.localFlags());
  b += flagTable("Inherited flags", c.inheritedFlags());

  const subs = c
    .commands()
    .filter(listed)
    .sort((x, y) => (x.name() < y.name() ? -1 : x.name() > y.name() ? 1 : 0));
  if (subs.length > 0) {
    b += "## Subcommands\n\n";
    for (const sub of subs) {
      b += `- [\`${sub.commandPath()}\`](${pageName(sub)}) — ${goTrimSpace(sub.short)}\n`;
    }
    b += "\n";
  }

  const p = c.parent();
  if (p) {
    b += `## See also\n\n- [\`${p.commandPath()}\`](${pageName(p)}) — ${goTrimSpace(p.short)}\n\n`;
  }

  b += "---\n\nGenerated from the command tree by `make cli-docs`. Do not edit by hand.\n";
  return b;
}

function flagTable(heading: string, fs: FlagSet): string {
  if (!fs.hasAvailableFlags()) return "";
  let b = `## ${heading}\n\n| Flag | Type | Default | Description |\n|---|---|---|---|\n`;
  fs.visitAll((f) => {
    if (f.hidden) return;
    const name = f.shorthand !== "" ? `\`-${f.shorthand}, --${f.name}\`` : `\`--${f.name}\``;
    const def =
      f.defValue !== "" && f.defValue !== "false" && f.defValue !== "[]"
        ? `\`${f.defValue}\``
        : "—";
    // A literal | in a description would end the table cell.
    const usage = goTrimSpace(f.usage).replaceAll("|", "\\|");
    b += `| ${name} | \`${f.value.type}\` | ${def} | ${usage} |\n`;
  });
  return `${b}\n`;
}
