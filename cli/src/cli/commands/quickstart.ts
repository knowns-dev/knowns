// `knowns quickstart` (internal/cli/quickstart.go): the day-one spine of the CLI.
import { noArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { StyleBold, StyleInfo } from "../core/plainoutput.ts";

/** One runnable line of the guide. Desc is optional on purpose (see the Go source). */
export interface QuickstartEntry {
  cmd: string;
  desc?: string;
  note?: string;
}

/** A group titles the job the reader is trying to do, not the noun the commands operate on. */
export interface QuickstartGroup {
  title: string;
  entries: QuickstartEntry[];
}

export const quickstartGroups: QuickstartGroup[] = [
  {
    title: "GETTING STARTED",
    entries: [
      {
        cmd: "knowns init",
        desc: "Initialize Knowns in your project",
        note: "Creates .knowns/ to hold tasks, docs, and memory",
      },
    ],
  },
  {
    title: "FINDING WHAT IS ALREADY KNOWN",
    entries: [
      { cmd: `knowns search "auth"`, desc: "Search tasks and docs together" },
      { cmd: "knowns doc list", desc: "List all documentation" },
      { cmd: `knowns doc "ARCHITECTURE"`, desc: "Read one doc" },
    ],
  },
  {
    title: "CREATING TASKS",
    entries: [
      { cmd: `knowns task create "Add JWT auth"` },
      { cmd: `knowns task create "Add JWT auth" --priority high -l auth` },
      { cmd: `knowns task create "Add JWT auth" --ac "User receives a token"` },
    ],
  },
  {
    title: "VIEWING TASKS",
    entries: [
      { cmd: "knowns task list", desc: "List every task" },
      { cmd: "knowns task list --status in-progress", desc: "List only what is being worked on" },
      { cmd: "knowns task <id>", desc: "Show one task in full" },
    ],
  },
  {
    title: "DOING THE WORK",
    entries: [
      { cmd: "knowns task edit <id> -s in-progress", desc: "Take the task" },
      { cmd: `knowns task edit <id> --plan "1. ..."`, desc: "Record the plan before coding" },
      { cmd: "knowns task edit <id> --check-ac 1", desc: "Tick a criterion once it is done" },
      { cmd: "knowns task edit <id> -s done", desc: "Finish" },
    ],
  },
  {
    title: "CAPTURING WHAT YOU LEARNED",
    entries: [
      {
        cmd: `knowns memory create "Title" -c "..."`,
        desc: "A durable insight, carried into later sessions",
      },
      {
        cmd: `knowns doc create "Pattern: X" -f patterns`,
        desc: "A doc, when the knowledge needs room",
      },
      { cmd: `knowns decision create "..."`, desc: "Guidance the whole project should follow" },
    ],
  },
  {
    title: "FOR AI AGENTS",
    entries: [
      { cmd: "--plain", desc: "Parseable output; valid on every command" },
      { cmd: "--json", desc: "Structured output; valid on every command" },
    ],
  },
];

/** Keeps the description column from being shoved to the right margin by one long example. */
const QUICKSTART_ALIGN_CAP = 42;

/** Go's len(): bytes. Every entry is ASCII today; count UTF-8 bytes so a future edit stays faithful. */
const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** The width the described commands in a group align to: the widest one under the cap. */
export function quickstartColumn(entries: QuickstartEntry[]): number {
  let width = 0;
  for (const e of entries) {
    if ((e.desc ?? "") === "" && (e.note ?? "") === "") continue;
    const n = byteLen(e.cmd);
    if (n > width && n <= QUICKSTART_ALIGN_CAP) width = n;
  }
  return width;
}

export function renderQuickstart(groups: QuickstartGroup[]): string {
  let out = `${StyleBold.render("knowns")} - the memory layer for AI-native software development\n`;
  for (const g of groups) {
    out += "\n";
    out += `${StyleBold.render(g.title)}\n`;
    const width = quickstartColumn(g.entries);
    for (const e of g.entries) {
      const desc = e.desc ?? "";
      if (desc === "" || byteLen(e.cmd) > width) {
        out += `  ${StyleInfo.render(e.cmd)}\n`;
        if (desc !== "") out += `  ${" ".repeat(width + 2)}${desc}\n`;
      } else {
        out += `  ${StyleInfo.render(e.cmd)}${" ".repeat(width - byteLen(e.cmd) + 2)}${desc}\n`;
      }
      if (e.note) out += `  ${" ".repeat(width + 2)}${e.note}\n`;
    }
  }
  out += "\n";
  out += `${StyleBold.render("Ready to start!")}\n`;
  out += `Run ${StyleInfo.render(`knowns task create "My first task"`)} to create your first task.\n`;
  return out;
}

export default defineCommand({
  use: "quickstart",
  short: "Show the short path from an empty project to a finished task",
  args: noArgs,
  run(ctx) {
    ctx.print(renderQuickstart(quickstartGroups));
  },
});
