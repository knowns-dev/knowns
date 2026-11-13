// Spec D13 adds PR #156 (tasks by assignee) on top of the 0.34.1 baseline: the `task assignees`
// command, `task list --unassigned`, and the MCP tasks list parameter `unassigned`. Tests that
// diff help, completion or tool schemas against the baseline oracle drop exactly those additions
// from the TypeScript output first; their own behavior is diffed against a Go build of the PR in
// test/cli/commands/task-assignees.diff.test.ts and test/mcp/tasks-unassigned.diff.test.ts.
// Every pattern is literal, so anything else that differs still fails.

const ANSI = "(?:\\x1b\\[[0-9;]*m)?";

const PATTERNS: RegExp[] = [
  // `task list --help` example block.
  new RegExp(
    `^${ANSI} {2}# Work nobody has picked up yet${ANSI}\\n${ANSI} {2}knowns task list --unassigned${ANSI}\\n\\n`,
    "m",
  ),
  // Flag rows in help.
  /^ +--unassigned +Only tasks with no assignee\n/gm,
  // The subcommand row in `task` help and in unknown-command suggestions.
  new RegExp(`^ +${ANSI}assignees${ANSI} +Count tasks per assignee\\n`, "gm"),
  // Completion candidates, with and without descriptions.
  /^assignees(?:\tCount tasks per assignee)?\n/gm,
  /^--unassigned(?:\tOnly tasks with no assignee)?\n/gm,
  // MCP tools/list: the tool description and the input schema property.
  /"unassigned":\{"description":"Only Tasks with no assignee; cannot be combined with assignee \(list\)","type":"boolean"\},/g,
  // MCP help("tasks.list") params, raw or JSON-escaped inside a JSON-RPC line.
  /,(?:\\n|\n) *\\?"unassigned\\?": \\?"only Tasks with no assignee; not with assignee\\?"/g,
];

/** The TypeScript output with the D13 additions removed, for a diff against the 0.34.1 oracle. */
export function withoutD13(text: string): string {
  let out = text.replaceAll("assignee, unassigned, label", "assignee, label");
  for (const re of PATTERNS) out = out.replace(re, "");
  return out;
}
