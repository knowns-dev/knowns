// Port of internal/storage/embedding_settings_store.go: the machine-level embedding provider and
// model registry at ~/.knowns/settings.json. Unknown keys on the file, on providers and on models
// survive a load/save round trip (AC-6); when any are present Go marshals through a map, so the
// object's keys come out sorted - reproduced here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  normalizeProjectSettings,
  projectSettingsSchema,
  validateProjectSettings,
} from "../../models/config.ts";
import { parseBoundary } from "../../schema/index.ts";
import { globalRootPath } from "../core/global-root.ts";
import { goJsonStringify, parseJsonPreservingNumbers } from "../core/util.ts";
import { settingsToGo } from "./config-store.ts";
import { seedDefaults } from "./embedding-registry-defaults.ts";
import { dropNulls, type JsonObject, plainNumbers, sortTopLevel } from "./go-shape.ts";

export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
}

export interface EmbeddingProvider {
  name: string;
  apiBase: string;
  apiKey?: string;
  /** seconds, default 30 */
  timeout?: number;
  /** texts per request, default 64 */
  batchSize?: number;
  retry?: RetryConfig;
  /** Fields this version does not model are kept as-is. */
  [extra: string]: unknown;
}

export interface EmbeddingModel {
  provider: string;
  model: string;
  dimensions: number;
  maxTokens?: number;
  queryPrefix?: string;
  docPrefix?: string;
  [extra: string]: unknown;
}

export interface ProjectDefaults {
  projectName?: string;
  /** models.ProjectSettings as a decoded object (round-trips without injecting zero values). */
  settings: JsonObject;
}

export interface EmbeddingSettings {
  providers: Record<string, EmbeddingProvider>;
  models: Record<string, EmbeddingModel>;
  defaultEmbeddingModel?: string;
  projectDefaults?: ProjectDefaults;
  /** Top-level keys of the file this version does not model. */
  extra?: JsonObject;
}

const PROVIDER_KNOWN = new Set(["name", "apiBase", "apiKey", "timeout", "batchSize", "retry"]);
const MODEL_KNOWN = new Set([
  "provider",
  "model",
  "dimensions",
  "maxTokens",
  "queryPrefix",
  "docPrefix",
]);
const TOP_KNOWN = new Set([
  "embeddingProviders",
  "embeddingModels",
  "defaultEmbeddingModel",
  "projectDefaults",
]);

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function extras(obj: JsonObject, known: Set<string>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) if (!known.has(k)) out[k] = v;
  return out;
}

// --- JSON codecs ------------------------------------------------------------------------------

function parseProvider(raw: unknown): EmbeddingProvider {
  if (!isObject(raw)) throw new Error("parse embedding settings: provider must be an object");
  const p = plainNumbers(raw) as JsonObject;
  const retry = isObject(p.retry) ? p.retry : {};
  return {
    ...extras(raw, PROVIDER_KNOWN),
    name: str(p.name),
    apiBase: str(p.apiBase),
    apiKey: str(p.apiKey),
    timeout: num(p.timeout),
    batchSize: num(p.batchSize),
    retry: {
      maxRetries: num(retry.maxRetries),
      initialDelay: num(retry.initialDelay),
      maxDelay: num(retry.maxDelay),
    },
  };
}

function parseModel(raw: unknown): EmbeddingModel {
  if (!isObject(raw)) throw new Error("parse embedding settings: model must be an object");
  const m = plainNumbers(raw) as JsonObject;
  return {
    ...extras(raw, MODEL_KNOWN),
    provider: str(m.provider),
    model: str(m.model),
    dimensions: num(m.dimensions),
    maxTokens: num(m.maxTokens),
    queryPrefix: str(m.queryPrefix),
    docPrefix: str(m.docPrefix),
  };
}

export function providerToJson(p: EmbeddingProvider): JsonObject {
  const base: JsonObject = { name: p.name, apiBase: p.apiBase };
  if (p.apiKey) base.apiKey = p.apiKey;
  if (p.timeout) base.timeout = p.timeout;
  if (p.batchSize) base.batchSize = p.batchSize;
  const r = p.retry ?? { maxRetries: 0, initialDelay: 0, maxDelay: 0 };
  base.retry = { maxRetries: r.maxRetries, initialDelay: r.initialDelay, maxDelay: r.maxDelay };
  return mergeExtras(base, extras(p, PROVIDER_KNOWN));
}

export function modelToJson(m: EmbeddingModel): JsonObject {
  const base: JsonObject = { provider: m.provider, model: m.model, dimensions: m.dimensions };
  if (m.maxTokens) base.maxTokens = m.maxTokens;
  if (m.queryPrefix) base.queryPrefix = m.queryPrefix;
  if (m.docPrefix) base.docPrefix = m.docPrefix;
  return mergeExtras(base, extras(m, MODEL_KNOWN));
}

/** mergeExtraFields: known keys win; any extra makes Go marshal a map (sorted keys). */
function mergeExtras(base: JsonObject, extra: JsonObject): JsonObject {
  if (Object.keys(extra).length === 0) return base;
  const merged: JsonObject = { ...base };
  for (const [k, v] of Object.entries(extra)) if (!Object.hasOwn(merged, k)) merged[k] = v;
  return sortTopLevel(merged);
}

function sortedMap<T>(m: Record<string, T>, f: (v: T) => JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(m).sort(compare)) out[k] = f(m[k] as T);
  return out;
}
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function settingsToJson(s: EmbeddingSettings): JsonObject {
  const base: JsonObject = {};
  if (Object.keys(s.providers).length > 0) {
    base.embeddingProviders = sortedMap(s.providers, providerToJson);
  }
  if (Object.keys(s.models).length > 0) base.embeddingModels = sortedMap(s.models, modelToJson);
  if (s.defaultEmbeddingModel) base.defaultEmbeddingModel = s.defaultEmbeddingModel;
  if (s.projectDefaults) {
    const pd: JsonObject = {};
    if (s.projectDefaults.projectName) pd.projectName = s.projectDefaults.projectName;
    pd.settings = settingsToGo(s.projectDefaults.settings);
    base.projectDefaults = pd;
  }
  return mergeExtras(base, s.extra ?? {});
}

/** Normalize + Validate project defaults; returns the settings with canonical prefix and scope. */
function checkProjectDefaults(pd: ProjectDefaults): ProjectDefaults {
  const parsed = parseBoundary(
    projectSettingsSchema,
    dropNulls(plainNumbers(pd.settings) as JsonObject),
    "project defaults",
  );
  let normalized: ReturnType<typeof normalizeProjectSettings>;
  try {
    normalized = normalizeProjectSettings(parsed);
  } catch (e) {
    throw new Error(`normalize project defaults: ${(e as Error).message}`);
  }
  try {
    validateProjectSettings(normalized);
  } catch (e) {
    throw new Error(`validate project defaults: ${(e as Error).message}`);
  }
  const settings: JsonObject = { ...pd.settings };
  for (const key of ["defaultTaskIdPrefix", "skillsScope"] as const) {
    const v = normalized[key];
    if (v === undefined || v === "") delete settings[key];
    else settings[key] = v;
  }
  return { ...pd, settings };
}

/** EmbeddingSettingsStore reads and writes ~/.knowns/settings.json. */
export class EmbeddingSettingsStore {
  constructor(readonly filePath: string = join(globalRootPath(), "settings.json")) {}

  get path(): string {
    return this.filePath;
  }

  /**
   * Load: seeded defaults when the file is missing; otherwise the parsed file with the D2 defaults
   * merged in memory (never written). A UTF-8 BOM is tolerated.
   */
  load(): EmbeddingSettings {
    if (!existsSync(this.filePath)) {
      const settings: EmbeddingSettings = { providers: {}, models: {} };
      seedDefaults(settings);
      return settings;
    }
    let raw: unknown;
    try {
      raw = parseJsonPreservingNumbers(readFileSync(this.filePath, "utf8"));
    } catch (e) {
      throw new Error(`parse embedding settings: ${(e as Error).message}`);
    }
    if (!isObject(raw)) throw new Error("parse embedding settings: expected a JSON object");

    const settings: EmbeddingSettings = { providers: {}, models: {} };
    if (isObject(raw.embeddingProviders)) {
      for (const [k, v] of Object.entries(raw.embeddingProviders)) {
        settings.providers[k] = parseProvider(v);
      }
    }
    if (isObject(raw.embeddingModels)) {
      for (const [k, v] of Object.entries(raw.embeddingModels)) settings.models[k] = parseModel(v);
    }
    if (typeof raw.defaultEmbeddingModel === "string" && raw.defaultEmbeddingModel !== "") {
      settings.defaultEmbeddingModel = raw.defaultEmbeddingModel;
    }
    if (isObject(raw.projectDefaults)) {
      const pd = raw.projectDefaults;
      const projectDefaults: ProjectDefaults = {
        settings: isObject(pd.settings) ? pd.settings : {},
      };
      if (typeof pd.projectName === "string" && pd.projectName !== "") {
        projectDefaults.projectName = pd.projectName;
      }
      settings.projectDefaults = checkProjectDefaults(projectDefaults);
    }
    const extra = extras(raw, TOP_KNOWN);
    if (Object.keys(extra).length > 0) settings.extra = extra;
    seedDefaults(settings);
    return settings;
  }

  /** Seed: persist the merged defaults without overwriting any user entry. Idempotent. */
  seed(): EmbeddingSettings {
    const settings = this.load();
    this.save(settings);
    return settings;
  }

  /** Save: MarshalIndent, no trailing newline, mode 0644, parent directories created. */
  save(settings: EmbeddingSettings): void {
    const checked = settings.projectDefaults
      ? { ...settings, projectDefaults: checkProjectDefaults(settings.projectDefaults) }
      : settings;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o755 });
    writeFileSync(this.filePath, goJsonStringify(settingsToJson(checked)), { mode: 0o644 });
  }
}

/** GlobalSkillsScopeDefault: the machine-wide skills scope in settings.json, or "". */
export function globalSkillsScopeDefault(store = new EmbeddingSettingsStore()): string {
  try {
    const scope = store.load().projectDefaults?.settings.skillsScope;
    return typeof scope === "string" ? scope : "";
  } catch {
    return "";
  }
}

// --- EmbeddingSettings helpers -------------------------------------------------------------------

export function getProvider(s: EmbeddingSettings, id: string): EmbeddingProvider {
  const p = s.providers[id];
  if (!p || !Object.hasOwn(s.providers, id))
    throw new Error(`embedding provider "${id}" not found`);
  return p;
}

export function getModel(s: EmbeddingSettings, id: string): EmbeddingModel {
  const m = s.models[id];
  if (!m || !Object.hasOwn(s.models, id)) throw new Error(`embedding model "${id}" not found`);
  return m;
}

export function addProvider(s: EmbeddingSettings, id: string, p: EmbeddingProvider): void {
  if (Object.hasOwn(s.providers, id)) throw new Error(`embedding provider "${id}" already exists`);
  s.providers[id] = p;
}

export function updateProvider(s: EmbeddingSettings, id: string, p: EmbeddingProvider): void {
  if (!Object.hasOwn(s.providers, id)) throw new Error(`embedding provider "${id}" not found`);
  s.providers[id] = p;
}

export function removeProvider(s: EmbeddingSettings, id: string): void {
  if (!Object.hasOwn(s.providers, id)) throw new Error(`embedding provider "${id}" not found`);
  for (const [modelId, model] of Object.entries(s.models)) {
    if (model.provider === id) {
      throw new Error(`cannot remove provider "${id}": model "${modelId}" still references it`);
    }
  }
  delete s.providers[id];
}

export function addModel(s: EmbeddingSettings, id: string, model: EmbeddingModel): void {
  if (Object.hasOwn(s.models, id)) throw new Error(`embedding model "${id}" already exists`);
  if (!Object.hasOwn(s.providers, model.provider)) {
    throw new Error(
      `provider "${model.provider}" not found; register it first with 'knowns provider add'`,
    );
  }
  s.models[id] = model;
}

export function removeModel(s: EmbeddingSettings, id: string): void {
  if (!Object.hasOwn(s.models, id)) throw new Error(`embedding model "${id}" not found`);
  if (s.defaultEmbeddingModel === id) {
    throw new Error(`cannot remove model "${id}": it is the default embedding model`);
  }
  delete s.models[id];
}

export function providerDefaults(): EmbeddingProvider {
  return {
    name: "",
    apiBase: "",
    timeout: 30,
    batchSize: 64,
    retry: { maxRetries: 3, initialDelay: 1000, maxDelay: 30000 },
  };
}

/** WithDefaults: a copy with zero-value fields filled from the defaults. */
export function providerWithDefaults(p: EmbeddingProvider): EmbeddingProvider {
  const d = providerDefaults();
  const r = p.retry ?? { maxRetries: 0, initialDelay: 0, maxDelay: 0 };
  const dr = d.retry as RetryConfig;
  return {
    ...p,
    timeout: (p.timeout ?? 0) <= 0 ? d.timeout : p.timeout,
    batchSize: (p.batchSize ?? 0) <= 0 ? d.batchSize : p.batchSize,
    retry: {
      maxRetries: r.maxRetries <= 0 ? dr.maxRetries : r.maxRetries,
      initialDelay: r.initialDelay <= 0 ? dr.initialDelay : r.initialDelay,
      maxDelay: r.maxDelay <= 0 ? dr.maxDelay : r.maxDelay,
    },
  };
}
