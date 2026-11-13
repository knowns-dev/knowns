/** The styled help renderer (customHelpFunc in root.go). */
import type { Command } from "./command.ts";
import { isJSON, isPlain } from "./helpers.ts";
import { groupRootCommands, isListableCommand, sortSubcommands } from "./helpgroups.ts";
import { StyleBold, StyleDim, StyleInfo, setPlainOutput } from "./plainoutput.ts";

export function customHelpFunc(version: string): (cmd: Command, args: string[]) => void {
  return (cmd) => {
    // Cobra serves help without running PersistentPreRun, so --plain/--json are honored here too.
    if (isPlain(cmd) || isJSON(cmd)) setPlainOutput(true);

    let out = "";
    const println = (s = ""): void => {
      out += `${s}\n`;
    };

    println(`${StyleBold.render(cmd.short)} ${StyleDim.render(`(v${version})`)}`);
    println();

    // A command that both takes arguments itself and has subcommands gets both usage lines.
    println(`${StyleBold.render("Usage:")} ${StyleInfo.render(cmd.useLine())}`);
    if (cmd.hasAvailableSubCommands()) {
      println(
        `${" ".repeat("Usage:".length)} ${StyleInfo.render(`${cmd.commandPath()} [command]`)}`,
      );
    }
    println();

    // Examples: comment lines are dimmed so the runnable lines stand out.
    if (cmd.example !== "") {
      println(StyleBold.render("Examples:"));
      for (const line of cmd.example.replace(/\n+$/u, "").split("\n")) {
        if (line.trim().startsWith("#")) println(StyleDim.render(line));
        else if (line.trim() === "") println();
        else println(StyleInfo.render(line));
      }
      println();
    }

    if (cmd.hasAvailableSubCommands()) {
      const short = new Map<string, string>();
      let maxLen = 0;
      for (const c of cmd.commands()) {
        if (!isListableCommand(c)) continue;
        short.set(c.name(), c.short);
        maxLen = Math.max(maxLen, c.name().length);
      }
      const printCommand = (name: string): void => {
        const padding = " ".repeat(maxLen - name.length + 2);
        println(`  ${StyleInfo.render(name)}${padding}${short.get(name) ?? ""}`);
      };

      if (!cmd.parent()) {
        for (const g of groupRootCommands(cmd)) {
          println(StyleBold.render(`${g.title}:`));
          for (const name of g.commands) printCommand(name);
          println();
        }
      } else {
        const names = cmd
          .commands()
          .filter(isListableCommand)
          .map((c) => c.name());
        println(StyleBold.render("Commands:"));
        for (const name of sortSubcommands(names)) printCommand(name);
        println();
      }
    }

    if (cmd.hasAvailableLocalFlags()) {
      println(StyleBold.render("Options:"));
      println(cmd.localFlags().flagUsages());
    }

    // Global flags on subcommands only; on the root they are already the Options block.
    if (cmd.parent() && cmd.inheritedFlags().hasAvailableFlags()) {
      println(StyleBold.render("Global options:"));
      println(cmd.inheritedFlags().flagUsages());
    }

    println(StyleDim.render('Use "knowns [command] --help" for more information about a command.'));
    cmd.stdout(out);
  };
}
