// Port of internal/models/config.go (and the PermissionConfig it embeds).
//
// config.json is read by Go as a generic map and rewritten with sorted keys, so unknown keys at any
// level survive a read/write round trip. Every object schema here is therefore `looseObject`.
import { z } from "zod";
import { int, timestampSchema } from "./common.ts";
import { parseGoDuration, parseTaskLifecycleDuration } from "./duration.ts";
import { normalizeTaskIdPrefix } from "./id.ts";
import { DEFAULT_STATUSES } from "./task.ts";

export const permissionRuleSchema = z.looseObject({
  capability: z.string(),
  target: z.string().optional(),
  condition: z.record(z.string(), z.string()).optional(),
  /** "allow" or "deny". */
  effect: z.string(),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const permissionConfigSchema = z.looseObject({
  preset: z.string().optional(),
  rules: z.array(permissionRuleSchema).optional(),
});
export type PermissionConfig = z.infer<typeof permissionConfigSchema>;

export const lspLanguageSettingsSchema = z.looseObject({
  enabled: z.boolean().optional(),
  binary: z.string().optional(),
  version: z.string().optional(),
  backend: z.string().optional(),
  projectPath: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type LSPLanguageSettings = z.infer<typeof lspLanguageSettingsSchema>;

export const lspSettingsSchema = z.looseObject({
  enabled: z.boolean().optional(),
  languages: z.record(z.string(), lspLanguageSettingsSchema).optional(),
});
export type LSPSettings = z.infer<typeof lspSettingsSchema>;

/** A missing value means "use the default for this section" (memories off, everything else on). */
export const gitTrackingSchema = z.looseObject({
  tasks: z.boolean().optional(),
  docs: z.boolean().optional(),
  templates: z.boolean().optional(),
  memories: z.boolean().optional(),
  decisions: z.boolean().optional(),
});
export type GitTracking = z.infer<typeof gitTrackingSchema>;

export function gitTrackingDefaults(): Required<GitTracking> {
  return { tasks: true, docs: true, templates: true, memories: false, decisions: true };
}

/** GitTrackingModeDefaults: "git-ignored" and every other mode share the same defaults. */
export function gitTrackingModeDefaults(_mode: string): Required<GitTracking> {
  return gitTrackingDefaults();
}

export const SKILLS_SCOPES = ["project", "global", "none"] as const;
export type SkillsScope = (typeof SKILLS_SCOPES)[number];

/** NormalizeSkillsScope: "" stays "" so an unset setting is never written back. */
export function normalizeSkillsScope(scope: string): SkillsScope | "" {
  const v = scope.trim().toLowerCase();
  if (v === "") return "";
  if ((SKILLS_SCOPES as readonly string[]).includes(v)) return v as SkillsScope;
  throw new Error(`unknown scope "${scope}", want "project", "global", or "none"`);
}

/** ResolveSkillsScope: project scope, then the global default, then "project". */
export function resolveSkillsScope(projectScope: string, globalScope: string): SkillsScope {
  for (const raw of [projectScope, globalScope]) {
    try {
      const scope = normalizeSkillsScope(raw);
      if (scope !== "") return scope;
    } catch {
      // An unreadable value falls through to the next link in the chain, as in Go.
    }
  }
  return "project";
}

// --- Task lifecycle -------------------------------------------------------------------------

/**
 * TaskLifecycleSettings. Go's custom UnmarshalJSON starts from the defaults, so a partial block
 * keeps the omitted defaults: this schema applies the same defaults while parsing.
 */
export const taskLifecycleSettingsSchema = z.looseObject({
  excludeDoneFromDefaultRetrieval: z.boolean().default(true),
  autoArchive: z.boolean().default(true),
  archiveAfter: z.string().default("30d"),
  /** null (or absent) disables purging. */
  purgeAfter: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
export type TaskLifecycleSettings = z.infer<typeof taskLifecycleSettingsSchema>;

export function defaultTaskLifecycleSettings(): TaskLifecycleSettings {
  return {
    excludeDoneFromDefaultRetrieval: true,
    autoArchive: true,
    archiveAfter: "30d",
    purgeAfter: null,
  };
}

// --- Runtime settings -----------------------------------------------------------------------

export const runtimeMemorySettingsSchema = z.looseObject({
  /** off, auto, manual, debug. */
  mode: z.string().optional(),
  capture: z.string().optional(),
  maxItems: int.optional(),
  maxBytes: int.optional(),
});
export type RuntimeMemorySettings = z.infer<typeof runtimeMemorySettingsSchema>;

export const runtimeWatchSettingsSchema = z.looseObject({
  enabled: z.boolean().optional(),
  eligibleClients: z.array(z.string()).optional(),
  gracePeriod: z.string().optional(),
});
export type RuntimeWatchSettings = z.infer<typeof runtimeWatchSettingsSchema>;

export function defaultRuntimeWatchSettings(): Required<RuntimeWatchSettings> {
  return { enabled: true, eligibleClients: ["mcp", "opencode"], gracePeriod: "30s" };
}

// --- Semantic search ------------------------------------------------------------------------

export const SEMANTIC_VECTOR_BACKEND_QDRANT = "qdrant";
export const SEMANTIC_VECTOR_BACKEND_SQLITE = "sqlite";
export const SEMANTIC_VECTOR_BACKEND_NONE = "none";
export const SEMANTIC_VECTOR_STORE_MODE_MANAGED = "managed";
export const SEMANTIC_VECTOR_STORE_MODE_EXTERNAL = "external";
export const SEMANTIC_VECTOR_STORE_INSTALL_LAZY = "lazy";
export const SEMANTIC_VECTOR_STORE_INSTALL_NOW = "now";

export const DEFAULT_SEMANTIC_VECTOR_SCHEMA_VERSION = 1;
export const DEFAULT_SEMANTIC_VECTOR_BACKEND = SEMANTIC_VECTOR_BACKEND_QDRANT;
export const DEFAULT_SEMANTIC_VECTOR_MODE = SEMANTIC_VECTOR_STORE_MODE_MANAGED;
export const DEFAULT_SEMANTIC_VECTOR_INSTALL = SEMANTIC_VECTOR_STORE_INSTALL_LAZY;
export const DEFAULT_SEMANTIC_MANAGED_ROOT = "~/.knowns/runtime/qdrant";
export const DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS = 1;
export const DEFAULT_SEMANTIC_VECTOR_RETENTION_TTL = "72h";

export const ENV_SEMANTIC_VECTOR_ENABLED = "KNOWNS_SEMANTIC_VECTOR_ENABLED";
export const ENV_SEMANTIC_VECTOR_BACKEND = "KNOWNS_SEMANTIC_VECTOR_BACKEND";
export const ENV_SEMANTIC_VECTOR_MODE = "KNOWNS_SEMANTIC_VECTOR_MODE";
export const ENV_SEMANTIC_VECTOR_INSTALL = "KNOWNS_SEMANTIC_VECTOR_INSTALL";
export const ENV_SEMANTIC_VECTOR_MANAGED_ROOT = "KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT";
export const ENV_QDRANT_URL = "KNOWNS_QDRANT_URL";
export const ENV_SEMANTIC_QDRANT_URL = "KNOWNS_SEMANTIC_QDRANT_URL";

export const semanticVectorStoreRetentionSettingsSchema = z.looseObject({
  /** undefined inherits the default; an explicit 0 disables rollback retention. */
  previousGenerations: int.optional(),
  previousGenerationTTL: z.string().optional(),
});
export type SemanticVectorStoreRetentionSettings = z.infer<
  typeof semanticVectorStoreRetentionSettingsSchema
>;

export const semanticVectorStoreSettingsSchema = z.looseObject({
  backend: z.string().optional(),
  mode: z.string().optional(),
  externalURL: z.string().optional(),
  managedRoot: z.string().optional(),
  install: z.string().optional(),
  retention: semanticVectorStoreRetentionSettingsSchema.optional(),
});
export type SemanticVectorStoreSettings = z.infer<typeof semanticVectorStoreSettingsSchema>;

export const semanticSearchSettingsSchema = z.looseObject({
  enabled: z.boolean().optional(),
  model: z.string().default(""),
  /** "ollama" or "api"; legacy "local"/empty resolves to ollama on read. */
  provider: z.string().optional(),
  /** Legacy field from the removed local backend; kept so old configs load. */
  huggingFaceId: z.string().optional(),
  dimensions: int.optional(),
  maxTokens: int.optional(),
  vectorStore: semanticVectorStoreSettingsSchema.optional(),
});
export type SemanticSearchSettings = z.infer<typeof semanticSearchSettingsSchema>;

export function defaultSemanticVectorStoreRetentionSettings(): Required<SemanticVectorStoreRetentionSettings> {
  return {
    previousGenerations: DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS,
    previousGenerationTTL: DEFAULT_SEMANTIC_VECTOR_RETENTION_TTL,
  };
}

export function defaultSemanticVectorStoreSettings(): SemanticVectorStoreSettings {
  return {
    backend: DEFAULT_SEMANTIC_VECTOR_BACKEND,
    mode: DEFAULT_SEMANTIC_VECTOR_MODE,
    managedRoot: DEFAULT_SEMANTIC_MANAGED_ROOT,
    install: DEFAULT_SEMANTIC_VECTOR_INSTALL,
    retention: defaultSemanticVectorStoreRetentionSettings(),
  };
}

/** DeclaredSemanticVectorStoreSettingsPtr: what `knowns init` writes (backend and mode only). */
export function declaredSemanticVectorStoreSettings(): SemanticVectorStoreSettings {
  return { backend: DEFAULT_SEMANTIC_VECTOR_BACKEND, mode: DEFAULT_SEMANTIC_VECTOR_MODE };
}

export interface SemanticVectorStoreResolution {
  enabled: boolean;
  optedOut: boolean;
  backend: string;
  mode: string;
  externalURL: string;
  managedRoot: string;
  install: string;
  retention: SemanticVectorStoreRetentionSettings;
}

/** envBool: the same truthy spellings Go accepts. */
export function envBool(v: string): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(v.trim().toLowerCase());
}

function mergeVectorStoreSettings(
  dst: SemanticVectorStoreSettings,
  src: SemanticVectorStoreSettings | undefined,
) {
  if (!src) return;
  if (src.backend) dst.backend = src.backend;
  if (src.mode) dst.mode = src.mode;
  if (src.externalURL) dst.externalURL = src.externalURL;
  if (src.managedRoot) dst.managedRoot = src.managedRoot;
  if (src.install) dst.install = src.install;
  if (src.retention) {
    const r: SemanticVectorStoreRetentionSettings = {
      ...(dst.retention ?? defaultSemanticVectorStoreRetentionSettings()),
    };
    if (src.retention.previousGenerations !== undefined) {
      r.previousGenerations = src.retention.previousGenerations;
    }
    if (src.retention.previousGenerationTTL)
      r.previousGenerationTTL = src.retention.previousGenerationTTL;
    dst.retention = r;
  }
}

/**
 * ResolveSemanticVectorStore: env override > project config > global settings > defaults.
 * `lookup` defaults to process.env.
 */
export function resolveSemanticVectorStore(
  project: SemanticSearchSettings | undefined,
  global: SemanticSearchSettings | undefined,
  lookup: (key: string) => string | undefined = (k) => process.env[k],
): SemanticVectorStoreResolution {
  const get = (k: string) => (lookup(k) ?? "").trim();
  const vs = defaultSemanticVectorStoreSettings();
  vs.retention = defaultSemanticVectorStoreRetentionSettings();

  let enabled = false;
  let optedOut = false;
  if (project) enabled = project.enabled ?? false;
  else if (global) enabled = global.enabled ?? false;

  if (project && !(project.enabled ?? false)) optedOut = true;
  else if (!project && global && !(global.enabled ?? false)) optedOut = true;

  if (global) mergeVectorStoreSettings(vs, global.vectorStore);
  if (project) mergeVectorStoreSettings(vs, project.vectorStore);

  let v = get(ENV_SEMANTIC_VECTOR_ENABLED);
  if (v !== "") {
    enabled = envBool(v);
    optedOut = !enabled;
  }
  v = get(ENV_SEMANTIC_VECTOR_BACKEND);
  if (v !== "") vs.backend = v.toLowerCase();
  v = get(ENV_SEMANTIC_VECTOR_MODE);
  if (v !== "") vs.mode = v.toLowerCase();
  v = get(ENV_SEMANTIC_VECTOR_INSTALL);
  if (v !== "") vs.install = v.toLowerCase();
  v = get(ENV_SEMANTIC_VECTOR_MANAGED_ROOT);
  if (v !== "") vs.managedRoot = v;
  const qdrantUrl = get(ENV_QDRANT_URL);
  const semanticUrl = get(ENV_SEMANTIC_QDRANT_URL);
  if (qdrantUrl !== "") {
    vs.externalURL = qdrantUrl;
    vs.mode = SEMANTIC_VECTOR_STORE_MODE_EXTERNAL;
  } else if (semanticUrl !== "") {
    vs.externalURL = semanticUrl;
    vs.mode = SEMANTIC_VECTOR_STORE_MODE_EXTERNAL;
  }

  const res: SemanticVectorStoreResolution = {
    enabled,
    optedOut,
    backend: vs.backend ?? "",
    mode: vs.mode ?? "",
    externalURL: vs.externalURL ?? "",
    managedRoot: vs.managedRoot ?? "",
    install: vs.install ?? "",
    retention: vs.retention ?? defaultSemanticVectorStoreRetentionSettings(),
  };
  if (res.backend === SEMANTIC_VECTOR_BACKEND_NONE) {
    res.optedOut = true;
    res.enabled = false;
  }
  return res;
}

/** SemanticSearchSettings.ValidateVectorStore. */
export function validateVectorStore(s: SemanticSearchSettings | undefined): void {
  const vs = s?.vectorStore;
  if (!vs) return;
  const backend = vs.backend ?? "";
  if (!["", "qdrant", "sqlite", "none"].includes(backend)) {
    throw new Error(
      `settings.semanticSearch.vectorStore.backend: unsupported backend "${backend}"`,
    );
  }
  const mode = vs.mode ?? "";
  if (!["", "managed", "external"].includes(mode)) {
    throw new Error(`settings.semanticSearch.vectorStore.mode: unsupported mode "${mode}"`);
  }
  if (mode === "external" && (vs.externalURL ?? "").trim() === "") {
    throw new Error('settings.semanticSearch.vectorStore: mode "external" requires externalURL');
  }
  const install = vs.install ?? "";
  if (!["", "lazy", "now"].includes(install)) {
    throw new Error(
      `settings.semanticSearch.vectorStore.install: unsupported install policy "${install}"`,
    );
  }
  if (vs.retention) {
    if (vs.retention.previousGenerations !== undefined && vs.retention.previousGenerations < 0) {
      throw new Error(
        "settings.semanticSearch.vectorStore.retention.previousGenerations: must not be negative",
      );
    }
    const ttl = (vs.retention.previousGenerationTTL ?? "").trim();
    if (ttl !== "") {
      try {
        parseTaskLifecycleDuration(ttl);
      } catch (e) {
        throw new Error(
          `settings.semanticSearch.vectorStore.retention.previousGenerationTTL: ${(e as Error).message}`,
        );
      }
    }
  }
}

// --- Project settings -----------------------------------------------------------------------

export const projectSettingsSchema = z.looseObject({
  defaultAssignee: z.string().optional(),
  defaultPriority: z.string().default(""),
  defaultLabels: z.array(z.string()).optional(),
  defaultTaskIdPrefix: z.string().optional(),
  taskLifecycle: taskLifecycleSettingsSchema.optional(),
  codeIntelligenceIgnore: z.array(z.string()).optional(),
  /** "12h" or "24h". */
  timeFormat: z.string().optional(),
  editor: z.string().optional(),
  /** "git-tracked", "git-ignored", or "none". */
  gitTrackingMode: z.string().optional(),
  gitTracking: gitTrackingSchema.optional(),
  /** Go's non-omitempty `[]string`: null (nil) and [] are different on disk and are preserved. */
  statuses: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? null),
  statusColors: z.record(z.string(), z.string()).optional(),
  visibleColumns: z.array(z.string()).optional(),
  semanticSearch: semanticSearchSettingsSchema.optional(),
  serverPort: int.optional(),
  platforms: z.array(z.string()).optional(),
  runtimeMemory: runtimeMemorySettingsSchema.optional(),
  runtimeWatch: runtimeWatchSettingsSchema.optional(),
  permissions: permissionConfigSchema.optional(),
  skillsScope: z.string().optional(),
  lsp: lspSettingsSchema.optional(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

/** models.Project: the contents of .knowns/config.json. */
export const projectSchema = z.looseObject({
  name: z.string(),
  id: z.string(),
  createdAt: timestampSchema,
  settings: projectSettingsSchema,
  /** Project config schema version; zero/omitted is "legacy". Only `knowns migrate` advances it. */
  schemaVersion: int.optional(),
});
export type Project = z.infer<typeof projectSchema>;

/** ProjectSettings.Normalize: canonicalize human-friendly input in place. */
export function normalizeProjectSettings(s: ProjectSettings): ProjectSettings {
  const out = { ...s };
  try {
    const prefix = normalizeTaskIdPrefix(s.defaultTaskIdPrefix ?? "");
    if (prefix === "") delete out.defaultTaskIdPrefix;
    else out.defaultTaskIdPrefix = prefix;
  } catch (e) {
    throw new Error(`settings.defaultTaskIdPrefix: ${(e as Error).message}`);
  }
  try {
    const scope = normalizeSkillsScope(s.skillsScope ?? "");
    if (scope === "") delete out.skillsScope;
    else out.skillsScope = scope;
  } catch (e) {
    throw new Error(`settings.skillsScope: ${(e as Error).message}`);
  }
  return out;
}

export function skillsScopeOrDefault(s: Pick<ProjectSettings, "skillsScope">): SkillsScope {
  try {
    const scope = normalizeSkillsScope(s.skillsScope ?? "");
    return scope === "" ? "project" : scope;
  } catch {
    return "project";
  }
}

/** EffectiveTaskLifecycle: project block, or the built-in defaults for legacy projects. */
export function effectiveTaskLifecycle(
  s: Pick<ProjectSettings, "taskLifecycle">,
): TaskLifecycleSettings {
  return s.taskLifecycle ? { ...s.taskLifecycle } : defaultTaskLifecycleSettings();
}

/** EffectiveRuntimeWatch: omitted project watch settings resolve to the defaults. */
export function effectiveRuntimeWatch(
  s: Pick<ProjectSettings, "runtimeWatch">,
): Required<RuntimeWatchSettings> {
  const out = defaultRuntimeWatchSettings();
  const w = s.runtimeWatch;
  if (!w) return out;
  if (w.enabled !== undefined) out.enabled = w.enabled;
  if (w.eligibleClients !== undefined) out.eligibleClients = [...w.eligibleClients];
  if (w.gracePeriod) out.gracePeriod = w.gracePeriod;
  return out;
}

/** ValidateRuntimeWatch: reject malformed or negative grace periods; omitted inherits the default. */
export function validateRuntimeWatch(s: Pick<ProjectSettings, "runtimeWatch">): void {
  const grace = (s.runtimeWatch?.gracePeriod ?? "").trim();
  if (grace === "") return;
  let ns: bigint;
  try {
    ns = parseGoDuration(grace);
  } catch (e) {
    throw new Error(
      `settings.runtimeWatch.gracePeriod: invalid duration "${s.runtimeWatch?.gracePeriod}": ${(e as Error).message}`,
    );
  }
  if (ns < 0n) throw new Error("settings.runtimeWatch.gracePeriod: duration must not be negative");
}

/** ProjectSettings.Validate. */
export function validateProjectSettings(s: ProjectSettings): void {
  try {
    normalizeTaskIdPrefix(s.defaultTaskIdPrefix ?? "");
  } catch (e) {
    throw new Error(`settings.defaultTaskIdPrefix: ${(e as Error).message}`);
  }
  const lifecycle = effectiveTaskLifecycle(s);
  try {
    parseTaskLifecycleDuration(lifecycle.archiveAfter);
  } catch (e) {
    throw new Error(`settings.taskLifecycle.archiveAfter: ${(e as Error).message}`);
  }
  if (lifecycle.purgeAfter !== null) {
    try {
      parseTaskLifecycleDuration(lifecycle.purgeAfter);
    } catch (e) {
      throw new Error(`settings.taskLifecycle.purgeAfter: ${(e as Error).message}`);
    }
  }
  validateVectorStore(s.semanticSearch);
  validateRuntimeWatch(s);
}

/** DefaultProjectSettings. */
export function defaultProjectSettings(): ProjectSettings {
  return {
    defaultPriority: "medium",
    taskLifecycle: defaultTaskLifecycleSettings(),
    statuses: [...DEFAULT_STATUSES],
    statusColors: {
      todo: "gray",
      "in-progress": "blue",
      "in-review": "purple",
      done: "green",
      blocked: "red",
      "on-hold": "yellow",
      urgent: "orange",
    },
    visibleColumns: ["todo", "in-progress", "blocked", "done", "in-review"],
  };
}
