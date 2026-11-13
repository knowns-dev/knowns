/**
 * Grouping of the root `--help` command list (helpgroups.go).
 *
 * Group membership is kept in this one table, not as a group id on each command, so the whole
 * taxonomy is reviewable in a single diff. A TS-only command that is not in the table declares
 * its group with `helpGroup` in its spec (an annotation on the command); a command that names no
 * known group lands under "Other", so nothing is ever silently dropped from `--help`.
 */
import { type Command, HELP_GROUP_ANNOTATION } from "./command.ts";

export interface HelpGroup {
  title: string;
  commands: string[];
}

/** Order here is the order printed: what you reach for daily down to what you touch once. */
export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "Tasks, docs, and memory",
    commands: [
      "task",
      "doc",
      "decision",
      "memory",
      "search",
      "retrieve",
      "resolve",
      "template",
      "time",
    ],
  },
  {
    title: "Project setup and health",
    commands: [
      "init",
      "quickstart",
      "status",
      "doctor",
      "config",
      "settings",
      "sync",
      "store",
      "setup",
      "agents",
      "validate",
    ],
  },
  { title: "Code intelligence", commands: ["code", "lsp"] },
  {
    title: "Advanced",
    commands: [
      "mcp",
      "runtime",
      "browser",
      "tunnel",
      "qdrant",
      "provider",
      "audit",
      "eval",
      "import",
      "migrate",
      "reconcile",
      "update",
    ],
  },
];

/** Collects any visible command the table forgot. */
export const UNGROUPED_TITLE = "Other";

/** `help` and `completion` are cobra's own and carry no project meaning. */
export function isListableCommand(c: Command): boolean {
  return c.isAvailableCommand() && c.name() !== "help" && c.name() !== "completion";
}

/** Buckets cmd's visible subcommands by HELP_GROUPS, preserving group order, dropping empty groups. */
export function groupRootCommands(cmd: Command): HelpGroup[] {
  const remaining = new Map<string, Command>();
  for (const c of cmd.commands()) if (isListableCommand(c)) remaining.set(c.name(), c);

  // Commands that name their own group are slotted in after the table's members of that group.
  const declared = new Map<string, string[]>();
  for (const c of remaining.values()) {
    const title = c.annotations[HELP_GROUP_ANNOTATION];
    if (title === undefined) continue;
    if (HELP_GROUPS.some((g) => g.title === title && g.commands.includes(c.name()))) continue;
    const list = declared.get(title) ?? [];
    list.push(c.name());
    declared.set(title, list);
  }

  const out: HelpGroup[] = [];
  for (const g of HELP_GROUPS) {
    const found: string[] = [];
    for (const name of g.commands) {
      if (!remaining.has(name)) continue;
      found.push(name);
      remaining.delete(name);
    }
    for (const name of declared.get(g.title) ?? []) {
      if (!remaining.has(name)) continue;
      found.push(name);
      remaining.delete(name);
    }
    if (found.length > 0) out.push({ title: g.title, commands: found });
  }

  if (remaining.size > 0) {
    const leftover = cmd
      .commands()
      .filter((c) => remaining.has(c.name()))
      .map((c) => c.name());
    out.push({ title: UNGROUPED_TITLE, commands: leftover });
  }
  return out;
}

/**
 * Orders a command's own subcommand list by what a reader reaches for rather than by spelling.
 * The lexicon is generic, so a new noun command gets sensible ordering without registering anything.
 */
export function subcommandRank(name: string): number {
  switch (name) {
    case "create":
    case "new":
    case "init":
      return 0;
    case "list":
    case "inbox":
      return 1;
    case "view":
    case "get":
    case "show":
      return 2;
    case "edit":
    case "update":
      return 3;
    case "archive":
    case "unarchive":
    case "batch-archive":
    case "batch-unarchive":
    case "delete":
    case "hard-delete":
    case "cleanup":
      return 5;
    default:
      return 4;
  }
}

/** Names ordered by rank, then alphabetically within a rank (stable, like sort.SliceStable). */
export function sortSubcommands(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ra = subcommandRank(a);
    const rb = subcommandRank(b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
