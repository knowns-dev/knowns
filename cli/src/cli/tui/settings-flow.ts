// The interactive `knowns settings` menus (runSettings and runGlobalSettings in
// internal/cli/config.go) against the Prompter seam. Same menu, same sub-forms in the same order,
// same defaults and the same writes as 0.34.1. Cancelling a sub-form returns to the menu without
// that form's change (but, like Go, a caller that saves afterwards still saves); cancelling the
// menu prints "Aborted." and exits 0.
import { join } from "node:path";
import { type Env, userHomeDir } from "../../domain/setup/env.ts";
import { writeKnownsGitignore } from "../../domain/setup/gitignore.ts";
import {
  type GitTracking,
  gitTrackingDefaults,
  normalizeSkillsScope,
  type Project,
  type SkillsScope,
} from "../../models/config.ts";
import { normalizeTaskIdPrefix } from "../../models/id.ts";
import type { OllamaDetector } from "../../search/ollama.ts";
import type { ConfigStore } from "../../storage/stores/config-store.ts";
import {
  D2_DEFAULT_MODEL_ID,
  OllamaState,
  ollamaStateGuidance,
} from "../../storage/stores/embedding-registry-defaults.ts";
import {
  EmbeddingSettingsStore,
  getProvider,
} from "../../storage/stores/embedding-settings-store.ts";
import { renderHint, renderSectionHeader, renderSuccess, StyleDim } from "../core/plainoutput.ts";
import { detectEmbeddingDimensions, listApiModels } from "./embedding-api.ts";
import { gitTrackingFromSelectedSections, gitTrackingSelectedSections } from "./git-sections.ts";
import { gitTrackingSections, platformOptions } from "./labels.ts";
import { isUserAborted, type Prompter } from "./prompter.ts";

/** A ProjectSettings object, project (typed) or machine default (raw JSON): the forms edit both. */
export type SettingsLike = Record<string, unknown>;

export interface SettingsDeps {
  prompter: Prompter;
  /** stdout. */
  print: (text: string) => void;
  env: Env;
  cwd: string;
  /** Test seams. */
  detector?: () => Pick<OllamaDetector, "isRunning" | "listEmbeddingModels">;
  fetchFn?: typeof fetch;
}

const prefixProblem = (s: string): string | undefined => {
  try {
    normalizeTaskIdPrefix(s);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

const dim = (d: SettingsDeps, line: string): void => d.print(`${StyleDim.render(line)}\n`);

/** Runs one form; a cancel is reported as `undefined` (Go returns nil from the form's caller). */
async function ask<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    if (isUserAborted(e)) return undefined;
    throw e;
  }
}

function semanticProviderOptions() {
  return [
    { label: "Ollama (local API)", value: "ollama" },
    { label: "API (OpenAI-compatible)", value: "api" },
  ];
}

/** normalizedSemanticProvider: "" and the legacy "local" are Ollama. */
export function normalizedSemanticProvider(provider: string): string {
  return provider === "" || provider === "local" ? "ollama" : provider;
}

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

// --- shared sub-forms ---------------------------------------------------------------------------

/** configureGitTrackingSettings: mode, then (unless "none") the sections. */
export async function configureGitTrackingSettings(
  d: SettingsDeps,
  settings: SettingsLike,
): Promise<void> {
  const current = typeof settings.gitTrackingMode === "string" ? settings.gitTrackingMode : "";
  const mode = await ask(() =>
    d.prompter.select({
      title: "Git tracking mode",
      options: [
        { label: "Git Tracked", value: "git-tracked" },
        { label: "Git Ignored", value: "git-ignored" },
        { label: "None", value: "none" },
      ],
      value: current === "" ? "git-tracked" : current,
    }),
  );
  if (mode === undefined) return;
  settings.gitTrackingMode = mode;
  if (mode === "none") {
    delete settings.gitTracking;
    return;
  }
  const tracking =
    (asObject(settings.gitTracking) as GitTracking | undefined) ?? gitTrackingDefaults();
  const preselected = gitTrackingSelectedSections(tracking);
  const picked = await ask(() =>
    d.prompter.multiselect({
      title: "Knowns sections to track in git",
      options: gitTrackingSections.map((s) => ({
        label: s.label,
        value: s.id,
        selected: preselected.includes(s.id),
      })),
    }),
  );
  if (picked === undefined) return;
  settings.gitTracking = gitTrackingFromSelectedSections(picked);
}

/** configurePlatformSettings: platforms and the skills location. */
export async function configurePlatformSettings(
  d: SettingsDeps,
  settings: SettingsLike,
  global: boolean,
): Promise<void> {
  let selected = Array.isArray(settings.platforms)
    ? (settings.platforms as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  if (selected.length === 0) selected = ["claude-code", "agents"];

  let inheritLabel = "Inherit global default";
  let scopeDescription = "Where knowns sync writes built-in skills for this project.";
  if (global) {
    inheritLabel = "Not set (projects default to their own directory)";
    scopeDescription = "Default for every project that has not set its own scope.";
  }
  let scope: SkillsScope | "" = "";
  try {
    scope = normalizeSkillsScope(
      typeof settings.skillsScope === "string" ? settings.skillsScope : "",
    );
  } catch {
    scope = "";
  }

  const platforms = await ask(() =>
    d.prompter.multiselect({
      title: "AI platforms",
      description: "Select generated instruction and integration targets.",
      options: platformOptions(selected, d.env, d.cwd),
    }),
  );
  if (platforms === undefined) return;
  const location = await ask(() =>
    d.prompter.select({
      title: "Skill location",
      description: scopeDescription,
      options: [
        { label: inheritLabel, value: "" },
        { label: "This project (.claude/skills, .agents/skills)", value: "project" },
        { label: "Global only (~/.claude/skills, ~/.agents/skills)", value: "global" },
        { label: "Do not manage skills", value: "none" },
      ],
      value: scope,
    }),
  );
  if (location === undefined) return;
  if (platforms.length === 0) delete settings.platforms;
  else settings.platforms = platforms;
  if (location === "") delete settings.skillsScope;
  else settings.skillsScope = location;
}

const LSP_LANGUAGES = [
  "go",
  "typescript",
  "python",
  "rust",
  "c_cpp",
  "java",
  "csharp",
  "ruby",
  "php",
];

/** configureLSPSettings: one switch that seeds every language's enabled flag. */
export async function configureLspSettings(d: SettingsDeps, settings: SettingsLike): Promise<void> {
  let lsp = asObject(settings.lsp);
  if (!lsp) {
    lsp = { languages: {} };
    settings.lsp = lsp;
  }
  const enabled = await ask(() =>
    d.prompter.confirm({
      title: "Enable code intelligence",
      description: "Language servers power code symbols, references, and diagnostics.",
      value: lsp.enabled === true,
    }),
  );
  if (enabled === undefined) return;
  lsp.enabled = enabled;
  const languages = asObject(lsp.languages) ?? {};
  lsp.languages = languages;
  for (const id of LSP_LANGUAGES) {
    const lang = asObject(languages[id]) ?? {};
    if (lang.enabled === undefined || lang.enabled === null) lang.enabled = enabled;
    languages[id] = lang;
  }
  // Go marshals a map with its keys sorted.
  const sorted = Object.keys(languages).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  lsp.languages = Object.fromEntries(sorted.map((k) => [k, languages[k]]));
}

/** configureSemanticDefaults (global): enable, provider, model. */
export async function configureSemanticDefaults(
  d: SettingsDeps,
  settings: SettingsLike,
): Promise<void> {
  const ss = asObject(settings.semanticSearch);
  let enabled = ss?.enabled === true;
  let provider = "ollama";
  let model = D2_DEFAULT_MODEL_ID;
  if (ss) {
    if (typeof ss.provider === "string" && ss.provider !== "") provider = ss.provider;
    if (typeof ss.model === "string" && ss.model !== "") model = ss.model;
  }
  provider = normalizedSemanticProvider(provider);

  const on = await ask(() =>
    d.prompter.confirm({ title: "Enable semantic search by default", value: enabled }),
  );
  if (on === undefined) return;
  enabled = on;
  if (enabled) {
    const p = await ask(() =>
      d.prompter.select({
        title: "Default provider",
        options: semanticProviderOptions(),
        value: provider,
      }),
    );
    if (p === undefined) return;
    provider = p;
  }
  if (!enabled) {
    settings.semanticSearch = { enabled: false, model, provider };
    return;
  }
  const m = await ask(() => d.prompter.input({ title: "Default model", value: model }));
  if (m === undefined) return;
  settings.semanticSearch = { enabled: true, provider, model: m };
}

// --- project settings ---------------------------------------------------------------------------

async function configureProjectIdentity(
  d: SettingsDeps,
  config: ConfigStore,
  project: Project,
): Promise<void> {
  const name = await ask(() =>
    d.prompter.input({
      title: "Project name",
      value: project.name,
      validate: (s) => (s.trim() === "" ? "project name is required" : undefined),
    }),
  );
  if (name === undefined) return;
  const prefix = await ask(() =>
    d.prompter.input({
      title: "Default Task ID prefix",
      description: "2-8 alphanumeric characters, e.g. KN. Leave blank for legacy IDs.",
      value: project.settings.defaultTaskIdPrefix ?? "",
      validate: prefixProblem,
    }),
  );
  if (prefix === undefined) return;
  project.name = name.trim();
  project.settings.defaultTaskIdPrefix = prefix;
  config.save(project);
}

async function toggleEmbedding(
  d: SettingsDeps,
  config: ConfigStore,
  project: Project,
  embeddingEnabled: { value: boolean },
): Promise<void> {
  let enabled = embeddingEnabled.value;
  let model = "";
  let provider = "ollama";
  const ss = project.settings.semanticSearch;
  if (ss) {
    model = ss.model ?? "";
    if (ss.provider) provider = ss.provider;
  }
  provider = normalizedSemanticProvider(provider);

  const on = await ask(() =>
    d.prompter.confirm({
      title: "Enable Semantic Search",
      description: "Embedding-based search for docs and code",
      value: enabled,
    }),
  );
  if (on === undefined) return;
  enabled = on;
  if (enabled) {
    const p = await ask(() =>
      d.prompter.select({ title: "Provider", options: semanticProviderOptions(), value: provider }),
    );
    if (p === undefined) return;
    provider = p;
  }

  if (!enabled) {
    embeddingEnabled.value = false;
    try {
      config.set("settings.semanticSearch.enabled", false);
    } catch {
      // Go ignores the error.
    }
    return;
  }

  const store = new EmbeddingSettingsStore(join(userHomeDir(d.env), ".knowns", "settings.json"));

  if (provider === "ollama") {
    const { OllamaDetector, OLLAMA_DEFAULT_BASE } = await import("../../search/ollama.ts");
    const detector = d.detector?.() ?? new OllamaDetector(OLLAMA_DEFAULT_BASE);
    const { running, version } = await detector.isRunning();
    if (!running) {
      dim(d, `  Ollama not detected at ${OLLAMA_DEFAULT_BASE}`);
      dim(d, "  Start Ollama first, then retry.");
      return;
    }
    dim(d, `  Ollama ${version} detected`);
    let embModels: Awaited<ReturnType<OllamaDetector["listEmbeddingModels"]>> = [];
    try {
      embModels = await detector.listEmbeddingModels();
    } catch {
      embModels = [];
    }
    if (embModels.length === 0) {
      const guidance = ollamaStateGuidance(OllamaState.ModelMissing, "");
      dim(d, "  No embedding models found in Ollama.");
      dim(d, `  Pull one: ${guidance.command}`);
      return;
    }
    const chosen = await ask(() =>
      d.prompter.select({
        title: "Select Embedding Model",
        options: embModels.map((m) => ({
          label: `${m.name} (${m.dimensions}d)`,
          value: m.name,
        })),
        value: model,
      }),
    );
    if (chosen === undefined) return;
    model = chosen;
    provider = "ollama";
    for (const [k, v] of [
      ["settings.semanticSearch.enabled", true],
      ["settings.semanticSearch.provider", provider],
      ["settings.semanticSearch.model", model],
    ] as const) {
      try {
        config.set(k, v);
      } catch {
        // Go ignores the error.
      }
    }
    embeddingEnabled.value = true;
    try {
      const embSettings = store.load();
      const dims = embModels.find((m) => m.name === model)?.dimensions ?? 0;
      embSettings.models[model] = { provider: "ollama", model, dimensions: dims };
      store.save(embSettings);
    } catch {
      // Go ignores the error.
    }
    return;
  }

  // Generic API provider: retry until the endpoint answers.
  let apiBase = "";
  let apiKey = "";
  let embSettings: ReturnType<EmbeddingSettingsStore["load"]> | undefined;
  try {
    embSettings = store.load();
    const p = getProvider(embSettings, "api");
    apiBase = p.apiBase;
    apiKey = p.apiKey ?? "";
  } catch {
    // no stored api provider
  }
  for (;;) {
    const base = await ask(() =>
      d.prompter.input({
        title: "API Base URL (embeddings endpoint)",
        placeholder: "e.g. https://llms.knowns.dev/v1/embeddings",
        value: apiBase,
      }),
    );
    if (base === undefined) return;
    const key = await ask(() =>
      d.prompter.input({ title: "API Key", placeholder: "sk-...", value: apiKey, password: true }),
    );
    if (key === undefined) return;
    apiBase = base;
    apiKey = key;
    if (apiBase === "") {
      dim(d, "  API Base URL is required.");
      continue;
    }
    // The key goes to ~/.knowns/settings.json, never the project config.
    embSettings ??= { providers: {}, models: {} };
    embSettings.providers.api = { name: "API Provider", apiBase, apiKey };
    try {
      store.save(embSettings);
    } catch {
      // Go ignores the error.
    }

    dim(d, "  Fetching models...");
    let apiModels: string[] | undefined;
    try {
      apiModels = await listApiModels(apiBase, apiKey, d.fetchFn);
    } catch (e) {
      dim(d, `  Could not list models: ${(e as Error).message}`);
      const typed = await ask(() =>
        d.prompter.input({
          title: "Model name",
          placeholder: "e.g. openrouter/nvidia/llama-nemotron-embed-vl-1b-v2:free",
          value: model,
        }),
      );
      if (typed === undefined) return;
      model = typed;
    }
    if (apiModels && apiModels.length > 0) {
      const chosen = await ask(() =>
        d.prompter.select({
          title: "Select Model",
          options: apiModels.map((m) => ({ label: m, value: m })),
          value: model,
        }),
      );
      if (chosen === undefined) return;
      model = chosen;
    }
    if (model === "") {
      dim(d, "  Model name is required.");
      continue;
    }

    dim(d, "  Testing embedding...");
    const dims = await detectEmbeddingDimensions(
      apiBase,
      apiKey,
      model,
      (l) => dim(d, l),
      d.fetchFn,
    );
    if (dims === 0) {
      dim(d, "  Failed. Check URL, key, and model name.");
      d.print("\n");
      continue;
    }
    dim(d, `  Success! Dimensions: ${dims}`);

    embeddingEnabled.value = true;
    for (const [k, v] of [
      ["settings.semanticSearch.enabled", true],
      ["settings.semanticSearch.provider", provider],
      ["settings.semanticSearch.model", model],
    ] as const) {
      try {
        config.set(k, v);
      } catch {
        // Go ignores the error.
      }
    }
    embSettings.models[model] = { provider: "api", model, dimensions: dims };
    try {
      store.save(embSettings);
    } catch {
      // Go ignores the error.
    }
    return;
  }
}

/** `knowns settings`: the project menu. Returns when the user is done or aborts. */
export async function runProjectSettings(d: SettingsDeps, config: ConfigStore): Promise<void> {
  let project: Project;
  try {
    project = config.load();
  } catch (e) {
    throw new Error(`load config: ${(e as Error).message}`);
  }
  for (;;) {
    let choice: string;
    try {
      choice = await d.prompter.select({
        title: "Project Settings",
        description: `Current project: ${project.name}`,
        options: [
          { label: "Project", value: "project" },
          { label: "Git Tracking", value: "git" },
          { label: "AI Platforms", value: "platforms" },
          { label: "Search", value: "search" },
          { label: "Code Intelligence", value: "code" },
          { label: "Maintenance", value: "maintenance" },
          { label: "Done", value: "done" },
        ],
        value: "project",
      });
    } catch (e) {
      if (isUserAborted(e)) {
        d.print("Aborted.\n");
        return;
      }
      throw e;
    }

    switch (choice) {
      case "done":
        d.print(`${renderSuccess("Settings saved.")}\n`);
        return;
      case "project":
        await configureProjectIdentity(d, config, project);
        break;
      case "git": {
        await configureGitTrackingSettings(d, project.settings as unknown as SettingsLike);
        config.save(project);
        writeKnownsGitignore(
          d.cwd,
          project.settings.gitTrackingMode ?? "",
          project.settings.gitTracking,
        );
        break;
      }
      case "platforms":
        await configurePlatformSettings(d, project.settings as unknown as SettingsLike, false);
        config.save(project);
        d.print(
          `${renderHint("Run: knowns sync to apply platform changes to generated files.")}\n`,
        );
        break;
      case "search": {
        const flag = { value: project.settings.semanticSearch?.enabled === true };
        await toggleEmbedding(d, config, project, flag);
        break;
      }
      case "code":
        await configureLspSettings(d, project.settings as unknown as SettingsLike);
        config.save(project);
        d.print(`${renderHint("Run: knowns lsp status for missing server install guidance.")}\n`);
        break;
      case "maintenance":
        d.print(`${renderSectionHeader("Maintenance")}\n`);
        d.print(
          `${renderHint("Run: knowns sync to apply generated files, git rules, models, and MCP configs.")}\n`,
        );
        if (project.settings.semanticSearch?.enabled === true) {
          d.print(
            `${renderHint("Run: knowns search --reindex after changing search settings.")}\n`,
          );
        }
        d.print(`${renderHint("Run: knowns config list --plain for scriptable inspection.")}\n`);
        break;
    }
    try {
      project = config.load();
    } catch (e) {
      throw new Error(`reload config: ${(e as Error).message}`);
    }
  }
}

/** `knowns settings --global`: defaults for future `knowns init` runs. */
export async function runGlobalSettings(d: SettingsDeps): Promise<void> {
  const { defaultProjectSettings } = await import("../../models/config.ts");
  const store = new EmbeddingSettingsStore(join(userHomeDir(d.env), ".knowns", "settings.json"));
  const settings = store.load();
  if (!settings.projectDefaults) {
    const fresh = defaultProjectSettings();
    // Go marshals a map with its keys sorted.
    fresh.statusColors = Object.fromEntries(
      Object.entries(fresh.statusColors ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    settings.projectDefaults = { settings: fresh as unknown as Record<string, never> };
  }
  const defaults = settings.projectDefaults;
  const s = defaults.settings as unknown as SettingsLike;

  for (;;) {
    let choice: string;
    try {
      choice = await d.prompter.select({
        title: "Global Settings",
        description: "Defaults for new projects created by knowns init",
        options: [
          { label: "Project Defaults", value: "project" },
          { label: "Default Git Tracking", value: "git" },
          { label: "Default AI Platforms", value: "platforms" },
          { label: "Default Search", value: "search" },
          { label: "Default Code Intelligence", value: "code" },
          { label: "Done", value: "done" },
        ],
        value: "project",
      });
    } catch (e) {
      if (isUserAborted(e)) {
        d.print("Aborted.\n");
        return;
      }
      throw e;
    }

    switch (choice) {
      case "done":
        store.save(settings);
        d.print(`${renderSuccess("Global settings saved.")}\n`);
        d.print(`${renderHint("Run: knowns init to use these defaults in a new project.")}\n`);
        return;
      case "project": {
        const name = await ask(() =>
          d.prompter.input({
            title: "Default project name",
            description: "Leave blank to use the directory name.",
            value: defaults.projectName ?? "",
          }),
        );
        if (name === undefined) return; // Go returns nil from runGlobalSettings: nothing is saved.
        const prefix = await ask(() =>
          d.prompter.input({
            title: "Default Task ID prefix",
            description: "2-8 alphanumeric characters, e.g. KN. Leave blank for legacy IDs.",
            value: typeof s.defaultTaskIdPrefix === "string" ? s.defaultTaskIdPrefix : "",
            validate: prefixProblem,
          }),
        );
        if (prefix === undefined) return;
        const trimmed = name.trim();
        if (trimmed === "") delete defaults.projectName;
        else defaults.projectName = trimmed;
        if (prefix === "") delete s.defaultTaskIdPrefix;
        else s.defaultTaskIdPrefix = prefix;
        break;
      }
      case "git":
        await configureGitTrackingSettings(d, s);
        break;
      case "platforms":
        await configurePlatformSettings(d, s, true);
        break;
      case "search":
        await configureSemanticDefaults(d, s);
        break;
      case "code":
        await configureLspSettings(d, s);
        break;
    }
    store.save(settings);
  }
}
