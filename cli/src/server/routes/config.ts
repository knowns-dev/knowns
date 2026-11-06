// internal/server/routes/config.go
import {
  effectiveTaskLifecycle,
  type Project,
  type ProjectSettings,
  validateProjectSettings,
} from "../../models/config.ts";
import { projectToGo, settingsToGo } from "../../storage/stores/config-store.ts";
import { type App, requireStore } from "../app.ts";
import { GoJsonError, jsonKind } from "../gojson.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { goMap, type Obj, readMap } from "./support.ts";

/** Go: json.Unmarshal(raw, &field) failure text for the field kinds this route decodes. */
function unmarshalError(raw: unknown, goType: string): string | undefined {
  const k = jsonKind(raw);
  if (k === "null") return undefined;
  const ok =
    (goType === "string" && k === "string") ||
    (goType === "bool" && k === "bool") ||
    (goType === "int" && k === "number" && Number.isInteger(raw)) ||
    (goType === "[]string" &&
      k === "array" &&
      (raw as unknown[]).every((e) => e === null || typeof e === "string")) ||
    (goType === "map[string]string" &&
      k === "object" &&
      Object.values(raw as Obj).every((e) => e === null || typeof e === "string")) ||
    (goType.startsWith("models.") && k === "object");
  if (ok) return undefined;
  if (k === "number" && goType === "int")
    return `json: cannot unmarshal number ${String(raw)} into Go value of type int`;
  return `json: cannot unmarshal ${k} into Go value of type ${goType}`;
}

function configResponse(project: Project, hardDelete: boolean): Obj {
  const s = project.settings;
  const shaped = settingsToGo(s as unknown as Obj);
  const flat: Obj = {
    name: project.name,
    id: project.id,
    createdAt: project.createdAt,
    taskLifecycle:
      shaped.taskLifecycle ??
      settingsToGo({ taskLifecycle: effectiveTaskLifecycle(s) }).taskLifecycle,
    capabilities: { taskHardDelete: hardDelete },
  };
  if (s.defaultAssignee) flat.defaultAssignee = s.defaultAssignee;
  if (s.defaultPriority) flat.defaultPriority = s.defaultPriority;
  if (s.defaultLabels != null) flat.defaultLabels = s.defaultLabels;
  flat.defaultTaskIdPrefix = s.defaultTaskIdPrefix ?? "";
  if (s.timeFormat) flat.timeFormat = s.timeFormat;
  if (s.statuses && s.statuses.length > 0) flat.statuses = s.statuses;
  if (s.statusColors != null) flat.statusColors = goMap(s.statusColors);
  if (s.visibleColumns != null) flat.visibleColumns = s.visibleColumns;
  if (s.serverPort) flat.serverPort = s.serverPort;
  if (s.platforms != null) flat.platforms = s.platforms;
  if (s.runtimeMemory != null) flat.runtimeMemory = shaped.runtimeMemory ?? {};
  if (s.semanticSearch != null) flat.semanticSearch = shaped.semanticSearch ?? {};
  if (s.lsp != null) flat.lsp = shaped.lsp ?? {};
  if (s.codeIntelligenceIgnore != null) flat.codeIntelligenceIgnore = s.codeIntelligenceIgnore;
  if (s.gitTrackingMode) flat.gitTrackingMode = s.gitTrackingMode;
  if (s.editor) flat.editor = s.editor;
  // map[string]interface{}: top-level keys sorted; nested structs keep their declared order.
  const sorted: Obj = {};
  for (const k of Object.keys(flat).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    sorted[k] = flat[k];
  }
  return { config: sorted };
}

function applyTaskLifecycle(settings: ProjectSettings, raw: unknown): void {
  if (raw === null) throw new Error("settings.taskLifecycle: must be an object");
  if (jsonKind(raw) !== "object") {
    throw new Error(
      `settings.taskLifecycle: json: cannot unmarshal ${jsonKind(raw)} into Go value of type map[string]json.RawMessage`,
    );
  }
  const effective = { ...effectiveTaskLifecycle(settings) };
  for (const [field, value] of Object.entries(raw as Obj)) {
    const fail = (kind: string): never => {
      throw new Error(`settings.taskLifecycle.${field}: must be a ${kind}`);
    };
    switch (field) {
      case "excludeDoneFromDefaultRetrieval":
      case "autoArchive": {
        if (value === null) fail("boolean");
        const e = unmarshalError(value, "bool");
        if (e) throw new Error(`settings.taskLifecycle.${field}: ${e}`);
        (effective as Obj)[field] = value;
        break;
      }
      case "archiveAfter": {
        if (value === null) fail("duration string");
        const e = unmarshalError(value, "string");
        if (e) throw new Error(`settings.taskLifecycle.${field}: ${e}`);
        effective.archiveAfter = value as string;
        break;
      }
      case "purgeAfter": {
        if (value === null) {
          effective.purgeAfter = null;
          break;
        }
        const e = unmarshalError(value, "string");
        if (e) throw new Error(`settings.taskLifecycle.${field}: ${e}`);
        effective.purgeAfter = value as string;
        break;
      }
      default:
        throw new Error(`settings.taskLifecycle.${field}: unknown field`);
    }
  }
  validateProjectSettings({ ...settings, taskLifecycle: effective });
  settings.taskLifecycle = effective;
}

const SETTING_TYPES: [key: keyof ProjectSettings | string, goType: string][] = [
  ["defaultAssignee", "string"],
  ["defaultPriority", "string"],
  ["defaultLabels", "[]string"],
  ["defaultTaskIdPrefix", "string"],
  ["timeFormat", "string"],
  ["gitTrackingMode", "string"],
  ["statuses", "[]string"],
  ["statusColors", "map[string]string"],
  ["visibleColumns", "[]string"],
  ["serverPort", "int"],
  ["semanticSearch", "models.SemanticSearchSettings"],
  ["runtimeMemory", "models.RuntimeMemorySettings"],
  ["lsp", "models.LSPSettings"],
  ["codeIntelligenceIgnore", "[]string"],
  ["editor", "string"],
];

function applySettings(settings: ProjectSettings, payload: Obj): void {
  if ("taskLifecycle" in payload) applyTaskLifecycle(settings, payload.taskLifecycle);
  const target = settings as unknown as Obj;
  for (const [key, goType] of SETTING_TYPES) {
    if (!(key in payload)) continue;
    const raw = payload[key];
    const e = unmarshalError(raw, goType);
    if (e) throw new Error(e);
    if (raw === null) {
      if (goType === "string" || goType === "int") continue; // null leaves a scalar unchanged
      if (key === "statuses") target[key] = null;
      else delete target[key];
      continue;
    }
    if (goType === "string" && raw === "") {
      delete target[key];
      continue;
    }
    target[key] = raw;
  }
}

export function registerConfig(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);
  const hardDelete = () => app.opts.allowTaskHardDelete === true;

  r.get(
    "/api/config",
    guard(() => {
      try {
        return jsonResponse(200, configResponse(app.need().config.load(), hardDelete()));
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  const save = guard(async (c) => {
    const s = app.need();
    let project: Project;
    try {
      project = s.config.load();
    } catch (e) {
      return respondError(500, `load config: ${errMessage(e)}`);
    }
    const m = await readMap(c);
    if (!m.ok) return m.res;
    const payload = m.v;
    try {
      if ("name" in payload) {
        const e = unmarshalError(payload.name, "string");
        if (e) throw new Error(e);
        if (payload.name !== null) project.name = payload.name as string;
      }
      if ("settings" in payload) {
        const nested = payload.settings;
        if (nested !== null && jsonKind(nested) !== "object") {
          throw new Error(
            `json: cannot unmarshal ${jsonKind(nested)} into Go value of type map[string]json.RawMessage`,
          );
        }
        applySettings(project.settings, (nested ?? {}) as Obj);
      }
      applySettings(project.settings, payload);
    } catch (e) {
      if (e instanceof GoJsonError || e instanceof Error) {
        return respondError(400, `invalid request body: ${e.message}`);
      }
      throw e;
    }
    try {
      validateProjectSettings(project.settings);
    } catch (e) {
      return respondError(400, `invalid request body: ${errMessage(e)}`);
    }
    try {
      s.config.save(project);
    } catch (e) {
      return respondError(500, errMessage(e));
    }
    if (c.method === "POST") {
      return jsonResponse(200, projectToGo(project as unknown as Obj));
    }
    return jsonResponse(200, configResponse(project, hardDelete()));
  });
  r.post("/api/config", save);
  r.patch("/api/config", save);
}
