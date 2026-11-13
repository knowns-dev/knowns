// The non-interactive configuration of `knowns init` (runInit's else-branch in internal/cli/init.go)
// as a pure function: flags, global defaults (~/.knowns/settings.json projectDefaults) and, with
// --force, the existing project config decide the answers. A non-interactive run never probes
// Ollama (D7/D8), so the result does not depend on the machine.
import { basename } from "node:path";
import {
  declaredSemanticVectorStoreSettings,
  type GitTracking,
  gitTrackingDefaults,
  type Project,
  type SemanticSearchSettings,
  type TaskLifecycleSettings,
  taskLifecycleSettingsSchema,
} from "../../models/config.ts";
import {
  D2_DEFAULT_MODEL_ID,
  type OllamaGuidance,
  OllamaState,
  ollamaStateGuidance,
} from "../../storage/stores/embedding-registry-defaults.ts";
import type { JsonObject } from "../../storage/stores/go-shape.ts";
import { defaultInstructionPlatforms } from "./platforms.ts";

/** initConfig: everything init applies. */
export interface InitConfig {
  name: string;
  taskIdPrefix: string;
  gitTrackingMode: string;
  gitTracking: GitTracking;
  enableSemantic: boolean;
  semanticModel: string;
  /** "ollama" or "api". */
  embeddingSource: string;
  platforms: string[];
  taskLifecycle?: TaskLifecycleSettings;
  semanticGuidance: OllamaGuidance;
}

export interface GlobalProjectDefaults {
  projectName?: string;
  settings: JsonObject;
}

const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** copyTaskLifecycleSettings from a raw settings object (defaults fill what it omits). */
export function taskLifecycleFromRaw(raw: unknown): TaskLifecycleSettings | undefined {
  if (!isObject(raw)) return undefined;
  const parsed = taskLifecycleSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** lifecycleSeedForInit: the existing effective lifecycle on --force, else the global default. */
export function lifecycleSeedForInit(
  existing: Project | undefined,
  force: boolean,
  defaults: GlobalProjectDefaults | undefined,
): TaskLifecycleSettings | undefined {
  if (force && existing) {
    const tl = existing.settings.taskLifecycle;
    return tl ? { ...tl } : taskLifecycleSettingsSchema.parse({});
  }
  if (!defaults) return undefined;
  return taskLifecycleFromRaw(defaults.settings.taskLifecycle);
}

export interface ResolveInitInput {
  cwd: string;
  /** The [name] argument, if given. */
  nameArg: string | undefined;
  gitTracked: boolean;
  gitIgnored: boolean;
  force: boolean;
  /** An explicit, already normalized --task-prefix ("" when absent). */
  taskPrefixFlag: string;
  globalDefaults: GlobalProjectDefaults | undefined;
  /** The existing project config, consulted only with --force. */
  existing: Project | undefined;
  taskLifecycleSeed: TaskLifecycleSettings | undefined;
}

export function resolveNonInteractiveInit(input: ResolveInitInput): InitConfig {
  const { globalDefaults, existing } = input;
  let name = basename(input.cwd);
  if (globalDefaults?.projectName) name = globalDefaults.projectName;
  if (input.nameArg !== undefined) name = input.nameArg;

  let taskIdPrefix = "";
  if (globalDefaults) taskIdPrefix = str(globalDefaults.settings.defaultTaskIdPrefix);

  let gitMode = "git-tracked";
  let gitTracking: GitTracking = gitTrackingDefaults();
  let enableSemantic = false;
  let semanticModel = D2_DEFAULT_MODEL_ID;
  let embeddingSource = "ollama";
  let platforms = defaultInstructionPlatforms();

  const apply = (s: JsonObject): void => {
    if (str(s.gitTrackingMode) !== "") gitMode = str(s.gitTrackingMode);
    if (isObject(s.gitTracking)) gitTracking = { ...(s.gitTracking as GitTracking) };
    if (isObject(s.semanticSearch)) {
      enableSemantic = s.semanticSearch.enabled === true;
      semanticModel = str(s.semanticSearch.model);
      if (str(s.semanticSearch.provider) !== "") embeddingSource = str(s.semanticSearch.provider);
    }
    if (Array.isArray(s.platforms) && s.platforms.length > 0) {
      platforms = s.platforms.filter((p): p is string => typeof p === "string");
    }
  };
  if (globalDefaults) apply(globalDefaults.settings);

  if (input.force && existing) {
    if (existing.name !== "" && input.nameArg === undefined) name = existing.name;
    if ((existing.settings.defaultTaskIdPrefix ?? "") !== "") {
      taskIdPrefix = existing.settings.defaultTaskIdPrefix ?? "";
    }
    apply(existing.settings as unknown as JsonObject);
  }
  if (input.gitTracked) gitMode = "git-tracked";
  else if (input.gitIgnored) gitMode = "git-ignored";

  return {
    name,
    taskIdPrefix: input.taskPrefixFlag !== "" ? input.taskPrefixFlag : taskIdPrefix,
    gitTrackingMode: gitMode,
    gitTracking,
    enableSemantic,
    semanticModel,
    embeddingSource,
    platforms,
    ...(input.taskLifecycleSeed ? { taskLifecycle: input.taskLifecycleSeed } : {}),
    // The guidance must not depend on a probe (D8): always the "not installed" state.
    semanticGuidance: ollamaStateGuidance(OllamaState.NotInstalled, semanticModel),
  };
}

/** buildSemanticSettings: the semanticSearch block of a semantic-enabled init, else undefined. */
export function buildSemanticSettings(cfg: InitConfig): SemanticSearchSettings | undefined {
  if (!cfg.enableSemantic || cfg.semanticModel === "") return undefined;
  return {
    enabled: true,
    provider: cfg.embeddingSource === "" ? "ollama" : cfg.embeddingSource,
    model: cfg.semanticModel,
    vectorStore: declaredSemanticVectorStoreSettings(),
  };
}
