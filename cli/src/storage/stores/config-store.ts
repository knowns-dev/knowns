// Port of internal/storage/config_store.go: .knowns/config.json read/write.
//
// Every writer emits the canonical form (sorted keys, two-space indent, trailing newline), so a
// struct write (save) and a raw-map write (set) of the same content produce the same bytes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultProjectSettings,
  defaultTaskLifecycleSettings,
  normalizeProjectSettings,
  type Project,
  projectSchema,
  validateProjectSettings,
} from "../../models/config.ts";
import { parseBoundary } from "../../schema/index.ts";
import {
  decodeGenericObject,
  getNestedKey,
  sanitizeFileSlug,
  setNestedKey,
  writeCanonicalJson,
} from "../core/util.ts";
import { ConfigSplit } from "./config-split.ts";
import { dropNulls, type JsonObject, plainNumbers, type Spec, shapeStruct } from "./go-shape.ts";
import { currentSchemaVersion } from "./migrations.ts";

// --- Go struct marshalling for Project / ProjectSettings -------------------------------------

const VECTOR_RETENTION: Spec = [
  ["previousGenerations", "ptr"],
  ["previousGenerationTTL", "str"],
];
const VECTOR_STORE: Spec = [
  ["backend", "str"],
  ["mode", "str"],
  ["externalURL", "str"],
  ["managedRoot", "str"],
  ["install", "str"],
  ["retention", { spec: VECTOR_RETENTION }],
];
const SEMANTIC_SEARCH: Spec = [
  ["enabled", "bool"],
  ["model", { req: "" }],
  ["provider", "str"],
  ["huggingFaceId", "str"],
  ["dimensions", "int"],
  ["maxTokens", "int"],
  ["vectorStore", { spec: VECTOR_STORE }],
];
const GIT_TRACKING: Spec = [
  ["tasks", "ptr"],
  ["docs", "ptr"],
  ["templates", "ptr"],
  ["memories", "ptr"],
  ["decisions", "ptr"],
];
const RUNTIME_MEMORY: Spec = [
  ["mode", "str"],
  ["capture", "str"],
  ["maxItems", "int"],
  ["maxBytes", "int"],
];
const RUNTIME_WATCH: Spec = [
  ["enabled", "ptr"],
  ["eligibleClients", "list"],
  ["gracePeriod", "str"],
];
const LSP_LANGUAGE: Spec = [
  ["enabled", "ptr"],
  ["binary", "str"],
  ["version", "str"],
  ["backend", "str"],
  ["projectPath", "str"],
  ["settings", "map"],
];
const LSP: Spec = [
  ["enabled", "ptr"],
  ["languages", { mapOf: LSP_LANGUAGE }],
];
const TASK_LIFECYCLE: Spec = [
  ["excludeDoneFromDefaultRetrieval", { req: true }],
  ["autoArchive", { req: true }],
  ["archiveAfter", { req: "30d" }],
  ["purgeAfter", { req: null }],
];
const SETTINGS: Spec = [
  ["defaultAssignee", "str"],
  ["defaultPriority", { req: "" }],
  ["defaultLabels", "list"],
  ["defaultTaskIdPrefix", "str"],
  ["taskLifecycle", { spec: TASK_LIFECYCLE }],
  ["codeIntelligenceIgnore", "list"],
  ["timeFormat", "str"],
  ["editor", "str"],
  ["gitTrackingMode", "str"],
  ["gitTracking", { spec: GIT_TRACKING }],
  ["statuses", { req: null }],
  ["statusColors", "map"],
  ["visibleColumns", "list"],
  ["semanticSearch", { spec: SEMANTIC_SEARCH }],
  ["serverPort", "int"],
  ["platforms", "list"],
  ["runtimeMemory", { spec: RUNTIME_MEMORY }],
  ["runtimeWatch", { spec: RUNTIME_WATCH }],
  ["permissions", "ptr"],
  ["skillsScope", "str"],
  ["lsp", { spec: LSP }],
];
const PROJECT: Spec = [
  ["name", { req: "" }],
  ["id", { req: "" }],
  ["createdAt", { req: "" }],
  ["settings", { spec: SETTINGS }],
  ["schemaVersion", "int"],
];

/** The JSON Go writes for a models.ProjectSettings (a decoded settings object). */
export function settingsToGo(settings: JsonObject): JsonObject {
  const src = { ...settings };
  const tl = src.taskLifecycle;
  if (tl !== null && typeof tl === "object" && !Array.isArray(tl)) {
    src.taskLifecycle = { ...defaultTaskLifecycleSettings(), ...(tl as JsonObject) };
  }
  return shapeStruct(src, SETTINGS);
}

/** The JSON Go writes for a models.Project: unknown keys dropped, omitempty applied. */
export function projectToGo(project: JsonObject): JsonObject {
  const src = { ...project };
  const out = shapeStruct({ ...src, settings: src.settings ?? {} }, PROJECT);
  out.settings = settingsToGo((src.settings ?? {}) as JsonObject);
  return out;
}

/** json.Unmarshal into models.Project, then Normalize + Validate. */
/** models.Project zero values: "" strings, time.Time{} and an empty settings struct. */
const GO_PROJECT_ZERO: ReadonlyArray<readonly [string, () => JsonObject[string]]> = [
  ["name", () => ""],
  ["id", () => ""],
  ["createdAt", () => "0001-01-01T00:00:00Z"],
  ["settings", () => ({})],
];

function parseProject(raw: JsonObject, what: string): Project {
  const plain = plainNumbers(raw) as JsonObject;
  // json.Unmarshal leaves absent or null fields at their zero value, so Go accepts `{}`.
  for (const [key, zero] of GO_PROJECT_ZERO) {
    if (plain[key] === undefined || plain[key] === null) plain[key] = zero();
  }
  if (plain.settings !== null && typeof plain.settings === "object") {
    plain.settings = dropNulls(plain.settings as JsonObject);
  }
  const parsed = parseBoundary(projectSchema, plain, what);
  return { ...parsed, settings: checkSettings(parsed.settings) };
}

function checkSettings(s: Project["settings"]): Project["settings"] {
  let normalized: Project["settings"];
  try {
    normalized = normalizeProjectSettings(s);
  } catch (e) {
    throw new Error(`normalize config: ${(e as Error).message}`);
  }
  try {
    validateProjectSettings(normalized);
  } catch (e) {
    throw new Error(`validate config: ${(e as Error).message}`);
  }
  return normalized;
}

/** ConfigStore reads and writes .knowns/config.json. */
export class ConfigStore {
  private readonly split: ConfigSplit | undefined;

  /**
   * @param root        knowledge root holding config.json
   * @param projectRoot set for a store-linked project: personal and machine settings then live
   *                    outside config.json (see ConfigSplit)
   */
  constructor(
    readonly root: string,
    projectRoot?: string,
  ) {
    this.split = projectRoot === undefined ? undefined : new ConfigSplit(projectRoot);
  }

  get configPath(): string {
    return join(this.root, "config.json");
  }

  /** Load: parse, normalize and validate the project configuration (BOM tolerant). */
  load(): Project {
    return parseProject(this.loadMerged(), "config");
  }

  /** Save: write the project configuration (struct semantics: unknown keys are dropped). */
  save(project: Project): void {
    const settings = checkSettings(project.settings);
    const next = { ...project, settings } as unknown as JsonObject;
    const generic = projectToGo(next);
    if (!this.split) {
      writeCanonicalJson(this.configPath, generic);
      return;
    }
    this.writeTeam(generic);
  }

  /** Get: a value by dot-notation key (e.g. "settings.serverPort"), re-reading from disk. */
  get(key: string): unknown {
    const raw = this.loadMerged();
    const r = getNestedKey(raw, key);
    if (!r.found) throw new Error(`config key "${key}" not found`);
    return r.value;
  }

  /** Set: update one dot-notation key and persist, keeping unknown fields. */
  set(key: string, value: unknown): void {
    const raw = this.loadMerged();
    setNestedKey(raw, key, value);
    const project = parseProject(raw, "config for validation");
    const prefix = project.settings.defaultTaskIdPrefix ?? "";
    if (key === "settings.defaultTaskIdPrefix" || prefix !== "") {
      setNestedKey(raw, "settings.defaultTaskIdPrefix", prefix);
    }
    this.writeTeam(raw);
  }

  private writeTeam(raw: JsonObject): void {
    this.split?.storeOwned(raw);
    writeCanonicalJson(this.configPath, raw);
  }

  private loadMerged(): JsonObject {
    const raw = this.loadRaw();
    this.split?.overlay(raw);
    return raw;
  }

  private loadRaw(): JsonObject {
    let text: string;
    try {
      text = readFileSync(this.configPath, "utf8");
    } catch (e) {
      throw new Error(`load config: ${(e as Error).message}`);
    }
    try {
      return decodeGenericObject(text);
    } catch (e) {
      throw new Error(`parse config: ${(e as Error).message}`);
    }
  }

  /** initDefault: a minimal default config.json for a new project (what Store.init writes). */
  initDefault(name: string): void {
    const n = name === "" ? "knowns" : name;
    const project = {
      name: n,
      id: sanitizeFileSlug(n),
      createdAt: new Date().toISOString(),
      settings: defaultProjectSettings(),
      schemaVersion: currentSchemaVersion(),
    };
    writeCanonicalJson(this.configPath, projectToGo(project as unknown as JsonObject));
  }
}
