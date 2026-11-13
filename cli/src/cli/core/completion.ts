/**
 * The hidden `__complete` / `__completeNoDesc` protocol (spf13/cobra v1.10.2 completions.go).
 * The shell scripts ask the program for candidates; it prints one per line, then `:<directive>`
 * on the last line, and a note on stderr that the scripts ignore.
 */
import { appendFileSync } from "node:fs";
import { minimumNArgs } from "./args.ts";
import { Command } from "./command.ts";
import { activeHelpEnvVar, configEnvVar, SHELL_COMP_DIRECTIVE } from "./completion-constants.ts";
import { type Flag, HelpRequested } from "./flags.ts";
import { parseGoBool } from "./gofmt.ts";

export type Completion = string;
export type CompletionResult = [Completion[], number];
export type CompletionFunc = (
  cmd: Command,
  args: string[],
  toComplete: string,
) => CompletionResult | Promise<CompletionResult>;

const D = SHELL_COMP_DIRECTIVE;
const MAX_DIRECTIVE = 64;

const ACTIVE_HELP_MARKER = "_activeHelp_ ";
const BASH_COMP_FILENAME_EXT = "cobra_annotation_bash_completion_filename_extensions";
const BASH_COMP_SUBDIRS_IN_DIR = "cobra_annotation_bash_completion_subdirs_in_dir";
const BASH_COMP_ONE_REQUIRED_FLAG = "cobra_bash_completion_one_required_flag";
const FLAG_SET_BY_COBRA = "cobra_annotation_flag_set_by_cobra";

/** cobra FixedCompletions. */
export function fixedCompletions(choices: Completion[], directive: number): CompletionFunc {
  return () => [choices, directive];
}

const flagCompletionFunctions = new Map<Flag, CompletionFunc>();

/** cobra RegisterFlagCompletionFunc. */
export function registerFlagCompletionFunc(
  cmd: Command,
  flagName: string,
  fn: CompletionFunc,
): void {
  const flag = cmd.flag(flagName);
  if (!flag) throw new Error(`RegisterFlagCompletionFunc: flag '${flagName}' does not exist`);
  if (flagCompletionFunctions.has(flag)) {
    throw new Error(`RegisterFlagCompletionFunc: flag '${flagName}' already registered`);
  }
  flagCompletionFunctions.set(flag, fn);
}

/** Go's ShellCompDirective.string(). */
export function directiveString(d: number): string {
  const names: string[] = [];
  if (d & D.error) names.push("ShellCompDirectiveError");
  if (d & D.noSpace) names.push("ShellCompDirectiveNoSpace");
  if (d & D.noFileComp) names.push("ShellCompDirectiveNoFileComp");
  if (d & D.filterFileExt) names.push("ShellCompDirectiveFilterFileExt");
  if (d & D.filterDirs) names.push("ShellCompDirectiveFilterDirs");
  if (d & D.keepOrder) names.push("ShellCompDirectiveKeepOrder");
  if (names.length === 0) names.push("ShellCompDirectiveDefault");
  if (d >= MAX_DIRECTIVE) return `ERROR: unexpected ShellCompDirective value: ${d}`;
  return names.join(", ");
}

class FlagCompError extends Error {
  constructor(subCommand: string, flagName: string) {
    super(`Subcommand '${subCommand}' does not support flag '${flagName}'`);
  }
}

/** cobra CompDebug: the debug file gets the text; stderr too when asked. */
function compDebug(cmd: Command, msg: string, toStderr: boolean): void {
  const text = `[Debug] ${msg}`;
  const file = cmd.env().BASH_COMP_DEBUG_FILE;
  if (file) {
    try {
      appendFileSync(file, text);
    } catch {
      // Go ignores a file it cannot open.
    }
  }
  if (toStderr) cmd.printErr(text);
}

function compErrorln(cmd: Command, msg: string): void {
  compDebug(cmd, `[Error] ${msg}\n`, true);
}

/** Adds the hidden `__complete` command, keeping it only when the arguments select it. */
export function initCompleteCmd(root: Command, args: string[]): void {
  const completeCmd = new Command({
    use: "__complete [command-line]",
    aliases: ["__completeNoDesc"],
    disableFlagsInUseLine: true,
    hidden: true,
    disableFlagParsing: true,
    args: minimumNArgs(1),
    short: "Request shell completion choices for the specified command-line",
    long: "__complete is a special command that is used by the shell completion logic\nto request completion choices for the specified command-line.",
    run: async (cmd, a) => {
      const { finalCmd, completions, directive, err } = await getCompletions(cmd, a);
      if (err) compErrorln(cmd, err.message);

      let noDescriptions = cmd.calledAs() === "__completeNoDesc";
      if (!noDescriptions) {
        const parsed = parseGoBool(getEnvConfig(cmd, "COMPLETION_DESCRIPTIONS"));
        if (parsed.ok) noDescriptions = !parsed.value;
      }
      const noActiveHelp = getActiveHelpConfig(finalCmd) === "0";
      let out = "";
      for (const original of completions) {
        let comp = original;
        if (noActiveHelp && comp.startsWith(ACTIVE_HELP_MARKER)) continue;
        if (noDescriptions) comp = comp.split("\t")[0] as string;
        // Only the first line: a description with a line break would read as more candidates.
        comp = comp.split("\n")[0] as string;
        out += `${goTrimSpace(comp)}\n`;
      }
      out += `:${directive}\n`;
      finalCmd.stdout(out);
      finalCmd.printErr(`Completion ended with directive: ${directiveString(directive)}\n`);
    },
  });
  root.addCommand(completeCmd);
  const found = root.find(args);
  if (found.err || found.cmd.name() !== "__complete") root.removeCommand(completeCmd);
}

/** Go strings.TrimSpace (Unicode white space). */
function goTrimSpace(s: string): string {
  return s.replace(/^[\s\u0085 ]+|[\s\u0085 ]+$/gu, "");
}

function getEnvConfig(cmd: Command, suffix: string): string {
  const env = cmd.env();
  const v = env[configEnvVar(cmd.root().name(), suffix)] ?? "";
  return v !== "" ? v : (env[configEnvVar("COBRA", suffix)] ?? "");
}

function getActiveHelpConfig(cmd: Command): string {
  const env = cmd.env();
  let cfg = env.COBRA_ACTIVE_HELP ?? "";
  if (cfg !== "0") cfg = env[activeHelpEnvVar(cmd.root().name())] ?? "";
  return cfg;
}

interface Completions {
  finalCmd: Command;
  completions: Completion[];
  directive: number;
  err?: Error;
}

function isFlagArg(arg: string): boolean {
  return (
    (arg.length >= 3 && arg.startsWith("--")) ||
    (arg.length >= 2 && arg[0] === "-" && arg[1] !== "-")
  );
}

function findFlag(cmd: Command, name: string): Flag | undefined {
  let flagName = name;
  if (name.length === 1) {
    const short = cmd.flags().shorthandLookup(name);
    if (short) {
      flagName = short.name;
    } else {
      const inherited = cmd.inheritedFlags().shorthandLookup(name);
      if (!inherited) return undefined;
      flagName = inherited.name;
    }
  }
  return cmd.flag(flagName);
}

function checkIfFlagCompletion(
  finalCmd: Command,
  args: string[],
  lastArgIn: string,
): { flag: Flag | undefined; args: string[]; lastArg: string; err?: Error } {
  if (finalCmd.disableFlagParsing) return { flag: undefined, args, lastArg: lastArgIn };

  let lastArg = lastArgIn;
  let flagName = "";
  let trimmedArgs = args;
  let flagWithEqual = false;
  const orgLastArg = lastArg;

  if (lastArg.length > 0 && lastArg[0] === "-") {
    const index = lastArg.indexOf("=");
    if (index >= 0) {
      if (lastArg.slice(0, index).startsWith("--")) {
        flagName = lastArg.slice(2, index);
      } else {
        // The last shorthand of e.g. `-asd=`.
        flagName = lastArg.slice(index - 1, index);
      }
      lastArg = lastArg.slice(index + 1);
      flagWithEqual = true;
    } else {
      return { flag: undefined, args, lastArg };
    }
  }

  if (flagName.length === 0 && args.length > 0) {
    const prevArg = args[args.length - 1] as string;
    if (isFlagArg(prevArg) && prevArg.indexOf("=") < 0) {
      flagName = prevArg.startsWith("--") ? prevArg.slice(2) : prevArg.slice(prevArg.length - 1);
      // Drop the unfinished flag, or its missing value would fail the parse.
      trimmedArgs = args.slice(0, -1);
    }
  }

  if (flagName.length === 0) return { flag: undefined, args: trimmedArgs, lastArg };

  let flag = findFlag(finalCmd, flagName);
  if (!flag) {
    return {
      flag: undefined,
      args,
      lastArg: orgLastArg,
      err: new FlagCompError(finalCmd.name(), flagName),
    };
  }

  if (!flagWithEqual && flag.noOptDefVal.length !== 0) {
    // A boolean flag takes no value: this is not flag value completion after all.
    trimmedArgs = args;
    flag = undefined;
  }
  return { flag, args: trimmedArgs, lastArg };
}

function nonCompletableFlag(flag: Flag): boolean {
  return flag.hidden || flag.deprecated.length > 0;
}

function getFlagNameCompletions(flag: Flag, toComplete: string): Completion[] {
  if (nonCompletableFlag(flag)) return [];
  const completions: Completion[] = [];
  const long = `--${flag.name}`;
  if (long.startsWith(toComplete)) completions.push(`${long}\t${flag.usage}`);
  const short = `-${flag.shorthand}`;
  if (flag.shorthand.length > 0 && short.startsWith(toComplete)) {
    completions.push(`${short}\t${flag.usage}`);
  }
  return completions;
}

function completeRequireFlags(finalCmd: Command, toComplete: string): Completion[] {
  const completions: Completion[] = [];
  const visit = (flag: Flag): void => {
    if (flag.annotations[BASH_COMP_ONE_REQUIRED_FLAG] !== undefined && !flag.changed) {
      completions.push(...getFlagNameCompletions(flag, toComplete));
    }
  };
  finalCmd.inheritedFlags().visitAll(visit);
  finalCmd.localFlags().visitAll(visit);
  return completions;
}

function helpOrVersionFlagPresent(cmd: Command): boolean {
  const version = cmd.flags().lookup("version");
  if (version && (version.annotations[FLAG_SET_BY_COBRA]?.length ?? 0) > 0 && version.changed) {
    return true;
  }
  const help = cmd.flags().lookup("help");
  return !!help && (help.annotations[FLAG_SET_BY_COBRA]?.length ?? 0) > 0 && help.changed;
}

/** cobra enforceFlagGroupsForCompletion: lets the ordinary completion logic honour flag groups. */
function enforceFlagGroupsForCompletion(c: Command): void {
  if (c.disableFlagParsing) return;
  const flags = c.flags();
  const known = (names: string[]): boolean => names.every((n) => flags.lookup(n));
  const markRequired = (name: string): void => {
    const f = flags.lookup(name);
    if (f) f.annotations[BASH_COMP_ONE_REQUIRED_FLAG] = ["true"];
  };

  for (const names of c.flagGroups.requiredTogether ?? []) {
    if (!known(names)) continue;
    if (names.some((n) => flags.lookup(n)?.changed)) names.forEach(markRequired);
  }
  for (const names of c.flagGroups.oneRequired ?? []) {
    if (!known(names)) continue;
    if (!names.some((n) => flags.lookup(n)?.changed)) names.forEach(markRequired);
  }
  for (const names of c.flagGroups.mutuallyExclusive ?? []) {
    if (!known(names)) continue;
    for (const setName of names) {
      if (!flags.lookup(setName)?.changed) continue;
      for (const other of names) {
        const f = flags.lookup(other);
        if (other !== setName && f) f.hidden = true;
      }
    }
  }
}

function errMessage(e: unknown): string {
  if (e instanceof HelpRequested) return "pflag: help requested";
  return e instanceof Error ? e.message : String(e);
}

function listOf(xs: string[]): string {
  return `[${xs.join(" ")}]`;
}

async function getCompletions(c: Command, args: string[]): Promise<Completions> {
  let toComplete = args[args.length - 1] as string;
  const trimmedArgs = args.slice(0, -1);

  // For a root without subcommands, Find would reject any argument because of __complete.
  const rootCmd = c.root();
  if (rootCmd.commands().length === 1) rootCmd.removeCommand(c);

  // A lazy command must be real before its flags and subcommands can be completed.
  for (const x of rootCmd.lazyPath(trimmedArgs)) await x.materialize();

  const found = rootCmd.find(trimmedArgs);
  if (found.err) {
    return {
      finalCmd: c,
      completions: [],
      directive: D.default,
      err: new Error(`unable to find a command for arguments: ${listOf(trimmedArgs)}`),
    };
  }
  const finalCmd = found.cmd;
  let finalArgs = found.args;

  // These flags are normally added by execute(), which completion never calls.
  if (!finalCmd.disableFlagParsing) {
    finalCmd.initDefaultHelpFlag();
    finalCmd.initDefaultVersionFlag();
  }

  const check = checkIfFlagCompletion(finalCmd, finalArgs, toComplete);
  const flag = check.flag;
  finalArgs = check.args;
  toComplete = check.lastArg;
  const flagErr = check.err;

  // Counting arguments with an extra `--` tells whether flags can still be completed: when `--`
  // was already given, the extra one counts as an argument.
  let flagCompletion = true;
  try {
    finalCmd.parseFlags([...finalArgs, "--"]);
  } catch {
    // Only the argument count matters here.
  }
  const newArgCount = finalCmd.flags().args().length;

  try {
    finalCmd.parseFlags(finalArgs);
  } catch (e) {
    return {
      finalCmd,
      completions: [],
      directive: D.default,
      err: new Error(`Error while parsing flags from args ${listOf(finalArgs)}: ${errMessage(e)}`),
    };
  }
  const realArgCount = finalCmd.flags().args().length;
  if (newArgCount > realArgCount) flagCompletion = false;

  if (flagErr && (!(flagErr instanceof FlagCompError) || flagCompletion)) {
    return { finalCmd, completions: [], directive: D.default, err: flagErr };
  }

  if (helpOrVersionFlagPresent(finalCmd)) {
    return { finalCmd, completions: [], directive: D.noFileComp };
  }

  if (!finalCmd.disableFlagParsing) finalArgs = finalCmd.flags().args();

  if (flag && flagCompletion) {
    const validExts = flag.annotations[BASH_COMP_FILENAME_EXT];
    if (validExts !== undefined && validExts.length !== 0) {
      return { finalCmd, completions: validExts, directive: D.filterFileExt };
    }
    const subDir = flag.annotations[BASH_COMP_SUBDIRS_IN_DIR];
    if (subDir !== undefined) {
      if (subDir.length === 1) return { finalCmd, completions: subDir, directive: D.filterDirs };
      return { finalCmd, completions: [], directive: D.filterDirs };
    }
  }

  let completions: Completion[] = [];
  let directive: number;

  enforceFlagGroupsForCompletion(finalCmd);

  if (
    !flag &&
    toComplete.length > 0 &&
    toComplete[0] === "-" &&
    !toComplete.includes("=") &&
    flagCompletion
  ) {
    // Completing a flag name: required flags first, the rest only when there are none.
    completions = completeRequireFlags(finalCmd, toComplete);
    if (completions.length === 0) {
      const doCompleteFlags = (f: Flag): void => {
        const type = f.value.type as string;
        const acceptsMultiple =
          type.includes("Slice") || type.includes("Array") || type.startsWith("stringTo");
        if (!f.changed || acceptsMultiple) {
          completions.push(...getFlagNameCompletions(f, toComplete));
        }
      };
      finalCmd.inheritedFlags().visitAll(doCompleteFlags);
      finalCmd.localFlags().visitAll(doCompleteFlags);
    }

    directive = D.noFileComp;
    if (completions.length === 1 && (completions[0] as string).endsWith("=")) {
      directive = D.noSpace;
    }
    if (!finalCmd.disableFlagParsing) return { finalCmd, completions, directive };
  } else {
    directive = D.default;
    if (!flag) {
      let foundLocalNonPersistentFlag = false;
      const persistent = finalCmd.persistentFlags();
      finalCmd.localFlags().visitAll((f) => {
        if (!persistent.lookup(f.name) && f.changed) foundLocalNonPersistentFlag = true;
      });

      // Subcommand names, the help command included, only while no argument has been given.
      if (finalArgs.length === 0 && !foundLocalNonPersistentFlag) {
        for (const sub of finalCmd.commands()) {
          if (sub.isAvailableCommand() || sub === finalCmd.helpCmd()) {
            if (sub.name().startsWith(toComplete)) completions.push(`${sub.name()}\t${sub.short}`);
            directive = D.noFileComp;
          }
        }
      }

      completions.push(...completeRequireFlags(finalCmd, toComplete));

      if (finalCmd.validArgs.length > 0) {
        if (finalArgs.length === 0) {
          for (const v of finalCmd.validArgs) if (v.startsWith(toComplete)) completions.push(v);
          directive = D.noFileComp;
          if (completions.length === 0) {
            for (const a of finalCmd.argAliases) if (a.startsWith(toComplete)) completions.push(a);
          }
        }
        return { finalCmd, completions, directive };
      }
    }
  }

  const completionFn =
    flag && flagCompletion ? flagCompletionFunctions.get(flag) : finalCmd.validArgsFunction;
  if (completionFn) {
    const [comps, d] = await completionFn(finalCmd, finalArgs, toComplete);
    completions.push(...comps);
    directive = d;
  }

  return { finalCmd, completions, directive };
}
