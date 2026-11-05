// `knowns import` (internal/cli/import_cmd.go) was removed by spec decision D8: the command and
// each subcommand (list, add, remove, status, sync) now fail with a removal message. Content
// already under .knowns/imports/ is untouched and stays readable and searchable through the doc,
// template and search commands; nothing manages it any more.

import { arbitraryArgs } from "../core/args.ts";
import { type CommandSpec, defineCommand } from "../core/define.ts";
import { REMOVED_COMMAND_SHORT } from "../core/removed.ts";

export const IMPORT_REMOVED_MESSAGE =
  "'knowns import' was removed. Content already imported stays readable and searchable, but import management (list, add, remove, status, sync) is no longer available.";

const LONG = `The import command and its subcommands (list, add, remove, status, sync) were removed.

Content already present in .knowns/imports/ stays readable and searchable through
'knowns doc', 'knowns template' and 'knowns search'. There is no further management
of imports: nothing adds, updates or removes them.`;

/** Every argument is accepted (flags included) so the removal message shows whatever was typed. */
function removed(name: string, short: string): CommandSpec {
  return defineCommand({
    use: name,
    short,
    long: LONG,
    args: arbitraryArgs,
    disableFlagParsing: true,
    silenceUsage: true,
    run(ctx) {
      // Flag parsing is off, so help is requested by hand.
      if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
        ctx.cmd.help();
        return;
      }
      throw new Error(IMPORT_REMOVED_MESSAGE);
    },
  });
}

export default defineCommand({
  use: "import",
  short: REMOVED_COMMAND_SHORT.import ?? "",
  long: LONG,
  args: arbitraryArgs,
  silenceUsage: true,
  run() {
    throw new Error(IMPORT_REMOVED_MESSAGE);
  },
  subcommands: [
    removed("list", "List imports (removed)"),
    removed("add <source>", "Add an import source (removed)"),
    removed("remove <name>", "Remove an import (removed)"),
    removed("status", "Show import status (removed)"),
    removed("sync [name]", "Sync imports (removed)"),
  ],
});
