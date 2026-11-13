/**
 * The root command and the run loop (root.go): global flags, the banner, update notice,
 * unmigrated-config warning, and the honest placeholder for commands that are not ported yet.
 */

import { goGetwd } from "../../storage/core/getwd.ts";
import { VERSION } from "../../version.ts";
import { buildCompletionCommand } from "../commands/completion.ts";
import { type CommandLoader, commandLoaders } from "../commands/index.ts";
import { Command, type CommandInit } from "./command.ts";
import { buildCommand, type CommandSpec } from "./define.ts";
import { exitCode, SilentExit } from "./exit.ts";
import { customHelpFunc } from "./help.ts";
import { type ManifestEntry, ROOT_MANIFEST } from "./help-manifest.generated.ts";
import { isJSON, isPlain } from "./helpers.ts";
import { HELP_GROUPS } from "./helpgroups.ts";
import { runtimeHooks } from "./hooks.ts";
import { type IO, stdIO } from "./io.ts";
import {
  noColorRequested,
  renderCmd,
  StyleBold,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
  setPlainOutput,
} from "./plainoutput.ts";
import { REMOVED_COMMAND_SHORT } from "./removed.ts";

export const ROOT_SHORT = "The memory layer for AI-native software development";

const BANNER_LINES = [
  "▄▄▄   ▄▄▄ ▄▄▄    ▄▄▄   ▄▄▄▄▄   ▄▄▄▄  ▄▄▄  ▄▄▄▄ ▄▄▄    ▄▄▄  ▄▄▄▄▄▄▄",
  "███ ▄███▀ ████▄  ███ ▄███████▄ ▀███  ███  ███▀ ████▄  ███ █████▀▀▀",
  "███████   ███▀██▄███ ███   ███  ███  ███  ███  ███▀██▄███  ▀████▄",
  "███▀███▄  ███  ▀████ ███▄▄▄███  ███▄▄███▄▄███  ███  ▀████    ▀████",
  "███  ▀███ ███    ███  ▀█████▀    ▀████▀████▀   ███    ███ ███████▀",
];

function printBanner(cmd: Command): void {
  const rows: Array<[string, string]> = [
    ["knowns init", "Initialize project"],
    ["knowns quickstart", "Learn the short path to a finished task"],
    ["knowns task list", "List all tasks"],
    ["knowns --help", "Show all commands"],
  ];
  let out = "\n";
  for (const line of BANNER_LINES) out += `${StyleInfo.render(line)}\n`;
  out += "\n";
  out += `  ${StyleBold.render("Knowns")} ${StyleSuccess.render(VERSION)}\n`;
  out += "  The memory layer for AI-native software development.\n";
  out += "  Enabling AI to understand your project instantly.\n";
  out += "\n";
  out += `${StyleBold.render("  Quick Start:")}\n`;
  for (const [c, d] of rows) {
    out += `    ${StyleInfo.render(c)}${" ".repeat("knowns quickstart".length - c.length + 2)}${d}\n`;
  }
  out += "\n";
  out += `  ${StyleBold.render("Homepage: ")}  ${StyleInfo.render("https://knowns.sh")}\n`;
  out += `  ${StyleBold.render("Documents:")}  ${StyleInfo.render("https://knowns.sh/docs")}\n`;
  out += `  ${StyleBold.render("Discord:  ")}  ${StyleInfo.render("https://discord.knowns.dev")}\n`;
  out += "\n";
  cmd.stdout(out);
}

/**
 * A command that exists in 0.34.1 but is not ported yet. It is listed (so root help is
 * complete) and fails with a plain explanation; it never pretends to work. Flag parsing is off
 * so the message appears whatever arguments were given.
 */
function unportedCommand(entry: ManifestEntry): Command {
  const init: CommandInit = {
    use: entry.name,
    short: entry.short,
    hidden: entry.hidden,
    disableFlagParsing: true,
    silenceUsage: true,
    run: (cmd) => {
      throw new Error(
        `"${cmd.commandPath()}" is not available in the TypeScript build yet (the command has not been ported)`,
      );
    },
  };
  return new Command(init);
}

/** A placeholder that becomes the real command the first time the arguments select it. */
function lazyCommand(
  name: string,
  short: string,
  hidden: boolean,
  loader: CommandLoader,
  helpGroup?: string,
): Command {
  const cmd = new Command({
    use: name,
    short,
    hidden,
    // Runnable so it is listed; never runs, because it is replaced before dispatch.
    run: () => undefined,
    loader: async () => {
      // Seam implementations (search runtime, reconciler) load with the first real command, so
      // --version, help and unknown-command errors never import them.
      const { installWiring } = await import("../../wiring/index.ts");
      await installWiring();
      const spec = (await loader.load()).default;
      return buildCommand(spec);
    },
  });
  if (helpGroup) cmd.annotations["knowns.helpGroup"] = helpGroup;
  return cmd;
}

export interface RootOptions {
  /** Loaders for ported commands; defaults to commands/index.ts. */
  loaders?: Record<string, CommandLoader>;
  /** Eagerly built commands added to the root (tests, embedding). */
  extra?: CommandSpec[];
  /** The 0.34.1 command set; defaults to the generated manifest. */
  manifest?: readonly ManifestEntry[];
  version?: string;
  /** Environment for NO_COLOR; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

function withRemovedCommands(manifest: readonly ManifestEntry[]): ManifestEntry[] {
  return manifest.map((e) => {
    const short = REMOVED_COMMAND_SHORT[e.name];
    return short === undefined ? e : { ...e, short };
  });
}

/** Builds the root command: global flags, help, and every root command. */
export function createRoot(opts: RootOptions = {}): Command {
  const version = opts.version ?? VERSION;
  const loaders = opts.loaders ?? commandLoaders;
  const manifest = withRemovedCommands(opts.manifest ?? ROOT_MANIFEST);

  const root = new Command({
    use: "knowns [options] [command]",
    short: ROOT_SHORT,
    version,
    run: (cmd) => printBanner(cmd),
    // --plain and --json are global, so honoring them happens once, before any command renders.
    // NO_COLOR rides along for the same reason.
    persistentPreRun: (cmd) => {
      setPlainOutput(isPlain(cmd) || isJSON(cmd) || noColorRequested(cmd.env()));
    },
  });
  root.helpFunc = customHelpFunc(version);

  const pf = root.persistentFlags();
  pf.define("bool", "plain", "", "Plain text output (for AI agents)", false);
  pf.define("bool", "json", "", "JSON output", false);
  // The pager it disabled is gone; the flag stays registered and hidden so a script that still
  // passes it keeps working instead of failing on an unknown flag.
  const noPager = pf.define(
    "bool",
    "no-pager",
    "",
    "No effect; output is always printed directly",
    false,
  );
  noPager.hidden = true;
  pf.define("int", "page", "", "Page number for paginated output (e.g. --page 2)", 0);
  pf.define("int", "page-size", "", "Lines per page (default 50)", 0);

  const seen = new Set<string>();
  for (const entry of manifest) {
    seen.add(entry.name);
    const loader = loaders[entry.name];
    root.addCommand(
      loader ? lazyCommand(entry.name, entry.short, entry.hidden, loader) : unportedCommand(entry),
    );
  }
  // TS-only root commands (not in 0.34.1) come from their loaders.
  for (const [name, loader] of Object.entries(loaders)) {
    if (seen.has(name)) continue;
    root.addCommand(
      lazyCommand(name, loader.short ?? "", loader.hidden ?? false, loader, loader.helpGroup),
    );
  }
  for (const spec of opts.extra ?? []) {
    const built = buildCommand(spec);
    const existing = root.commands().find((c) => c.name() === built.name());
    if (existing) root.replaceCommand(existing, built);
    else root.addCommand(built);
  }

  // cobra adds its own `completion` command (the scripts load only when one is requested).
  root.addCommand(buildCompletionCommand(root.name()));
  return root;
}

// --- run loop (Execute) ------------------------------------------------------------------------

const SKIP_WARNINGS = [
  "doctor",
  "runtime",
  "runtime-memory",
  "qdrant",
  "__runtime",
  "__lsp-daemon",
  "migrate",
];

export function shouldSkipCLIWarnings(args: string[]): boolean {
  return SKIP_WARNINGS.some((n) => args.includes(n));
}

/** Go util.ShouldCheckForUpdate. */
export function shouldCheckForUpdate(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NO_UPDATE_CHECK === "1") return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  return !args.some((a) => a === "--plain" || a === "--json" || a === "update");
}

/**
 * One-line notice naming `knowns migrate` when the project config carries an older schema
 * version. It says only that a migration is pending; the remediation belongs to `knowns migrate`.
 */
async function maybeWarnUnmigratedConfig(io: IO, cwd: string): Promise<void> {
  try {
    const { locateProjectAt } = await import("../../storage/core/index.ts");
    const { ConfigStore } = await import("../../storage/stores/config-store.ts");
    const { needsMigration } = await import("../../storage/stores/migrations.ts");
    const loc = locateProjectAt(cwd);
    const project = new ConfigStore(loc.knowledgeRoot, loc.projectRoot).load();
    if (!needsMigration(project)) return;
    io.err.write(
      `${StyleWarning.render(`⚠ This project's config needs migrating. Run ${renderCmd("knowns migrate")}.`)}\n`,
    );
  } catch {
    // No project here, or an unreadable config: the command itself reports that, if it matters.
  }
}

export interface RunOptions extends RootOptions {
  io?: IO;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Overrides runtimeHooks.checkForUpdate. */
  checkForUpdate?: () => Promise<string>;
  updateTimeoutMs?: number;
  /** Skip the unmigrated-config check (tests that must not touch the project registry). */
  skipConfigWarning?: boolean;
}

/** Runs the CLI and resolves to the process exit code. Never calls process.exit. */
export async function execute(argv: string[], opts: RunOptions = {}): Promise<number> {
  const io = opts.io ?? stdIO();
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? goGetwd(env);
  // NO_COLOR applies before anything can render, --help included.
  setPlainOutput(noColorRequested(env));

  const root = createRoot({ ...opts, env });
  const runRoot = async (): Promise<Error | undefined> =>
    (await root.executeC(argv, io, { env, cwd })).err;

  let err: Error | undefined;
  if (!shouldSkipCLIWarnings(argv) && !opts.skipConfigWarning) {
    await maybeWarnUnmigratedConfig(io, cwd);
  }
  const check = opts.checkForUpdate ?? runtimeHooks.checkForUpdate;
  if (!check || !shouldCheckForUpdate(argv, env)) {
    err = await runRoot();
  } else {
    const pending = check().catch(() => "");
    err = await runRoot();
    if (!err) {
      const timeoutMs = opts.updateTimeoutMs ?? 3000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const msg = await Promise.race([
        pending,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(""), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (msg !== "") io.err.write(msg);
    }
  }
  if (err instanceof SilentExit) return err.code;
  return exitCode(err);
}

/** The groups cobra-style help prints, exposed for tests and docs generation. */
export const ROOT_HELP_GROUP_TITLES = HELP_GROUPS.map((g) => g.title);
