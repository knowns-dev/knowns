// `knowns sync` (internal/cli/sync.go): apply .knowns/config.json to the local machine.
import { userHomeDir } from "../../domain/setup/env.ts";
import { writeKnownsGitignore } from "../../domain/setup/gitignore.ts";
import {
  resolveSyncPlatformSelection,
  resolveSyncPlatformTargets,
} from "../../domain/setup/sync-platforms.ts";
import { defineCommand } from "../core/define.ts";
import { getStoreErr } from "../core/helpers.ts";
import { renderField, renderInfo, renderSuccess, StyleBold } from "../core/plainoutput.ts";
import {
  type Out,
  resolveSkillsScope,
  runSyncInstructions,
  runSyncMcpConfigs,
  runSyncModel,
  runSyncPlatformConfigs,
  runSyncReindex,
  runSyncRuntimeHooks,
  runSyncSkillsForScope,
} from "./sync-support.ts";

export default defineCommand({
  use: "sync",
  short: "Sync project from config.json (skills, instructions, model, search index)",
  long: `Apply project configuration from .knowns/config.json.

This is the recommended command after cloning a repo with Knowns:
  git clone <repo>
  knowns sync

It reads config.json and sets up everything locally:
  • Skills — copies built-in skills to platform directories
  • Instructions — generates agent instruction files (CLAUDE.md, AGENTS.md, etc.)
  • Runtime hooks — installs current memory hooks for configured runtimes
  • Model — downloads the configured embedding model (if not installed)
  • Search index — rebuilds the semantic search index
  • Git integration — applies .gitignore rules for the configured tracking mode

Use flags to sync only specific parts.`,
  flags: [
    {
      type: "bool",
      name: "force",
      usage: "Force resync (overwrite existing files) [deprecated: sync always overwrites]",
      default: false,
    },
    { type: "bool", name: "skills", usage: "Sync skills only", default: false },
    { type: "bool", name: "instructions", usage: "Sync instruction files only", default: false },
    { type: "bool", name: "model", usage: "Download embedding model only", default: false },
    {
      type: "string",
      name: "platform",
      usage:
        "Sync specific platform (claude, opencode, codex, kiro, antigravity, cursor, gemini, copilot, agents, all)",
      default: "",
    },
  ],
  async run(ctx) {
    const store = await getStoreErr(ctx.cmd);
    const out: Out = { print: (t) => ctx.print(t), printErr: (t) => ctx.printErr(t) };

    const skillsOnly = ctx.flags.bool("skills");
    const instructionsOnly = ctx.flags.bool("instructions");
    const modelOnly = ctx.flags.bool("model");
    const platform = ctx.flags.string("platform");

    const specificFlag = skillsOnly || instructionsOnly || modelOnly;
    const doSkills = !specificFlag || skillsOnly;
    const doInstructions = !specificFlag || instructionsOnly;
    const doModel = !specificFlag || modelOnly;
    const doIndex = !specificFlag;

    const { createStorage } = await import("../../storage/adapters.ts");
    const storage = createStorage(store);
    let cfg: ReturnType<typeof storage.config.load>;
    try {
      cfg = storage.config.load();
    } catch (e) {
      throw new Error(`load config: ${(e as Error).message}`);
    }

    const projectRoot = store.projectRoot;
    const selected = resolveSyncPlatformSelection(platform, cfg.settings.platforms ?? []);

    ctx.print(
      `${renderInfo(`Syncing project ${StyleBold.render(cfg.name)} from config.json...`)}\n\n`,
    );

    const wrap = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        throw new Error(`${what}: ${(e as Error).message}`);
      }
    };

    if (doSkills) {
      let home = "";
      try {
        home = userHomeDir(ctx.env);
      } catch {
        home = "";
      }
      wrap("sync skills", () =>
        runSyncSkillsForScope(
          out,
          projectRoot,
          selected,
          resolveSkillsScope(cfg.settings.skillsScope, home),
          ctx.env,
        ),
      );
      ctx.print("\n");
    }

    if (doInstructions) {
      const effective = platform.trim().toLowerCase() === "all" ? "" : platform;
      wrap("sync instructions", () => runSyncInstructions(out, projectRoot, effective, selected));
      let targets: string[] = [];
      wrap("resolve platform configs", () => {
        targets = resolveSyncPlatformTargets(effective, selected);
      });
      wrap("sync platform configs", () =>
        runSyncPlatformConfigs(out, projectRoot, targets, ctx.env),
      );
      ctx.print("\n");
    }

    if (!specificFlag) {
      const mode = cfg.settings.gitTrackingMode ?? "";
      if (mode !== "") {
        ctx.print(`${renderField("Git tracking mode", StyleBold.render(mode))}\n`);
        try {
          writeKnownsGitignore(projectRoot, mode, cfg.settings.gitTracking);
          ctx.print(`${renderSuccess("Git integration configured.")}\n`);
        } catch (e) {
          ctx.printErr(`Warning: git integration failed: ${(e as Error).message}\n`);
        }
        ctx.print("\n");
      }
    }

    if (doModel) {
      let home = "";
      try {
        home = userHomeDir(ctx.env);
      } catch {
        home = "";
      }
      await runSyncModel(out, cfg.settings.semanticSearch, home);
    }

    if (doIndex) {
      ctx.print(`${StyleBold.render("Rebuilding search index...")}\n`);
      try {
        const count = (fn: () => unknown[]): number => {
          try {
            return fn().length;
          } catch {
            return 0;
          }
        };
        await runSyncReindex(out, {
          counts: {
            tasks: count(() => storage.tasks.listAll()),
            docs: count(() => storage.docs.list()),
            decisions: count(() => storage.decisions.list()),
          },
          semantic: cfg.settings.semanticSearch,
          env: ctx.env,
          storeRoot: store.root,
        });
      } catch (e) {
        ctx.printErr(`Warning: reindex failed: ${(e as Error).message}\n`);
      }
      ctx.print("\n");
    }

    if (!specificFlag) {
      try {
        runSyncMcpConfigs(out, ctx.cwd, ctx.env);
      } catch (e) {
        ctx.printErr(`Warning: MCP config sync failed: ${(e as Error).message}\n`);
      }
      try {
        runSyncRuntimeHooks(out, selected, ctx.env, ctx.cwd);
      } catch (e) {
        ctx.printErr(`Warning: runtime hooks sync failed: ${(e as Error).message}\n`);
      }
    }

    ctx.print(`${renderSuccess("Sync complete.")}\n`);
  },
});
