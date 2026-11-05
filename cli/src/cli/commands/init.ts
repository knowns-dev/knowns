// `knowns init` (internal/cli/init.go), flag-driven path. When Go would start the interactive
// huh wizard (no --no-wizard and no [name]) this build reports the same error Go gives without a
// terminal; see wizardUnavailable. Language servers are detected and recorded in config.json but
// not downloaded (the LSP installer is not ported).
import { statSync } from "node:fs";
import { join } from "node:path";
import { lookPath, userHomeDir } from "../../domain/setup/env.ts";
import { writeKnownsGitignore } from "../../domain/setup/gitignore.ts";
import {
  buildSemanticSettings,
  type GlobalProjectDefaults,
  lifecycleSeedForInit,
  resolveNonInteractiveInit,
} from "../../domain/setup/init-config.ts";
import { createInstructionFilesForPlatforms } from "../../domain/setup/instruction-files.ts";
import { recordDetectedLanguages } from "../../domain/setup/lsp-config.ts";
import { gitTrackingDefaults, type Project } from "../../models/config.ts";
import { normalizeTaskIdPrefix } from "../../models/id.ts";
import { createStorage } from "../../storage/adapters.ts";
import { Store } from "../../storage/core/index.ts";
import { OLLAMA_GUIDANCE_DOCS_URL } from "../../storage/stores/embedding-registry-defaults.ts";
import { EmbeddingSettingsStore } from "../../storage/stores/embedding-settings-store.ts";
import { maximumNArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import { terminalWidth } from "../core/markdown.ts";
import { isTTY } from "../core/pager.ts";
import { renderField, StyleDim, StyleTitle, StyleWarning } from "../core/plainoutput.ts";
import { type InitStep, runInitSteps } from "./init-steps.ts";
import { isGitRepo, printSetupSuggestion, wizardUnavailable } from "./init-support.ts";

const WIZARD_MIN_WIDTH = 60;

export default defineCommand({
  use: "init [name]",
  short: "Initialize a new Knowns project",
  long: `Initialize a new Knowns project in the current directory.
Creates a .knowns/ directory with the required structure and a default config.json.`,
  args: maximumNArgs(1),
  flags: [
    {
      type: "string",
      name: "task-prefix",
      usage: "Default task ID prefix (2-8 alphanumeric characters, e.g. KN)",
      default: "",
    },
    { type: "bool", name: "git-tracked", usage: "Track .knowns/ files in git", default: false },
    { type: "bool", name: "git-ignored", usage: "Add .knowns/ to .gitignore", default: false },
    { type: "bool", name: "wizard", usage: "Run interactive setup wizard", default: false },
    {
      type: "bool",
      name: "no-wizard",
      usage: "Skip interactive prompts, use defaults",
      default: false,
    },
    {
      type: "bool",
      shorthand: "f",
      name: "force",
      usage: "Force reinitialize even if already initialized",
      default: false,
    },
    {
      type: "bool",
      name: "open",
      usage: "Launch the web UI immediately after init",
      default: false,
    },
    {
      type: "bool",
      name: "no-open",
      usage: "Skip the web UI launch prompt after init",
      default: false,
    },
  ],
  async run(ctx) {
    const gitTracked = ctx.flags.bool("git-tracked");
    const gitIgnored = ctx.flags.bool("git-ignored");
    const force = ctx.flags.bool("force");
    const noWizard = ctx.flags.bool("no-wizard");
    const openFlag = ctx.flags.bool("open");
    const noOpen = ctx.flags.bool("no-open");

    const taskPrefixFlag = normalizeTaskIdPrefix(ctx.flags.string("task-prefix"));

    const cwd = ctx.cwd;
    const root = join(cwd, ".knowns");
    const hasGitRepo = isGitRepo(cwd);
    const hasGit = lookPath("git", ctx.env) !== undefined;

    const openStorage = () => createStorage(Store.open(root));

    // Already initialized?
    let exists = false;
    try {
      statSync(root);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      if (!force) {
        if (gitTracked || gitIgnored) {
          const mode = gitIgnored ? "git-ignored" : "git-tracked";
          const { config } = openStorage();
          const project = config.load();
          project.settings.gitTrackingMode = mode;
          project.settings.gitTracking = gitTrackingDefaults();
          config.save(project);
          writeKnownsGitignore(cwd, mode, undefined);
          ctx.print(`✓ Git tracking mode updated to ${goQuote(mode)}\n`);
          return;
        }
        ctx.print(
          `${StyleWarning.render("Project already initialized (.knowns/ directory exists).")}\n`,
        );
        ctx.print(`${StyleDim.render("  Use --force to reinitialize.")}\n`);
        ctx.print(
          `${StyleDim.render("  Use --git-tracked or --git-ignored to change tracking mode.")}\n`,
        );
        return;
      }
      ctx.print(`${StyleWarning.render("Reinitializing existing project (--force)")}\n`);
      ctx.print("\n");
    }

    if (!hasGitRepo) {
      if (hasGit) {
        ctx.print(
          `${StyleDim.render("No git repository found — Knowns will run git init after setup.")}\n`,
        );
        ctx.print("\n");
      } else {
        ctx.print(
          `${StyleWarning.render("Warning: No git repository found and git is not available in PATH.")}\n`,
        );
        ctx.print(
          `${StyleDim.render("  Install git to enable repository setup and git-aware tracking.")}\n`,
        );
        ctx.print("\n");
      }
    }

    // Global defaults (~/.knowns/settings.json projectDefaults).
    let globalDefaults: GlobalProjectDefaults | undefined;
    try {
      const settingsPath = join(userHomeDir(ctx.env), ".knowns", "settings.json");
      globalDefaults = new EmbeddingSettingsStore(settingsPath).load().projectDefaults;
    } catch (e) {
      ctx.printErr(`Warning: failed to load global settings: ${(e as Error).message}\n`);
    }

    let existing: Project | undefined;
    if (force) {
      try {
        existing = openStorage().config.load();
      } catch {
        existing = undefined;
      }
    }
    const taskLifecycleSeed = lifecycleSeedForInit(existing, force, globalDefaults);

    // Go starts the wizard unless --no-wizard is given and no name is.
    const interactive = !noWizard;
    if (interactive && isTTY()) {
      const width = terminalWidth(ctx.env);
      if (width < WIZARD_MIN_WIDTH) {
        ctx.print(
          `${StyleWarning.render("Terminal is too small for the interactive setup wizard.")}\n\n`,
        );
        ctx.print(`${renderField("Minimum width", `${WIZARD_MIN_WIDTH} columns`)}\n`);
        ctx.print(`${renderField("Current width", `${width} columns`)}\n\n`);
        ctx.print(`${StyleDim.render("  Resize the terminal and rerun: knowns init")}\n`);
        ctx.print(
          `${StyleDim.render("  Or run explicitly without the wizard: knowns init --no-wizard")}\n`,
        );
        ctx.print(
          `${StyleDim.render("  Or pass explicit flags such as: knowns init --no-wizard --git-tracked")}\n`,
        );
        ctx.print("\n");
        return;
      }
    }
    if (interactive && ctx.args.length === 0) {
      ctx.print("\n");
      ctx.print(`${StyleTitle.render("🚀 Knowns Project Setup")}\n`);
      ctx.print(`${StyleDim.render("   Quick configuration")}\n`);
      ctx.print("\n");
      throw wizardUnavailable();
    }

    const cfg = resolveNonInteractiveInit({
      cwd,
      nameArg: ctx.args[0],
      gitTracked,
      gitIgnored,
      force,
      taskPrefixFlag,
      globalDefaults,
      existing,
      taskLifecycleSeed,
    });
    if (taskLifecycleSeed) cfg.taskLifecycle = taskLifecycleSeed;

    const steps: InitStep[] = [];
    if (!hasGitRepo && hasGit) {
      steps.push({
        label: "Initializing git repository",
        run: () => {
          const r = Bun.spawnSync(["git", "init"], {
            cwd,
            env: { ...process.env, ...ctx.env } as Record<string, string>,
          });
          if (r.exitCode !== 0) {
            const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
            throw new Error(
              out === "" ? "git init failed: exit status" : `git init failed: ${out}`,
            );
          }
        },
      });
    }
    steps.push(
      {
        label: "Creating project structure",
        run: () => {
          Store.open(root).init(cfg.name);
        },
      },
      {
        label: "Applying settings",
        run: () => {
          const { config } = openStorage();
          const project = config.load();
          const s = project.settings;
          if (cfg.gitTrackingMode !== "") s.gitTrackingMode = cfg.gitTrackingMode;
          if (cfg.gitTrackingMode !== "none") s.gitTracking = cfg.gitTracking;
          const semantic = buildSemanticSettings(cfg);
          if (semantic) s.semanticSearch = semantic;
          if (cfg.platforms.length > 0) s.platforms = cfg.platforms;
          if (cfg.taskIdPrefix === "") delete s.defaultTaskIdPrefix;
          else s.defaultTaskIdPrefix = cfg.taskIdPrefix;
          if (cfg.taskLifecycle) s.taskLifecycle = { ...cfg.taskLifecycle };
          config.save(project);
        },
      },
      {
        label: "Configuring git integration",
        run: () => writeKnownsGitignore(cwd, cfg.gitTrackingMode, cfg.gitTracking),
      },
      {
        label: "Creating project instruction files",
        run: () => createInstructionFilesForPlatforms(cwd, force, cfg.platforms),
      },
      {
        label: "Installing language servers",
        run: async () => {
          if (cwd === "" || (ctx.env.KNOWN_LSP_AUTO_INSTALL ?? "").trim() === "0") return;
          const detected = recordDetectedLanguages(cwd, openStorage().config);
          const { installDetectedServers } = await import("../../lsp/auto-install.ts");
          await installDetectedServers(cwd, detected, (t) => ctx.print(t));
        },
      },
    );

    ctx.print("\n");
    try {
      await runInitSteps(ctx, steps);
    } catch (e) {
      throw new Error(`init failed: ${(e as Error).message}`);
    }

    ctx.print("\n");
    ctx.print(`${StyleTitle.render("Get started:")}\n`);
    ctx.print(`${StyleDim.render('  knowns task create "My first task"')}\n`);
    printSetupSuggestion(ctx, cwd);
    ctx.print(`${StyleDim.render("  Use /kn-init to start an AI session")}\n`);

    ctx.print("\n");
    ctx.print(`${StyleTitle.render("Check setup:")}\n`);
    ctx.print(
      `${StyleDim.render("  knowns doctor             # Diagnose project and integration health")}\n`,
    );
    if (cfg.enableSemantic) {
      ctx.print(
        `${StyleDim.render("  knowns search --reindex   # Build semantic indices (skipped during init)")}\n`,
      );
    } else {
      ctx.print("\n");
      ctx.print(`${StyleTitle.render("Semantic search:")}\n`);
      ctx.print(`${StyleDim.render(`  ${cfg.semanticGuidance.description}`)}\n`);
      if (cfg.semanticGuidance.command !== "") {
        ctx.print(`${StyleDim.render(`  ${cfg.semanticGuidance.command}`)}\n`);
      }
      ctx.print(`${StyleDim.render(`  Read more: ${OLLAMA_GUIDANCE_DOCS_URL}`)}\n`);
    }
    ctx.print("\n");

    if (!noOpen && openFlag) {
      throw new Error(
        "--open is not available in the TypeScript build yet (the web server is not ported)",
      );
    }
  },
});
