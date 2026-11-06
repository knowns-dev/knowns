// The interactive `knowns init` wizard (runWizard in internal/cli/init.go), written against the
// Prompter seam. Same questions in the same order with the same defaults and validation as 0.34.1:
//
//   1. Project name (required) and Default Task ID prefix (2-8 alphanumerics, blank allowed)
//   2. Git tracking mode, only when a git repository or git itself is available and neither
//      --git-tracked nor --git-ignored was given
//   3. Enable Semantic Search + Embedding model, only when semantic search starts enabled (an
//      Ollama that is ready, or an earlier answer): huh hides the whole group otherwise, so the
//      user is never asked
//   4. Knowns sections to track in git, skipped when the mode is "none"
//   5. Project instruction files (at least one)
import { basename } from "node:path";
import { type Env, lookPath } from "../../domain/setup/env.ts";
import type { GlobalProjectDefaults, InitConfig } from "../../domain/setup/init-config.ts";
import { type GitTracking, gitTrackingDefaults, type Project } from "../../models/config.ts";
import { normalizeTaskIdPrefix } from "../../models/id.ts";
import type { OllamaEmbeddingModel } from "../../search/ollama.ts";
import {
  D2_DEFAULT_MODEL_ID,
  type OllamaGuidance,
  OllamaState,
  ollamaStateGuidance,
  recommendedModels,
} from "../../storage/stores/embedding-registry-defaults.ts";
import { StyleDim, StyleTitle } from "../core/plainoutput.ts";
import { gitTrackingFromSelectedSections, gitTrackingSelectedSections } from "./git-sections.ts";
import {
  gitTrackingSections,
  instructionPlatformOptions,
  normalizeInstructionPlatforms,
} from "./labels.ts";
import type { ChoiceOption, Prompter } from "./prompter.ts";

export interface OllamaProbe {
  state: OllamaState;
  models: OllamaEmbeddingModel[];
}

/** probeOllamaForWizard: which of the four Ollama states this machine is in (preselection only). */
export async function probeOllamaForWizard(env: Env = process.env): Promise<OllamaProbe> {
  if (lookPath("ollama", env) === undefined) return { state: OllamaState.NotInstalled, models: [] };
  const { OllamaDetector, OLLAMA_DEFAULT_BASE } = await import("../../search/ollama.ts");
  const detector = new OllamaDetector(OLLAMA_DEFAULT_BASE);
  const { running } = await detector.isRunning();
  if (!running) return { state: OllamaState.NotRunning, models: [] };
  try {
    const models = await detector.listEmbeddingModels();
    if (models.length === 0) return { state: OllamaState.ModelMissing, models: [] };
    return { state: OllamaState.Ready, models };
  } catch {
    return { state: OllamaState.ModelMissing, models: [] };
  }
}

/** wizardSemanticDefaults: what the form preselects. An earlier answer beats the probe. */
export function wizardSemanticDefaults(
  state: OllamaState,
  models: readonly OllamaEmbeddingModel[],
  existingEnabled: boolean | undefined,
  existingModel: string,
): { enabled: boolean; model: string; guidance: OllamaGuidance } {
  let model = D2_DEFAULT_MODEL_ID;
  const first = models[0];
  if (first) model = first.shortName;
  if (existingModel !== "") model = existingModel;
  const guidance = ollamaStateGuidance(state, model);
  let enabled = state === OllamaState.Ready;
  if (existingEnabled !== undefined) enabled = existingEnabled;
  return { enabled, model, guidance };
}

/** semanticModelOptions: models already served, then the D2 recommendations, deduplicated. */
export function semanticModelOptions(
  models: readonly OllamaEmbeddingModel[],
  selected: string,
): ChoiceOption[] {
  const seen = new Set<string>();
  const options: ChoiceOption[] = [];
  for (const m of models) {
    const id = m.shortName;
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    options.push({
      label: `${id} (${m.dimensions}d) — already on this machine`,
      value: id,
      selected: id === selected,
    });
  }
  for (const m of recommendedModels()) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    options.push({ label: `${m.id} — ${m.tradeoff}`, value: m.id, selected: m.id === selected });
  }
  if (selected !== "" && !seen.has(selected)) {
    options.push({ label: `${selected} (current)`, value: selected, selected: true });
  }
  return options;
}

export interface WizardInput {
  cwd: string;
  gitTracked: boolean;
  gitIgnored: boolean;
  gitAvailable: boolean;
  /** isGitRepo(cwd). */
  inGitRepo: boolean;
  existingName: string;
  existingTaskIdPrefix: string;
  existingGitTrackingMode: string;
  existingGitTracking: GitTracking | undefined;
  existingSemanticEnabled: boolean | undefined;
  existingSemanticModel: string;
  existingPlatforms: readonly string[];
  /** Injected in tests; defaults to the real Ollama probe. */
  probe?: () => Promise<OllamaProbe>;
  env?: Env;
  /** Where the banner goes (stdout). */
  print: (text: string) => void;
}

const prefixProblem = (s: string): string | undefined => {
  try {
    normalizeTaskIdPrefix(s);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

/** runWizard: ask the questions and return the answers. Throws UserAborted on cancel. */
export async function runWizard(prompter: Prompter, input: WizardInput): Promise<InitConfig> {
  const defaultName = input.existingName !== "" ? input.existingName : basename(input.cwd);

  input.print("\n");
  input.print(`${StyleTitle.render("🚀 Knowns Project Setup")}\n`);
  input.print(`${StyleDim.render("   Quick configuration")}\n`);
  input.print("\n");

  // Detection only narrows what is preselected; the answers decide what is written (D7).
  const probe = await (input.probe ?? (() => probeOllamaForWizard(input.env)))();
  const sem = wizardSemanticDefaults(
    probe.state,
    probe.models,
    input.existingSemanticEnabled,
    input.existingSemanticModel,
  );

  // Group 1: name and prefix.
  const name = await prompter.input({
    title: "Project name",
    value: defaultName,
    placeholder: defaultName,
    validate: (s) => (s.trim() === "" ? "project name is required" : undefined),
  });
  const taskIdPrefix = await prompter.input({
    title: "Default Task ID prefix",
    description: "2-8 alphanumeric characters, e.g. KN. Leave blank for legacy IDs.",
    value: input.existingTaskIdPrefix,
    placeholder: input.existingTaskIdPrefix,
    validate: prefixProblem,
  });

  // Group 1b: git tracking mode.
  let gitTrackingMode = "";
  if ((input.inGitRepo || input.gitAvailable) && !input.gitTracked && !input.gitIgnored) {
    gitTrackingMode = await prompter.select({
      title: "Git tracking mode",
      description: "Choose what Knowns data is committed to git.",
      options: [
        { label: "Git Tracked  · tasks, docs, templates", value: "git-tracked" },
        { label: "Git Ignored  · docs, templates only", value: "git-ignored" },
        { label: "None  · manage tracking manually", value: "none" },
      ],
      value: input.existingGitTrackingMode !== "" ? input.existingGitTrackingMode : "git-tracked",
    });
  } else if (input.gitTracked) gitTrackingMode = "git-tracked";
  else if (input.gitIgnored) gitTrackingMode = "git-ignored";

  // Group 2: semantic search, shown only when it starts enabled.
  let enableSemantic = sem.enabled;
  let semanticModel = sem.model;
  if (sem.enabled) {
    enableSemantic = await prompter.confirm({
      title: "Enable Semantic Search",
      description: sem.guidance.description,
      value: enableSemantic,
    });
    semanticModel = await prompter.select({
      title: "Embedding model",
      description:
        "No model is downloaded by init (D8) — pull it yourself if it isn't already on disk.",
      options: semanticModelOptions(probe.models, semanticModel),
      value: semanticModel,
    });
  }

  // Group 3: sections to track, skipped for "none".
  let gitTracking: GitTracking = input.existingGitTracking
    ? { ...input.existingGitTracking }
    : gitTrackingDefaults();
  if (gitTrackingMode !== "none") {
    const preselected = gitTrackingSelectedSections(gitTracking);
    const picked = await prompter.multiselect({
      title: "Knowns sections to track in git",
      description: "Choose sections under .knowns/ that should be committed.",
      options: gitTrackingSections.map((s) => ({
        label: s.label,
        value: s.id,
        selected: preselected.includes(s.id),
      })),
    });
    gitTracking = gitTrackingFromSelectedSections(picked);
  }

  // Group 4: instruction files.
  const platforms = await prompter.multiselect({
    title: "Project instruction files",
    description: "Instruction files for agents that read project files.",
    options: instructionPlatformOptions(normalizeInstructionPlatforms(input.existingPlatforms)),
    validate: (s) => (s.length === 0 ? "select at least one instruction file" : undefined),
  });

  return {
    name,
    taskIdPrefix,
    gitTrackingMode,
    gitTracking,
    enableSemantic,
    semanticModel,
    // The wizard never asks for it; init.ts fills it from the global defaults / existing config.
    embeddingSource: "",
    platforms,
    semanticGuidance: sem.guidance,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export type WizardDefaults = Pick<
  WizardInput,
  | "existingName"
  | "existingTaskIdPrefix"
  | "existingGitTrackingMode"
  | "existingGitTracking"
  | "existingSemanticEnabled"
  | "existingSemanticModel"
  | "existingPlatforms"
> & { existingEmbeddingSource: string };

/**
 * The pre-filled answers: the global defaults (~/.knowns/settings.json projectDefaults), then the
 * existing project config on top of them (defaultsForWizard + the override block of runInit, and
 * resolveWizardEmbeddingSource).
 */
export function wizardDefaults(
  cwd: string,
  globalDefaults: GlobalProjectDefaults | undefined,
  existing: Project | undefined,
): WizardDefaults {
  let name = basename(cwd);
  let taskIdPrefix = "";
  let gitMode = "";
  let gitTracking: GitTracking | undefined;
  let semanticEnabled: boolean | undefined;
  let semanticModel = "";
  let platforms: string[] = ["claude-code", "agents"];
  let source = "";

  if (globalDefaults) {
    const s = globalDefaults.settings;
    if (globalDefaults.projectName) name = globalDefaults.projectName;
    taskIdPrefix = typeof s.defaultTaskIdPrefix === "string" ? s.defaultTaskIdPrefix : "";
    gitMode = typeof s.gitTrackingMode === "string" ? s.gitTrackingMode : "";
    if (isObj(s.gitTracking)) gitTracking = s.gitTracking as GitTracking;
    if (isObj(s.semanticSearch)) {
      semanticEnabled = s.semanticSearch.enabled === true;
      semanticModel = typeof s.semanticSearch.model === "string" ? s.semanticSearch.model : "";
      if (typeof s.semanticSearch.provider === "string") source = s.semanticSearch.provider;
    }
    if (Array.isArray(s.platforms) && s.platforms.length > 0) {
      platforms = s.platforms.filter((p): p is string => typeof p === "string");
    }
  }
  if (existing) {
    const s = existing.settings;
    name = existing.name;
    taskIdPrefix = s.defaultTaskIdPrefix ?? "";
    gitMode = s.gitTrackingMode ?? "";
    if (s.gitTracking) gitTracking = s.gitTracking;
    if (s.semanticSearch) {
      semanticEnabled = s.semanticSearch.enabled === true;
      semanticModel = s.semanticSearch.model ?? "";
      if (s.semanticSearch.provider) source = s.semanticSearch.provider;
    }
    if (s.platforms && s.platforms.length > 0) platforms = [...s.platforms];
  }
  return {
    existingName: name,
    existingTaskIdPrefix: taskIdPrefix,
    existingGitTrackingMode: gitMode,
    existingGitTracking: gitTracking,
    existingSemanticEnabled: semanticEnabled,
    existingSemanticModel: semanticModel,
    existingPlatforms: platforms,
    existingEmbeddingSource: source,
  };
}
