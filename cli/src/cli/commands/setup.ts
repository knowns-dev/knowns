// `knowns setup [target]` (internal/cli/setup.go and setup_global.go): write the AI tool
// integrations (skills, MCP configs, runtime hooks, instruction files) for a project, or with
// --global at user level. Without a target the platforms are picked interactively.
import { statSync } from "node:fs";
import { join } from "node:path";
import { userHomeDir } from "../../domain/setup/env.ts";
import {
  setupGlobalClaudeCodeMcp,
  setupGlobalClaudeDesktopMcp,
  setupGlobalCodexMcp,
  setupGlobalCursorMcp,
  setupGlobalGeminiMcp,
  setupGlobalHermesMcp,
  setupGlobalKiroMcp,
  setupGlobalOpenCodeMcp,
  syncGlobalSkills,
  writeGlobalInstructionFile,
} from "../../domain/setup/global.ts";
import { createHermesMcpConfig } from "../../domain/setup/hermes.ts";
import {
  createInstructionFiles,
  createInstructionFilesForPlatforms,
} from "../../domain/setup/instruction-files.ts";
import {
  createAntigravityMcpConfig,
  createAntigravityRules,
  createCodexMcpConfig,
  createCursorMcpConfig,
  createKiroMcpConfig,
  createKiroSteering,
  createMcpJsonFile,
  createOpenCodeConfig,
} from "../../domain/setup/mcp-config.ts";
import { hasPlatform, platformsForSetupTarget } from "../../domain/setup/platforms.ts";
import * as runtimeinstall from "../../domain/setup/runtimeinstall.ts";
import { maximumNArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { StyleDim, StyleSuccess, StyleWarning } from "../core/plainoutput.ts";
import { type InitStep, runInitSteps } from "./init-steps.ts";

const TARGET_ERROR = (target: string): Error =>
  new Error(
    `unknown setup target ${JSON.stringify(target)} (expected: claude, opencode, hermes, copilot, kiro, codex, cursor, gemini, antigravity, agents, all)`,
  );

/** The runtime-hook steps both setup flavours share: only runtimes whose CLI is installed. */
function runtimeHookSteps(ctx: CommandContext, platforms: string[]): InitStep[] {
  const steps: InitStep[] = [];
  for (const rt of ["claude-code", "codex", "kiro", "opencode"]) {
    if (!hasPlatform(platforms, rt)) continue;
    const opts = runtimeinstall.defaultOptions(ctx.env, ctx.cwd);
    // Every runtime, OpenCode included, must already be installed: Knowns writes hooks for a CLI
    // the user provides, it does not install one.
    let available = false;
    try {
      available = runtimeinstall.statusFor(rt, opts).available;
    } catch {
      available = false;
    }
    if (!available) continue;
    steps.push({
      label: `Installing ${runtimeinstall.runtimePickerLabel(rt, opts)} runtime hooks`,
      run: () => runtimeinstall.install(rt, opts),
    });
  }
  return steps;
}

async function buildSetupSteps(
  ctx: CommandContext,
  cwd: string,
  force: boolean,
  target: string,
  platforms: string[],
): Promise<InitStep[]> {
  const { syncSkillsForPlatforms } = await import("../../domain/instructions/index.ts");
  const env = ctx.env;
  const steps: InitStep[] = [
    { label: "Syncing skills", run: () => syncSkillsForPlatforms(cwd, platforms) },
  ];
  const add = (label: string, run: () => void) => steps.push({ label, run });
  if (hasPlatform(platforms, "claude-code")) {
    add("Creating Claude MCP config", () => createMcpJsonFile(cwd, force, env));
  }
  if (hasPlatform(platforms, "opencode")) {
    add("Creating OpenCode config", () => createOpenCodeConfig(cwd, env));
  }
  if (hasPlatform(platforms, "kiro")) {
    add("Creating Kiro steering", () => createKiroSteering(cwd, force));
    add("Creating Kiro MCP config", () => createKiroMcpConfig(cwd, env));
  }
  if (hasPlatform(platforms, "codex")) {
    add("Creating Codex MCP config", () => createCodexMcpConfig(cwd, env));
  }
  if (hasPlatform(platforms, "hermes")) {
    add("Creating Hermes global MCP config", () => createHermesMcpConfig(cwd, env));
  }
  if (hasPlatform(platforms, "cursor")) {
    add("Creating Cursor MCP config", () => createCursorMcpConfig(cwd, env));
  }
  if (hasPlatform(platforms, "antigravity")) {
    add("Creating Antigravity rules", () => createAntigravityRules(cwd, force));
    add("Creating Antigravity MCP config", () => createAntigravityMcpConfig(cwd, env));
  }
  steps.push(...runtimeHookSteps(ctx, platforms));
  add("Creating instruction files", () => {
    if (target === "all") createInstructionFiles(cwd, force);
    else createInstructionFilesForPlatforms(cwd, force, platforms);
  });
  return steps;
}

function buildGlobalSetupSteps(
  ctx: CommandContext,
  force: boolean,
  platforms: string[],
): InitStep[] {
  void force;
  const env = ctx.env;
  let home = "";
  try {
    home = userHomeDir(env);
  } catch {
    home = "";
  }
  const steps: InitStep[] = [];
  const add = (label: string, run: () => void) => steps.push({ label, run });
  const has = (id: string) => hasPlatform(platforms, id);

  if (
    [
      "claude-code",
      "kiro",
      "codex",
      "opencode",
      "hermes",
      "antigravity",
      "cursor",
      "gemini",
      "agents",
    ].some(has)
  ) {
    add("Syncing global skills", () => syncGlobalSkills(home, platforms));
  }
  if (has("claude-code")) {
    add("Configuring Claude Code global MCP", () => setupGlobalClaudeCodeMcp(home, env));
    add("Configuring Claude Desktop MCP", () =>
      setupGlobalClaudeDesktopMcp(home, env, process.platform, ctx.cwd),
    );
  }
  if (has("opencode"))
    add("Configuring OpenCode global MCP", () => setupGlobalOpenCodeMcp(home, env));
  if (has("hermes")) add("Configuring Hermes global MCP", () => setupGlobalHermesMcp(home, env));
  if (has("gemini") || has("antigravity")) {
    add("Configuring Gemini/Antigravity global MCP", () => setupGlobalGeminiMcp(home, env));
  }
  if (has("kiro")) add("Configuring Kiro global MCP", () => setupGlobalKiroMcp(home, env));
  if (has("cursor")) add("Configuring Cursor global MCP", () => setupGlobalCursorMcp(home, env));
  if (has("codex")) add("Configuring Codex global MCP", () => setupGlobalCodexMcp(home, env));

  steps.push(...runtimeHookSteps(ctx, platforms));

  if (has("claude-code")) {
    add("Creating global Claude instruction file", () =>
      writeGlobalInstructionFile(home, "claude-code"),
    );
  }
  if (has("kiro")) {
    add("Creating global Kiro steering file", () => writeGlobalInstructionFile(home, "kiro"));
  }
  return steps;
}

/** recordGlobalSkillsScope: persist the machine-wide default so a later sync keeps the choice. */
async function recordGlobalSkillsScope(ctx: CommandContext): Promise<void> {
  const { EmbeddingSettingsStore } = await import(
    "../../storage/stores/embedding-settings-store.ts"
  );
  try {
    const store = new EmbeddingSettingsStore(
      join(userHomeDir(ctx.env), ".knowns", "settings.json"),
    );
    const settings = store.load();
    settings.projectDefaults ??= { settings: {} };
    if (settings.projectDefaults.settings.skillsScope === "global") return;
    settings.projectDefaults.settings.skillsScope = "global";
    store.save(settings);
  } catch {
    return;
  }
  ctx.print(
    `${StyleDim.render('Recorded global default skillsScope = "global"; knowns sync will no longer create project skill directories.')}\n`,
  );
}

async function selectPlatforms(ctx: CommandContext): Promise<string[] | undefined> {
  const { createPrompter, isUserAborted } = await import("../tui/prompter.ts");
  const { runSetupSelector } = await import("../tui/setup-selector.ts");
  try {
    return await runSetupSelector(createPrompter(), ctx.env, ctx.cwd);
  } catch (e) {
    if (isUserAborted(e)) {
      ctx.print(`${StyleWarning.render("Setup cancelled.")}\n`);
      return undefined;
    }
    throw e;
  }
}

export default defineCommand({
  use: "setup [target]",
  short: "Configure AI tool integrations",
  long: `Configure AI tool integrations for an initialized Knowns project.

Without a target, an interactive selector is shown.

Targets:
  claude    Generate CLAUDE.md, .mcp.json, skills, and runtime hooks
  opencode  Generate OPENCODE.md, opencode.json, skills, and runtime hooks
  hermes    Generate AGENTS.md, skills, and a project-pinned global Hermes MCP config
  codex     Generate AGENTS.md, .codex/config.toml, skills, and runtime hooks
  copilot   Generate .github/copilot-instructions.md
  kiro      Generate .kiro steering/settings, skills, and runtime hooks
  cursor    Generate .cursor/mcp.json
  gemini    Generate GEMINI.md
  antigravity Generate Antigravity rules/config and skills
  agents    Generate AGENTS.md
  all       Generate all supported AI integration files

Use --global to install at user-level paths (no project required).
Global MCP uses 'knowns mcp --stdio' without --project flag.`,
  args: maximumNArgs(1),
  flags: [
    {
      type: "bool",
      shorthand: "f",
      name: "force",
      usage: "Overwrite generated files where supported",
      default: false,
    },
    {
      type: "bool",
      name: "global",
      usage: "Install to user-level paths (no project required)",
      default: false,
    },
  ],
  async run(ctx) {
    const force = ctx.flags.bool("force");
    const global = ctx.flags.bool("global");

    if (global) {
      let platforms: string[];
      if (ctx.args.length === 0) {
        const picked = await selectPlatforms(ctx);
        if (picked === undefined) return;
        platforms = picked;
      } else {
        const found = platformsForSetupTarget(ctx.args[0] as string);
        if (!found) throw TARGET_ERROR(ctx.args[0] as string);
        platforms = found;
      }
      ctx.print("\n");
      try {
        await runInitSteps(ctx, buildGlobalSetupSteps(ctx, force, platforms));
      } catch (e) {
        throw new Error(`global setup failed: ${(e as Error).message}`);
      }
      ctx.print("\n");
      ctx.print(`${StyleSuccess.render("Global AI integration setup complete")}\n`);
      await recordGlobalSkillsScope(ctx);
      return;
    }

    const cwd = ctx.cwd;
    try {
      statSync(join(cwd, ".knowns"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("project is not initialized; run 'knowns init' first");
      }
      throw e;
    }

    let platforms: string[];
    if (ctx.args.length === 0) {
      const picked = await selectPlatforms(ctx);
      if (picked === undefined) return;
      platforms = picked;
    } else {
      const found = platformsForSetupTarget(ctx.args[0] as string);
      if (!found) throw TARGET_ERROR(ctx.args[0] as string);
      platforms = found;
    }

    const target = ctx.args.length > 0 ? (ctx.args[0] as string) : "selected platforms";
    const steps = await buildSetupSteps(ctx, cwd, force, target, platforms);
    ctx.print("\n");
    try {
      await runInitSteps(ctx, steps);
    } catch (e) {
      throw new Error(`setup failed: ${(e as Error).message}`);
    }
    ctx.print("\n");
    ctx.print(`${StyleSuccess.render(`✓ AI integration setup complete for ${target}`)}\n`);
  },
});
