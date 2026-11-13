/**
 * The registration API: how a command subtask describes a command without touching core.
 *
 *   export default defineCommand({
 *     use: "list",
 *     short: "List things",
 *     flags: [{ type: "int", name: "limit", usage: "Maximum number", default: 50 }],
 *     async run(ctx) { return await loadThings(ctx.flags.int("limit")); },   // the result
 *     render: { styled: (r) => ..., plain: (r) => ..., json: (r) => r },     // one per mode
 *   });
 *
 * See README.md ("CLI framework") for the full contract, including lazy loading and the
 * root-help manifest.
 */
import type { PositionalArgs } from "./args.ts";
import { Command, type FlagGroups, HELP_GROUP_ANNOTATION } from "./command.ts";
import type { FlagType } from "./flags.ts";
import { getStore, isJSON, isPlain, type OutputMode, outputMode, printJSON } from "./helpers.ts";
import { printContent, printPaged } from "./pager.ts";

/** One flag. `persistent` flags are inherited by every subcommand (shown under "Global options"). */
export interface FlagSpec {
  type: FlagType;
  /** Long name without dashes. */
  name: string;
  /** One-character shorthand, if any. */
  shorthand?: string;
  /** Usage text. A back-quoted word names the value in help: "Read from `file`". */
  usage: string;
  /** Default: boolean, string, number (duration: nanoseconds), string[] or number[] by type. */
  default?: unknown;
  hidden?: boolean;
  /** Value used when the flag is given without one (`--color` meaning `--color=auto`). */
  noOptDefVal?: string;
  /** Marks the flag deprecated; the message is shown in help and printed on use. */
  deprecated?: string;
  /** Fail with cobra's `required flag(s) ... not set` when absent. */
  required?: boolean;
  persistent?: boolean;
}

/** Typed access to parsed flags. Throws on an undeclared flag or the wrong type (a programming error). */
export interface FlagReader {
  bool(name: string): boolean;
  string(name: string): string;
  int(name: string): number;
  float(name: string): number;
  /** stringArray and stringSlice flags. */
  strings(name: string): string[];
  ints(name: string): number[];
  /** Whether the flag was given explicitly. */
  changed(name: string): boolean;
}

/** What a handler receives. */
export interface CommandContext {
  readonly cmd: Command;
  /** Positional arguments (flags removed). */
  readonly args: string[];
  /** The output mode the global flags select: --json, else --plain, else styled. */
  readonly mode: OutputMode;
  readonly plain: boolean;
  readonly json: boolean;
  readonly flags: FlagReader;
  /** The run's environment and working directory (process.env / process.cwd() in the binary). */
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** Writes to stdout exactly as given. */
  print(text: string): void;
  /** Writes to stderr exactly as given. */
  printErr(text: string): void;
  /** stdout, honoring --page/--page-size (the PAGE footer is added only when a page is requested). */
  printPaged(text: string): void;
  /** Indented JSON (Go's json.MarshalIndent text) plus a newline. */
  printJSON(value: unknown): void;
  /** The project Store; on failure prints Go's diagnostic and exits 1. */
  getStore(): ReturnType<typeof getStore>;
}

/** Per-mode renderers for a handler's result. Each returns the full text to print. */
export interface Renderers<R> {
  styled?: (result: R, ctx: CommandContext) => string;
  /** Falls back to `styled` (styling is already stripped in plain mode). Paged with --page. */
  plain?: (result: R, ctx: CommandContext) => string;
  /** Falls back to the result itself. */
  json?: (result: R, ctx: CommandContext) => unknown;
}

export interface CommandSpecOf<R> {
  /** cobra `Use`: the name, then argument placeholders ("get <id>"). */
  use: string;
  /** One line, shown in command lists and as the help title. */
  short: string;
  long?: string;
  /** Worked examples; `#` lines are dimmed in help. */
  example?: string;
  aliases?: string[];
  hidden?: boolean;
  /** Marks the command deprecated; it is hidden and announces itself when run. */
  deprecated?: string;
  /**
   * Title of the root-help group, for a root-level command that is not in the group table
   * (core/helpgroups.ts). Ignored for commands the table already places.
   */
  helpGroup?: string;
  flags?: FlagSpec[];
  /** Positional-argument validator (core/args.ts), e.g. exactArgs(1). */
  args?: PositionalArgs;
  silenceUsage?: boolean;
  silenceErrors?: boolean;
  /** Flag groups: `mutuallyExclusive: [["latest", "version"]]` (cobra MarkFlagsMutuallyExclusive). */
  flagGroups?: FlagGroups;
  /** Pass every argument through unparsed (including --help). */
  disableFlagParsing?: boolean;
  /** Wraps a flag parse error before it is reported (cobra SetFlagErrorFunc). */
  flagError?: (cmd: Command, err: Error) => Error;
  /** Runs before this command's `run` and those of its subcommands (the nearest one wins). */
  persistentPreRun?: (ctx: CommandContext) => void | Promise<void>;
  /**
   * The handler. Throw to fail: any Error exits 1 with `Error: <message>` (and usage, unless
   * `silenceUsage`); throw `exitError(code, cause)` for another exit code. Return a value and
   * give `render` to let the framework print it per output mode, or print yourself via ctx.
   */
  run?: (ctx: CommandContext) => R | Promise<R>;
  render?: Renderers<R>;
  subcommands?: CommandSpec[];
}

/** A command definition with its result type erased, as the registry stores it. */
export type CommandSpec = CommandSpecOf<unknown>;

/** Identity function that type-checks a definition and erases its result type. */
export function defineCommand<R = void>(spec: CommandSpecOf<R>): CommandSpec {
  return spec as unknown as CommandSpec;
}

function reader(cmd: Command): FlagReader {
  return {
    bool: (n) => cmd.getBool(n),
    string: (n) => cmd.getString(n),
    int: (n) => cmd.getInt(n),
    float: (n) => cmd.getFloat(n),
    strings: (n) => cmd.getStrings(n),
    ints: (n) => cmd.getInts(n),
    changed: (n) => cmd.changed(n),
  };
}

export function makeContext(cmd: Command, args: string[]): CommandContext {
  return {
    cmd,
    args,
    mode: outputMode(cmd),
    plain: isPlain(cmd),
    json: isJSON(cmd),
    flags: reader(cmd),
    env: cmd.env(),
    cwd: cmd.cwd(),
    print: (t) => cmd.stdout(t),
    printErr: (t) => cmd.printErr(t),
    printPaged: (t) => printPaged(cmd, t),
    printJSON: (v) => printJSON(cmd, v),
    getStore: () => getStore(cmd),
  };
}

function emit(spec: CommandSpec, result: unknown, ctx: CommandContext): void {
  const render = spec.render;
  if (!render) return;
  if (ctx.mode === "json") {
    ctx.printJSON(render.json ? render.json(result, ctx) : result);
    return;
  }
  if (ctx.mode === "plain") {
    const fn = render.plain ?? render.styled;
    if (fn) ctx.printPaged(fn(result, ctx));
    return;
  }
  if (render.styled) printContent(ctx.cmd, render.styled(result, ctx));
}

const REQUIRED_ANNOTATION = "cobra_bash_completion_one_required_flag";

/** Builds the live command (and its subtree) from a definition. */
export function buildCommand(spec: CommandSpec): Command {
  const cmd = new Command({
    use: spec.use,
    short: spec.short,
    ...(spec.long !== undefined && { long: spec.long }),
    ...(spec.example !== undefined && { example: spec.example }),
    ...(spec.aliases !== undefined && { aliases: spec.aliases }),
    hidden: spec.hidden ?? false,
    ...(spec.deprecated !== undefined && { deprecated: spec.deprecated }),
    ...(spec.args !== undefined && { args: spec.args }),
    silenceUsage: spec.silenceUsage ?? false,
    silenceErrors: spec.silenceErrors ?? false,
    disableFlagParsing: spec.disableFlagParsing ?? false,
    ...(spec.flagError !== undefined && { flagErrorFunc: spec.flagError }),
  });
  if (spec.flagGroups) cmd.flagGroups = spec.flagGroups;
  if (spec.helpGroup !== undefined) cmd.annotations[HELP_GROUP_ANNOTATION] = spec.helpGroup;

  for (const f of spec.flags ?? []) {
    const set = f.persistent ? cmd.persistentFlags() : cmd.flags();
    const flag = set.define(f.type, f.name, f.shorthand ?? "", f.usage, f.default);
    if (f.hidden) flag.hidden = true;
    if (f.noOptDefVal !== undefined) flag.noOptDefVal = f.noOptDefVal;
    if (f.deprecated !== undefined) flag.deprecated = f.deprecated;
    if (f.required) flag.annotations[REQUIRED_ANNOTATION] = ["true"];
  }

  const run = spec.run;
  if (run) {
    cmd.run = async (c, args) => {
      const ctx = makeContext(c, args);
      const result = await run(ctx);
      if (result !== undefined) emit(spec, result, ctx);
    };
  }
  const pre = spec.persistentPreRun;
  if (pre) cmd.persistentPreRun = (c, args) => pre(makeContext(c, args));

  for (const sub of spec.subcommands ?? []) cmd.addCommand(buildCommand(sub));
  return cmd;
}
