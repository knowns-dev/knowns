/**
 * A cobra-compatible command tree. Only the parts of spf13/cobra v1.10.2 that the Go CLI relies
 * on are reproduced, but those are reproduced faithfully: command lookup (including its
 * flag-skipping quirks), the default usage template, the `help` command, error and usage
 * printing, and the exact order of persistent/pre/run hooks. See cli/README.md ("CLI framework")
 * for why this is a small bespoke engine instead of commander/yargs.
 */
import { goGetwd } from "../../storage/core/getwd.ts";
import type { PositionalArgs } from "./args.ts";
import type { CompletionFunc } from "./completion.ts";
import { SilentExit } from "./exit.ts";
import { type Flag, FlagError, FlagSet, HelpRequested } from "./flags.ts";
import { goBackquote, goQuote, levenshtein } from "./gofmt.ts";
import type { IO } from "./io.ts";

export type RunFunc = (cmd: Command, args: string[]) => void | Promise<void>;

/** Annotation key under which a command records the title of its root-help group. */
export const HELP_GROUP_ANNOTATION = "knowns.helpGroup";
/** Annotation key cobra uses to override the name shown in help. */
export const DISPLAY_NAME_ANNOTATION = "cobra_annotation_command_display_name";

const MIN_NAME_PADDING = 11;
const HELP_COMMAND_NAME = "help";

/** Groups of flag names; each inner array is one group. */
export interface FlagGroups {
  requiredTogether?: string[][];
  oneRequired?: string[][];
  mutuallyExclusive?: string[][];
}

export interface CommandInit {
  use: string;
  short?: string;
  long?: string;
  example?: string;
  aliases?: string[];
  hidden?: boolean;
  deprecated?: string;
  version?: string;
  args?: PositionalArgs;
  silenceUsage?: boolean;
  silenceErrors?: boolean;
  disableFlagParsing?: boolean;
  disableFlagsInUseLine?: boolean;
  annotations?: Record<string, string>;
  run?: RunFunc;
  persistentPreRun?: RunFunc;
  preRun?: RunFunc;
  postRun?: RunFunc;
  persistentPostRun?: RunFunc;
  flagErrorFunc?: (cmd: Command, err: Error) => Error;
  /** Builds the real command on first use; `short`/`hidden` must already describe it for listings. */
  loader?: () => Promise<Command>;
  /** Static positional-argument completions (cobra ValidArgs). */
  validArgs?: string[];
  argAliases?: string[];
  /** Dynamic positional-argument completions (cobra ValidArgsFunction). */
  validArgsFunction?: CompletionFunc;
}

export class Command {
  use: string;
  short: string;
  long: string;
  example: string;
  aliases: string[];
  hidden: boolean;
  deprecated: string;
  version: string;
  args: PositionalArgs | undefined;
  silenceUsage: boolean;
  silenceErrors: boolean;
  disableFlagParsing: boolean;
  disableFlagsInUseLine: boolean;
  annotations: Record<string, string>;
  run: RunFunc | undefined;
  persistentPreRun: RunFunc | undefined;
  preRun: RunFunc | undefined;
  postRun: RunFunc | undefined;
  persistentPostRun: RunFunc | undefined;
  flagErrorFunc: ((cmd: Command, err: Error) => Error) | undefined;
  loader: (() => Promise<Command>) | undefined;
  validArgs: string[];
  argAliases: string[];
  validArgsFunction: CompletionFunc | undefined;
  /** The name or alias the command was looked up by (cobra CalledAs); "" until found. */
  calledAsName = "";
  /** Flag groups, checked after the required flags (cobra MarkFlags*). */
  flagGroups: FlagGroups = {};
  /** Replaces the default help renderer (set on the root; children inherit). */
  helpFunc: ((cmd: Command, args: string[]) => void) | undefined;
  /** Output for the whole tree; only meaningful on the root. */
  io: IO | undefined;
  /** Environment and working directory for the run; only meaningful on the root. */
  runEnv: Record<string, string | undefined> | undefined;
  runCwd: string | undefined;
  suggestionsMinimumDistance = 2;

  private parentCmd: Command | undefined;
  private children: Command[] = [];
  private sorted = false;
  private maxNameLen = 0;
  private helpCommand: Command | undefined;
  private flagSet: FlagSet | undefined;
  private pflagSet: FlagSet | undefined;
  private parentsPflags: FlagSet | undefined;
  private lflags: FlagSet | undefined;
  private iflags: FlagSet | undefined;

  constructor(init: CommandInit) {
    this.use = init.use;
    this.short = init.short ?? "";
    this.long = init.long ?? "";
    this.example = init.example ?? "";
    this.aliases = init.aliases ?? [];
    this.hidden = init.hidden ?? false;
    this.deprecated = init.deprecated ?? "";
    this.version = init.version ?? "";
    this.args = init.args;
    this.silenceUsage = init.silenceUsage ?? false;
    this.silenceErrors = init.silenceErrors ?? false;
    this.disableFlagParsing = init.disableFlagParsing ?? false;
    this.disableFlagsInUseLine = init.disableFlagsInUseLine ?? false;
    this.annotations = init.annotations ?? {};
    this.run = init.run;
    this.persistentPreRun = init.persistentPreRun;
    this.preRun = init.preRun;
    this.postRun = init.postRun;
    this.persistentPostRun = init.persistentPostRun;
    this.flagErrorFunc = init.flagErrorFunc;
    this.loader = init.loader;
    this.validArgs = init.validArgs ?? [];
    this.argAliases = init.argAliases ?? [];
    this.validArgsFunction = init.validArgsFunction;
  }

  /** cobra CalledAs: the name or alias this command was found by. */
  calledAs(): string {
    return this.calledAsName;
  }

  /** The `help` subcommand, once the root has created it. */
  helpCmd(): Command | undefined {
    return this.helpCommand;
  }

  // --- tree ------------------------------------------------------------------------------------

  parent(): Command | undefined {
    return this.parentCmd;
  }

  root(): Command {
    return this.parentCmd ? this.parentCmd.root() : this;
  }

  addCommand(...cmds: Command[]): void {
    for (const x of cmds) {
      if (x === this) throw new Error("Command can't be a child of itself");
      x.parentCmd = this;
      this.maxNameLen = Math.max(this.maxNameLen, x.name().length);
      this.children.push(x);
      this.sorted = false;
    }
  }

  removeCommand(...cmds: Command[]): void {
    this.children = this.children.filter((c) => !cmds.includes(c));
    for (const c of cmds) c.parentCmd = undefined;
    this.maxNameLen = Math.max(0, ...this.children.map((c) => c.name().length));
  }

  /** Swaps a lazy placeholder for its real command, keeping its place and the name padding. */
  replaceCommand(old: Command, next: Command): void {
    const i = this.children.indexOf(old);
    if (i < 0) throw new Error(`${old.name()} is not a child of ${this.name()}`);
    this.children[i] = next;
    next.parentCmd = this;
    old.parentCmd = undefined;
    this.maxNameLen = Math.max(this.maxNameLen, next.name().length);
    this.sorted = false;
    if (this.helpCommand === old) this.helpCommand = next;
  }

  /** Subcommands, sorted by name (cobra's EnableCommandSorting). */
  commands(): Command[] {
    if (!this.sorted) {
      this.children.sort((a, b) => (a.name() < b.name() ? -1 : a.name() > b.name() ? 1 : 0));
      this.sorted = true;
    }
    return this.children;
  }

  name(): string {
    const i = this.use.indexOf(" ");
    return i >= 0 ? this.use.slice(0, i) : this.use;
  }

  displayName(): string {
    return this.annotations[DISPLAY_NAME_ANNOTATION] ?? this.name();
  }

  commandPath(): string {
    return this.parentCmd ? `${this.parentCmd.commandPath()} ${this.name()}` : this.displayName();
  }

  nameAndAliases(): string {
    return [this.name(), ...this.aliases].join(", ");
  }

  hasAlias(s: string): boolean {
    return this.aliases.includes(s);
  }

  runnable(): boolean {
    return this.run !== undefined;
  }

  hasSubCommands(): boolean {
    return this.children.length > 0;
  }

  isAvailableCommand(): boolean {
    if (this.deprecated !== "" || this.hidden) return false;
    if (this.parentCmd && this.parentCmd.helpCommand === this) return false;
    return this.runnable() || this.hasAvailableSubCommands();
  }

  hasAvailableSubCommands(): boolean {
    return this.children.some((c) => c.isAvailableCommand());
  }

  isAdditionalHelpTopicCommand(): boolean {
    if (this.runnable() || this.deprecated !== "" || this.hidden) return false;
    return this.children.every((c) => c.isAdditionalHelpTopicCommand());
  }

  hasHelpSubCommands(): boolean {
    return this.children.some((c) => c.isAdditionalHelpTopicCommand());
  }

  namePadding(): number {
    if (!this.parentCmd || MIN_NAME_PADDING > this.parentCmd.maxNameLen) return MIN_NAME_PADDING;
    return this.parentCmd.maxNameLen;
  }

  useLine(): string {
    const use = this.use.replace(this.name(), this.displayName());
    let line = this.parentCmd ? `${this.parentCmd.commandPath()} ${use}` : use;
    if (this.disableFlagsInUseLine) return line;
    if (this.hasAvailableFlags() && !line.includes("[flags]")) line += " [flags]";
    return line;
  }

  /** The environment of this run (process.env unless the run was started with another). */
  env(): Record<string, string | undefined> {
    return this.root().runEnv ?? process.env;
  }

  /** The working directory of this run. */
  cwd(): string {
    return this.root().runCwd ?? goGetwd(this.env());
  }

  // --- output ----------------------------------------------------------------------------------

  private rootIO(): IO {
    const io = this.root().io;
    if (!io) throw new Error("command tree has no output attached; call cli.execute()");
    return io;
  }

  /** cobra Print: the "output" stream, which falls back to stderr. */
  print(text: string): void {
    this.rootIO().err.write(text);
  }

  /** cobra PrintErr. */
  printErr(text: string): void {
    this.rootIO().err.write(text);
  }

  /** stdout, for command results (what Go commands write with fmt.Print*). */
  stdout(text: string): void {
    this.rootIO().out.write(text);
  }

  // --- flags -----------------------------------------------------------------------------------

  flags(): FlagSet {
    this.flagSet ??= new FlagSet(this.displayName());
    return this.flagSet;
  }

  persistentFlags(): FlagSet {
    this.pflagSet ??= new FlagSet(this.displayName());
    return this.pflagSet;
  }

  private updateParentsPflags(): void {
    if (!this.parentsPflags) {
      this.parentsPflags = new FlagSet(this.displayName());
      this.parentsPflags.sortFlags = false;
    }
    for (let p = this.parentCmd; p; p = p.parentCmd) {
      this.parentsPflags.addFlagSet(p.persistentFlags());
    }
  }

  private mergePersistentFlags(): void {
    this.updateParentsPflags();
    this.flags().addFlagSet(this.persistentFlags());
    this.flags().addFlagSet(this.parentsPflags);
  }

  localFlags(): FlagSet {
    this.mergePersistentFlags();
    this.lflags ??= new FlagSet(this.displayName());
    const l = this.lflags;
    l.sortFlags = this.flags().sortFlags;
    const add = (f: Flag): void => {
      if (!l.lookup(f.name) && f !== this.parentsPflags?.lookup(f.name)) l.addFlag(f);
    };
    this.flags().visitAll(add);
    this.persistentFlags().visitAll(add);
    return l;
  }

  inheritedFlags(): FlagSet {
    this.mergePersistentFlags();
    this.iflags ??= new FlagSet(this.displayName());
    const local = this.localFlags();
    const i = this.iflags;
    this.parentsPflags?.visitAll((f) => {
      if (!i.lookup(f.name) && !local.lookup(f.name)) i.addFlag(f);
    });
    return i;
  }

  hasAvailableFlags(): boolean {
    return this.flags().hasAvailableFlags();
  }

  hasAvailableLocalFlags(): boolean {
    return this.localFlags().hasAvailableFlags();
  }

  hasAvailableInheritedFlags(): boolean {
    return this.inheritedFlags().hasAvailableFlags();
  }

  /** Looks a flag up on this command or any ancestor's persistent flags. */
  flag(name: string): Flag | undefined {
    this.mergePersistentFlags();
    return this.flags().lookup(name);
  }

  initDefaultHelpFlag(): void {
    this.mergePersistentFlags();
    if (!this.flags().lookup("help")) {
      const name = this.displayName();
      const f = this.flags().define(
        "bool",
        "help",
        "h",
        `help for ${name === "" ? "this command" : name}`,
        false,
      );
      f.annotations.cobra_annotation_flag_set_by_cobra = ["true"];
    }
  }

  initDefaultVersionFlag(): void {
    if (this.version === "") return;
    this.mergePersistentFlags();
    if (!this.flags().lookup("version")) {
      const usage = `version for ${this.name() === "" ? "this command" : this.displayName()}`;
      const short = this.flags().shorthandLookup("v") ? "" : "v";
      const f = this.flags().define("bool", "version", short, usage, false);
      f.annotations.cobra_annotation_flag_set_by_cobra = ["true"];
    }
  }

  /** cobra ParseFlags: throws FlagError / HelpRequested. */
  parseFlags(args: string[]): void {
    if (this.disableFlagParsing) return;
    this.mergePersistentFlags();
    const fs = this.flags();
    const before = fs.notices.length;
    fs.parse(args);
    if (fs.notices.length > before) {
      this.print(fs.notices.slice(before).join(""));
    }
  }

  // --- typed flag reads (cobra's Flags().GetX) --------------------------------------------------

  private typed<T>(name: string, type: string): T {
    const f = this.flag(name);
    if (!f) throw new Error(`flag accessed but not defined: ${name}`);
    if (f.value.type !== type) {
      throw new Error(`trying to get ${type} value of flag of type ${f.value.type}`);
    }
    return f.value.get() as T;
  }
  getBool(name: string): boolean {
    return this.typed<boolean>(name, "bool");
  }
  getString(name: string): string {
    return this.typed<string>(name, "string");
  }
  getInt(name: string): number {
    return this.typed<number>(name, "int");
  }
  getFloat(name: string): number {
    return this.typed<number>(name, "float64");
  }
  getStrings(name: string): string[] {
    const f = this.flag(name);
    if (!f) throw new Error(`flag accessed but not defined: ${name}`);
    if (f.value.type !== "stringArray" && f.value.type !== "stringSlice") {
      throw new Error(`trying to get stringSlice value of flag of type ${f.value.type}`);
    }
    return f.value.get() as string[];
  }
  getInts(name: string): number[] {
    return this.typed<number[]>(name, "intSlice");
  }
  /** Whether the flag was given on the command line. */
  changed(name: string): boolean {
    return this.flag(name)?.changed ?? false;
  }

  // --- lookup ----------------------------------------------------------------------------------

  private findNext(next: string): Command | undefined {
    for (const c of this.children) {
      if (c.name() === next || c.hasAlias(next)) {
        c.calledAsName = next;
        return c;
      }
    }
    return undefined;
  }

  private hasNoOptDefVal(name: string): boolean {
    const f = this.flags().lookup(name);
    return f !== undefined && f.noOptDefVal !== "";
  }

  private shortHasNoOptDefVal(name: string): boolean {
    if (name.length === 0) return false;
    const f = this.flags().shorthandLookup(name.slice(0, 1));
    return f !== undefined && f.noOptDefVal !== "";
  }

  /** cobra stripFlags: the non-flag arguments, skipping flag values it can recognise. */
  stripFlags(input: string[]): string[] {
    if (input.length === 0) return input;
    this.mergePersistentFlags();
    const commands: string[] = [];
    let args = input;
    while (args.length > 0) {
      const s = args[0] ?? "";
      args = args.slice(1);
      if (s === "--") break;
      const longNoDefault =
        s.startsWith("--") && !s.includes("=") && !this.hasNoOptDefVal(s.slice(2));
      const shortNoDefault =
        s.startsWith("-") &&
        !s.includes("=") &&
        s.length === 2 &&
        !this.shortHasNoOptDefVal(s.slice(1));
      if (longNoDefault || shortNoDefault) {
        // '--flag arg': drop arg, or stop when at most one argument is left.
        if (args.length <= 1) break;
        args = args.slice(1);
        continue;
      }
      if (s !== "" && !s.startsWith("-")) commands.push(s);
    }
    return commands;
  }

  /** cobra argsMinusFirstX: removes only the first x, never a flag's value. */
  private argsMinusFirstX(args: string[], x: string): string[] {
    if (args.length === 0) return args;
    this.mergePersistentFlags();
    for (let pos = 0; pos < args.length; pos++) {
      const s = args[pos] ?? "";
      if (s === "--") break;
      const longNoDefault =
        s.startsWith("--") && !s.includes("=") && !this.hasNoOptDefVal(s.slice(2));
      const shortNoDefault =
        s.startsWith("-") &&
        !s.includes("=") &&
        s.length === 2 &&
        !this.shortHasNoOptDefVal(s.slice(1));
      if (longNoDefault || shortNoDefault) {
        pos++;
        continue;
      }
      if (!s.startsWith("-") && s === x) return [...args.slice(0, pos), ...args.slice(pos + 1)];
    }
    return args;
  }

  /** The names `find(args)` would descend through, so lazy commands can be loaded first. */
  lazyPath(args: string[]): Command[] {
    const out: Command[] = [];
    let cmd: Command = this;
    let rest = args;
    for (;;) {
      const words = cmd.stripFlags(rest);
      const first = words[0];
      if (first === undefined) return out;
      const next = cmd.findNext(first);
      if (!next) return out;
      out.push(next);
      rest = cmd.argsMinusFirstX(rest, first);
      cmd = next;
    }
  }

  /** cobra Find. Returns the command, its remaining args, and a legacy-args error if any. */
  find(args: string[]): { cmd: Command; args: string[]; err?: Error } {
    let cmd: Command = this;
    let rest = args;
    for (;;) {
      const words = cmd.stripFlags(rest);
      const first = words[0];
      if (first === undefined) break;
      const next = cmd.findNext(first);
      if (!next) break;
      rest = cmd.argsMinusFirstX(rest, first);
      cmd = next;
    }
    if (cmd.args === undefined) {
      const err = cmd.legacyArgs(cmd.stripFlags(rest));
      return err ? { cmd, args: rest, err } : { cmd, args: rest };
    }
    return { cmd, args: rest };
  }

  /** Root commands with subcommands reject unknown words; everything else takes any arguments. */
  private legacyArgs(args: string[]): Error | undefined {
    if (!this.hasSubCommands()) return undefined;
    if (!this.parentCmd && args.length > 0) {
      const first = args[0] ?? "";
      return new Error(
        `unknown command ${goQuote(first)} for ${goQuote(this.commandPath())}${this.findSuggestions(first)}`,
      );
    }
    return undefined;
  }

  private findSuggestions(arg: string): string {
    const found = this.suggestionsFor(arg);
    if (found.length === 0) return "";
    return `\n\nDid you mean this?\n${found.map((s) => `\t${s}\n`).join("")}`;
  }

  private suggestionsFor(typed: string): string[] {
    const out: string[] = [];
    for (const c of this.commands()) {
      if (!c.isAvailableCommand()) continue;
      const byDistance = levenshtein(typed, c.name()) <= this.suggestionsMinimumDistance;
      const byPrefix = c.name().toLowerCase().startsWith(typed.toLowerCase());
      if (byDistance || byPrefix) out.push(c.name());
    }
    return out;
  }

  // --- usage and help --------------------------------------------------------------------------

  /** The default cobra usage template, rendered. */
  usageString(): string {
    this.mergePersistentFlags();
    const rpad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
    const trimRight = (s: string): string => s.replace(/\s+$/u, "");
    let s = "Usage:";
    if (this.runnable()) s += `\n  ${this.useLine()}`;
    if (this.hasAvailableSubCommands()) s += `\n  ${this.commandPath()} [command]`;
    if (this.aliases.length > 0) s += `\n\nAliases:\n  ${this.nameAndAliases()}`;
    if (this.example.length > 0) s += `\n\nExamples:\n${this.example}`;
    if (this.hasAvailableSubCommands()) {
      s += "\n\nAvailable Commands:";
      for (const c of this.commands()) {
        if (c.isAvailableCommand() || c.name() === HELP_COMMAND_NAME) {
          s += `\n  ${rpad(c.name(), c.namePadding())} ${c.short}`;
        }
      }
    }
    if (this.hasAvailableLocalFlags())
      s += `\n\nFlags:\n${trimRight(this.localFlags().flagUsages())}`;
    if (this.hasAvailableInheritedFlags()) {
      s += `\n\nGlobal Flags:\n${trimRight(this.inheritedFlags().flagUsages())}`;
    }
    if (this.hasHelpSubCommands()) {
      s += "\n\nAdditional help topics:";
      for (const c of this.commands()) {
        if (c.isAdditionalHelpTopicCommand()) {
          s += `\n  ${rpad(c.commandPath(), c.commandPathPadding())} ${c.short}`;
        }
      }
    }
    if (this.hasAvailableSubCommands()) {
      s += `\n\nUse "${this.commandPath()} [command] --help" for more information about a command.`;
    }
    return `${s}\n`;
  }

  private commandPathPadding(): number {
    const min = MIN_NAME_PADDING;
    const longest = Math.max(
      0,
      ...(this.parentCmd?.children ?? []).map((c) => c.commandPath().length),
    );
    return Math.max(min, longest);
  }

  /** Prints the usage text to the error stream (cobra Usage). */
  usage(): void {
    this.print(this.usageString());
  }

  help(): void {
    this.helpFuncResolved()(this, []);
  }

  private helpFuncResolved(): (cmd: Command, args: string[]) => void {
    if (this.helpFunc) return this.helpFunc;
    if (this.parentCmd) return this.parentCmd.helpFuncResolved();
    return (cmd) => {
      const text = (cmd.long || cmd.short).replace(/\s+$/u, "");
      let out = text ? `${text}\n\n` : "";
      if (cmd.runnable() || cmd.hasSubCommands()) out += cmd.usageString();
      cmd.stdout(out);
    };
  }

  // --- execution -------------------------------------------------------------------------------

  private initDefaultHelpCmd(): void {
    if (!this.hasSubCommands()) return;
    if (!this.helpCommand) {
      const helpCmd = new Command({
        use: "help [command]",
        short: "Help about any command",
        long: `Help provides help for any command in the application.\nSimply type ${this.displayName()} help [path to command] for full details.`,
        validArgsFunction: async (c, args, toComplete) => {
          // A lazy command must be real before its subcommands can be listed.
          for (const x of c.root().lazyPath(args)) await x.materialize();
          const found = c.root().find(args);
          // ShellCompDirectiveNoFileComp = 4.
          if (found.err) return [[], 4];
          const completions: string[] = [];
          for (const sub of found.cmd.commands()) {
            if (sub.isAvailableCommand() || sub === found.cmd.helpCommand) {
              if (sub.name().startsWith(toComplete))
                completions.push(`${sub.name()}\t${sub.short}`);
            }
          }
          return [completions, 4];
        },
        run: (c, args) => {
          const found = c.root().find(args);
          if (found.err) {
            c.print(`Unknown help topic [${args.map(goBackquote).join(" ")}]\n`);
            c.root().usage();
            return;
          }
          found.cmd.initDefaultHelpFlag();
          found.cmd.initDefaultVersionFlag();
          found.cmd.help();
        },
      });
      this.helpCommand = helpCmd;
    }
    this.removeCommand(this.helpCommand);
    this.addCommand(this.helpCommand);
  }

  /** Adds a command only when the tree has none by that name (the completion placeholder). */
  addDefaultCommand(cmd: Command): void {
    if (!this.findNext(cmd.name())) this.addCommand(cmd);
  }

  /** Runs the command tree. Only valid on the root; returns the command that ran and any error. */
  async executeC(
    argv: string[],
    io: IO,
    run: { env?: Record<string, string | undefined>; cwd?: string } = {},
  ): Promise<{ cmd: Command; err: Error | undefined }> {
    if (this.parentCmd) return this.root().executeC(argv, io, run);
    this.io = io;
    this.runEnv = run.env;
    this.runCwd = run.cwd;
    this.initDefaultHelpCmd();
    // The hidden __complete command exists only for a call that selects it; the module that
    // builds it is not loaded otherwise.
    if (argv.some((a) => a === "__complete" || a === "__completeNoDesc")) {
      const { initCompleteCmd } = await import("./completion.ts");
      initCompleteCmd(this, argv);
    }

    // Lazy commands are loaded only when the arguments actually select them.
    for (const c of this.lazyPath(argv)) await c.materialize();
    if (this.children.length > 0 && argv.length > 0) {
      const words = this.stripFlags(argv);
      if (words[0] === HELP_COMMAND_NAME) {
        for (const c of this.lazyPath(words.slice(1))) await c.materialize();
      }
    }

    const found = this.find(argv);
    if (found.err) {
      const c = found.cmd;
      if (!c.silenceErrors) {
        c.printErr(`Error: ${found.err.message}\n`);
        c.printErr(`Run '${c.commandPath()} --help' for usage.\n`);
      }
      return { cmd: c, err: found.err };
    }

    const cmd = found.cmd;
    try {
      await cmd.execute(found.args);
    } catch (e) {
      if (e instanceof HelpRequested) {
        cmd.helpFuncResolved()(cmd, argv);
        return { cmd, err: undefined };
      }
      const err = e instanceof Error ? e : new Error(String(e));
      if (err instanceof SilentExit) return { cmd, err };
      if (!cmd.silenceErrors && !this.silenceErrors) cmd.printErr(`Error: ${err.message}\n`);
      if (!cmd.silenceUsage && !this.silenceUsage) cmd.print(`${cmd.usageString()}\n`);
      return { cmd, err };
    }
    return { cmd, err: undefined };
  }

  /** Replaces a lazy placeholder with the command its loader builds. */
  async materialize(): Promise<void> {
    const load = this.loader;
    if (!load) return;
    const parent = this.parentCmd;
    const real = await load();
    this.loader = undefined;
    if (parent) parent.replaceCommand(this, real);
  }

  private async execute(a: string[]): Promise<void> {
    if (this.deprecated.length > 0) {
      this.print(`Command ${goQuote(this.name())} is deprecated, ${this.deprecated}\n`);
    }
    this.initDefaultHelpFlag();
    this.initDefaultVersionFlag();

    try {
      this.parseFlags(a);
    } catch (e) {
      if (e instanceof FlagError) {
        throw this.flagErrorFunc ? this.flagErrorFunc(this, e) : e;
      }
      throw e;
    }

    if (this.getBool("help")) throw new HelpRequested();

    if (this.version !== "" && this.getBool("version")) {
      this.stdout(`${this.displayName()} version ${this.version}\n`);
      return;
    }

    if (!this.runnable()) throw new HelpRequested();

    const argsWoFlags = this.disableFlagParsing ? a : this.flags().args();
    const validate = this.args?.(this, argsWoFlags);
    if (validate !== undefined) throw new Error(validate);

    for (let p: Command | undefined = this; p; p = p.parentCmd) {
      if (p.persistentPreRun) {
        await p.persistentPreRun(this, argsWoFlags);
        break;
      }
    }
    if (this.preRun) await this.preRun(this, argsWoFlags);

    this.validateRequiredFlags();
    this.validateFlagGroups();

    if (this.run) await this.run(this, argsWoFlags);
    if (this.postRun) await this.postRun(this, argsWoFlags);
    for (let p: Command | undefined = this; p; p = p.parentCmd) {
      if (p.persistentPostRun) {
        await p.persistentPostRun(this, argsWoFlags);
        break;
      }
    }
  }

  /** cobra ValidateFlagGroups; messages and ordering (groups sorted by key) match. */
  private validateFlagGroups(): void {
    if (this.disableFlagParsing) return;
    const fs = this.flags();
    const status = (groups: string[][] | undefined): Array<[string, Array<[string, boolean]>]> => {
      const out = new Map<string, Array<[string, boolean]>>();
      for (const names of groups ?? []) {
        if (!names.every((n) => fs.lookup(n))) continue;
        out.set(
          names.join(" "),
          names.map((n) => [n, fs.changed(n)]),
        );
      }
      return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    };
    const list = (xs: string[]): string => `[${xs.join(" ")}]`;
    const sortStr = (xs: string[]): string[] =>
      [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const [key, flags] of status(this.flagGroups.requiredTogether)) {
      const unset = flags.filter(([, set]) => !set).map(([n]) => n);
      if (unset.length === flags.length || unset.length === 0) continue;
      throw new Error(
        `if any flags in the group [${key}] are set they must all be set; missing ${list(sortStr(unset))}`,
      );
    }
    for (const [key, flags] of status(this.flagGroups.oneRequired)) {
      if (flags.some(([, set]) => set)) continue;
      throw new Error(`at least one of the flags in the group [${key}] is required`);
    }
    for (const [key, flags] of status(this.flagGroups.mutuallyExclusive)) {
      const set = flags.filter(([, on]) => on).map(([n]) => n);
      if (set.length <= 1) continue;
      throw new Error(
        `if any flags in the group [${key}] are set none of the others can be; ${list(sortStr(set))} were all set`,
      );
    }
  }

  private validateRequiredFlags(): void {
    if (this.disableFlagParsing) return;
    const missing: string[] = [];
    this.flags().visitAll((f) => {
      if (f.annotations.cobra_bash_completion_one_required_flag?.[0] === "true" && !f.changed) {
        missing.push(f.name);
      }
    });
    if (missing.length > 0) {
      throw new Error(`required flag(s) "${missing.join('", "')}" not set`);
    }
  }
}
