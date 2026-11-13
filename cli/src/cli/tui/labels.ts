// Platform labels and the option tables the interactive flows share (internal/cli/init.go).
import type { Env } from "../../domain/setup/env.ts";
import { defaultOptions, runtimeAvailabilitySummary } from "../../domain/setup/runtimeinstall.ts";
import { StyleError, StyleSuccess, StyleWarning } from "../core/plainoutput.ts";
import type { ChoiceOption } from "./prompter.ts";

/** wizardPlatformIDs: the platforms the multi-selects offer, in order. */
export const wizardPlatformIds: readonly string[] = [
  "claude-code",
  "opencode",
  "codex",
  "kiro",
  "hermes",
  "antigravity",
  "cursor",
  "gemini",
  "copilot",
  "agents",
];

/** gitTrackingSections: the option table of the git tracking multi-select. */
export const gitTrackingSections: ReadonlyArray<{ label: string; id: string }> = [
  { label: "Tasks", id: "tasks" },
  { label: "Docs", id: "docs" },
  { label: "Templates", id: "templates" },
  { label: "Decisions", id: "decisions" },
  { label: "Memories", id: "memories" },
];

function runtimeStatusDot(status: string): string {
  switch (status) {
    case "installed":
      return StyleSuccess.render("●");
    case "available":
      return StyleWarning.render("●");
    default:
      return StyleError.render("●");
  }
}

const RUNTIME_SPEC_LABEL: Record<string, string> = {
  "claude-code": "Claude Code (CLAUDE.md, SKILL, hooks, ...)",
  codex: "Codex (.codex/config.toml, SKILL, hooks, ...)",
  opencode: "OpenCode (OPENCODE.md, SKILL, plugin, MCP, ...)",
  kiro: "Kiro IDE (.kiro/steering, SKILL, hooks, ...)",
};

/** platformLabel: the human-readable label of a platform id. */
export function platformLabel(id: string, env: Env = process.env, cwd = process.cwd()): string {
  const spec = RUNTIME_SPEC_LABEL[id];
  if (spec !== undefined) {
    const status = runtimeAvailabilitySummary(id, defaultOptions(env, cwd));
    return `${runtimeStatusDot(status)} ${spec}`;
  }
  switch (id) {
    case "gemini":
      return "Google Gemini  (GEMINI.md)";
    case "antigravity":
      return "Antigravity  (.agents/rules/knowns.md, ~/.gemini/antigravity/mcp_config.json)";
    case "hermes":
      return "Hermes Agent  (AGENTS.md, .agents/skills, ~/.hermes/config.yaml)";
    case "cursor":
      return "Cursor  (.cursor/mcp.json)";
    case "copilot":
      return "GitHub Copilot  (.github/copilot-instructions.md)";
    case "agents":
      return "Generic Agents  (AGENTS.md, .agents/skills/)";
    default:
      return id;
  }
}

/** The wizard platform multi-select: every wizard platform, `selected` ones checked. */
export function platformOptions(
  selected: readonly string[],
  env: Env = process.env,
  cwd = process.cwd(),
): ChoiceOption[] {
  return wizardPlatformIds.map((id) => ({
    label: platformLabel(id, env, cwd),
    value: id,
    selected: selected.includes(id),
  }));
}

/** instructionPlatformOptions: the instruction-file multi-select of the init wizard. */
export function instructionPlatformOptions(selected: readonly string[]): ChoiceOption[] {
  const set = new Set(selected.map((id) => (id === "codex" || id === "hermes" ? "agents" : id)));
  const options: Array<{ label: string; id: string }> = [
    { label: "CLAUDE.md  (Claude Code)", id: "claude-code" },
    { label: "AGENTS.md  (Codex / generic agents)", id: "agents" },
    { label: "OPENCODE.md  (OpenCode)", id: "opencode" },
    { label: "GEMINI.md  (Gemini CLI)", id: "gemini" },
    { label: ".github/copilot-instructions.md", id: "copilot" },
  ];
  return options.map((o) => ({ label: o.label, value: o.id, selected: set.has(o.id) }));
}

/** normalizeInstructionPlatforms. */
export function normalizeInstructionPlatforms(platforms: readonly string[]): string[] {
  const fallback = ["claude-code", "agents"];
  if (platforms.length === 0) return fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of platforms) {
    const id = raw === "codex" ? "agents" : raw;
    if (!["claude-code", "agents", "opencode", "gemini", "copilot"].includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length === 0 ? fallback : out;
}
