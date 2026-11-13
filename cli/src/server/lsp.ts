// internal/server/server.go (lspRuntimeStatuses) and internal/server/routes/lsp.go: the LSP
// language management routes, backed by the shared LSP daemon with a local Manager fallback.
import { all as allAdapters } from "../lsp/adapters/index.ts";
import { Config } from "../lsp/config.ts";
import { languageInfoFromRuntimeStatus, Manager } from "../lsp/manager.ts";
import {
  type LanguageInfo,
  type LanguageRuntimeStatus,
  RuntimeInstallInstalled,
} from "../lsp/types.ts";
import {
  annotateLocalStatuses,
  type Client,
  DaemonError,
  DaemonStateDisabledByEnv,
  DaemonStateUnavailable,
  disabledByEnv,
  disabledWarning,
  ensureClient,
  leaseTTLFromEnv,
} from "../lspdaemon/index.ts";
import type { Project } from "../models/config.ts";
import type { Storage } from "../storage/adapters.ts";
import { EmbeddingSettingsStore } from "../storage/stores/embedding-settings-store.ts";
import type { App } from "./app.ts";
import {
  errMessage,
  jsonResponse,
  type Ctx as RouteCtx,
  type Router,
  respondError,
} from "./http.ts";
import { atoi, type Obj, readStruct } from "./routes/support.ts";

export function projectDefaults(): { settings?: unknown } | undefined {
  try {
    return new EmbeddingSettingsStore().load().projectDefaults ?? undefined;
  } catch {
    return undefined;
  }
}

/** NewServer's manager setup: every built-in and plugin adapter registered. */
export function createLspManager(root: string, project: Project, dev: boolean): Manager {
  const manager = new Manager(root, Config.fromProject(project, projectDefaults()));
  for (const adapter of allAdapters()) {
    try {
      manager.registerAdapter(adapter);
    } catch (e) {
      if (dev)
        console.error(`warn: could not register LSP adapter ${adapter.id()}: ${errMessage(e)}`);
    }
  }
  for (const err of manager.registerPluginAdapters({})) {
    if (dev) console.error(`warn: could not load LSP plugin adapter: ${err.message}`);
  }
  return manager;
}

/** Server.lspRuntimeStatuses: daemon first, then the local manager annotated as the fallback. */
export async function lspRuntimeStatuses(
  app: App,
  lspManager: Manager | undefined,
  storage: Storage | undefined,
  acquireLease: boolean,
  signal?: AbortSignal,
): Promise<LanguageRuntimeStatus[] | undefined> {
  if (!storage) return undefined;
  if (disabledByEnv()) {
    if (app.opts.dev) console.error(`[server] ${disabledWarning()}`);
    if (lspManager) {
      return annotateLocalStatuses(
        await lspManager.runtimeStatuses(signal),
        DaemonStateDisabledByEnv,
      );
    }
    return undefined;
  }
  try {
    const client = await ensureClient(signal, storage.store.projectRoot);
    if (acquireLease) {
      try {
        return await client.acquireLease(signal, "webui", leaseTTLFromEnv());
      } catch {
        // fall through to a plain status call
      }
    }
    return await client.runtimeStatuses(signal);
  } catch {
    // daemon unavailable
  }
  if (lspManager) {
    return annotateLocalStatuses(await lspManager.runtimeStatuses(signal), DaemonStateUnavailable);
  }
  return undefined;
}

const INFO_KEYS: [key: string, always: boolean][] = [
  ["id", true],
  ["name", true],
  ["enabled", true],
  ["detected", true],
  ["status", false],
  ["binary", true],
  ["binaryPath", false],
  ["source", false],
  ["installed", true],
  ["running", true],
  ["installState", false],
  ["runningState", false],
  ["readinessState", false],
  ["version", false],
  ["requestedVersion", false],
  ["resolvedVersion", false],
  ["sourceLocation", false],
  ["integrity", false],
  ["installedAt", false],
  ["verified", true],
  ["cachePath", false],
  ["selectedPath", false],
  ["cleanupEligible", false],
  ["installError", false],
  ["updateError", false],
  ["installHint", false],
  ["backend", false],
  ["backendSource", false],
  ["projectPath", false],
  ["projectKind", false],
  ["logPath", false],
  ["attempts", false],
  ["traceEnabled", false],
  ["owner", false],
  ["daemonState", false],
  ["daemonPid", false],
  ["daemonClients", false],
  ["daemonTransport", false],
  ["daemonEndpoint", false],
  ["daemonIdleDeadline", false],
  ["daemonLeaseCount", false],
  ["daemonLeaseOwners", false],
  ["capabilitiesKnown", false],
  ["capabilities", false],
  ["advertisedCapabilities", false],
  ["observedCapabilities", false],
  ["requiredCapabilities", false],
  ["missingCapabilities", false],
];

/** lsp.LanguageInfo as Go marshals it. */
export function languageInfoJson(info: LanguageInfo): Obj {
  const src = info as unknown as Obj;
  const out: Obj = {};
  for (const [k, always] of INFO_KEYS) {
    const v = src[k];
    if (!always && (v === undefined || v === null || v === "" || v === false || v === 0)) continue;
    if (!always && Array.isArray(v) && v.length === 0) continue;
    out[k] = always ? (v ?? (k === "binary" ? "" : false)) : v;
  }
  return out;
}

const langInfosFromStatuses = (statuses: LanguageRuntimeStatus[]): LanguageInfo[] =>
  statuses.map((s) => {
    const info = languageInfoFromRuntimeStatus(s);
    if (s.install_state !== RuntimeInstallInstalled) info.installHint = s.install_cmd;
    return info;
  });

const annotateInfos = (infos: LanguageInfo[], state: string): LanguageInfo[] => {
  for (const i of infos) {
    i.owner = "local";
    i.daemonState = state;
  }
  return infos;
};

export function registerLsp(r: Router, app: App, getManager: () => Manager | undefined): void {
  const lspEvent = (language: string, status: string, action: string) =>
    app.sse.broadcast({ type: "lsp:language", data: { language, status, action } });

  const daemonClient = async (
    signal: AbortSignal | undefined,
  ): Promise<{ client?: Client; error?: unknown }> => {
    const storage = app.storage();
    if (!storage || disabledByEnv()) return {};
    try {
      const client = await ensureClient(signal, storage.store.projectRoot);
      try {
        await client.acquireLease(signal, "webui", leaseTTLFromEnv());
      } catch {
        // best effort
      }
      return { client };
    } catch (error) {
      return { error };
    }
  };
  const unavailable = (e: unknown): Response | undefined =>
    e instanceof DaemonError ? respondError(503, e.message) : undefined;

  const daemonStatuses = async (
    signal: AbortSignal | undefined,
  ): Promise<LanguageRuntimeStatus[] | undefined> => {
    const mgr = getManager();
    if (disabledByEnv()) {
      if (!mgr) return undefined;
      return annotateLocalStatuses(await mgr.runtimeStatuses(signal), DaemonStateDisabledByEnv);
    }
    const { client, error } = await daemonClient(signal);
    if (error) {
      if (!mgr) return undefined;
      return annotateLocalStatuses(await mgr.runtimeStatuses(signal), DaemonStateUnavailable);
    }
    if (!client) return undefined;
    try {
      return await client.runtimeStatuses(signal);
    } catch {
      return undefined;
    }
  };

  const languageInfo = async (lang: string): Promise<LanguageInfo | undefined> =>
    (await getManager()?.availableLanguages())?.find((i) => i.id === lang);

  const refreshConfig = (project: Project): void => {
    getManager()?.setConfig(Config.fromProject(project, projectDefaults()));
  };

  const languageAction = async (
    lang: string,
    action: string,
    actionErr: unknown,
    fields: Obj = {},
  ): Promise<Response> => {
    const info = await languageInfo(lang);
    let status = info?.status || "unknown";
    if (actionErr && status === "unknown") status = "error";
    const infoJson = info ? languageInfoJson(info) : languageInfoJson(emptyInfo());
    const payload: Obj = {
      language: lang,
      status,
      action,
      info: infoJson,
      languageInfo: infoJson,
      ...fields,
    };
    if (actionErr) payload.error = errMessage(actionErr);
    lspEvent(lang, status, action);
    const sorted: Obj = {};
    for (const k of Object.keys(payload).sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )) {
      sorted[k] = payload[k];
    }
    return jsonResponse(200, sorted);
  };

  const noManager = (): Response => respondError(503, "LSP manager not available");
  const requireLang = (c: RouteCtx): string | Response => {
    const lang = c.params.lang as string;
    return lang === "" ? respondError(400, "language is required") : lang;
  };

  r.get("/api/lsp/languages", async (c) => {
    const mgr = getManager();
    const signal = c.req.signal;
    if (!mgr) return jsonResponse(200, { languages: null });
    if (disabledByEnv()) {
      const infos = annotateInfos(await mgr.availableLanguages(), DaemonStateDisabledByEnv);
      return jsonResponse(200, { languages: infos.map(languageInfoJson) });
    }
    const statuses = await daemonStatuses(signal);
    if (statuses)
      return jsonResponse(200, {
        languages: langInfosFromStatuses(statuses).map(languageInfoJson),
      });
    return jsonResponse(200, { languages: (await mgr.availableLanguages()).map(languageInfoJson) });
  });

  const configured = (app2: App): { storage: Storage; project: Project } | Response => {
    const storage = app2.storage();
    if (!storage) return respondError(503, "no active project");
    try {
      return { storage, project: storage.config.load() };
    } catch (e) {
      return respondError(500, `load config: ${errMessage(e)}`);
    }
  };
  const saveConfig = (storage: Storage, project: Project): Response | undefined => {
    try {
      storage.config.save(project);
    } catch (e) {
      return respondError(500, `save config: ${errMessage(e)}`);
    }
    return undefined;
  };

  const startOrStop = async (
    c: RouteCtx,
    lang: string,
    start: boolean,
  ): Promise<{ status: string } | Response> => {
    const mgr = getManager() as Manager;
    const d = await daemonClient(c.req.signal);
    if (d.error) return respondError(503, errMessage(d.error));
    if (d.client) {
      try {
        await d.client.applyConfig(c.req.signal);
      } catch (e) {
        const u = unavailable(e);
        if (u) return u;
      }
    }
    if (!start) {
      if (d.client) {
        try {
          await d.client.stopLanguage(c.req.signal, lang);
        } catch {
          // best effort
        }
      } else await mgr.stopLanguage(lang).catch(() => undefined);
      return { status: "stopped" };
    }
    try {
      if (d.client) await d.client.startLanguage(c.req.signal, lang);
      else await mgr.startLanguage(c.req.signal, lang);
      return { status: "running" };
    } catch (e) {
      if (d.client) {
        const u = unavailable(e);
        if (u) return u;
      }
      return { status: "not_installed" };
    }
  };

  r.post("/api/lsp/languages", async (c) => {
    const mgr = getManager();
    if (!mgr) return noManager();
    const body = await readStruct(c, "addLanguageRequest", { language: "string" });
    if (!body.ok) return body.res;
    const lang = (body.v.language as string | undefined) ?? "";
    if (lang === "") return respondError(400, "language is required");
    if (!(await mgr.availableLanguages()).some((a) => a.id === lang)) {
      return respondError(400, `unknown language: ${lang}`);
    }
    const cfg = configured(app);
    if (cfg instanceof Response) return cfg;
    const { storage, project } = cfg;
    project.settings.lsp ??= { languages: {} };
    project.settings.lsp.languages ??= {};
    project.settings.lsp.languages[lang] = { enabled: true };
    const saved = saveConfig(storage, project);
    if (saved) return saved;
    refreshConfig(project);
    const res = await startOrStop(c, lang, true);
    if (res instanceof Response) return res;
    lspEvent(lang, res.status, "added");
    return jsonResponse(200, { action: "added", language: lang, status: res.status });
  });

  r.put("/api/lsp/languages/{lang}", async (c) => {
    const mgr = getManager();
    if (!mgr) return noManager();
    const lang = requireLang(c);
    if (typeof lang !== "string") return lang;
    const body = await readStruct(c, "toggleLanguageRequest", { enabled: "bool" });
    if (!body.ok) return body.res;
    const enabled = body.v.enabled === true;
    const cfg = configured(app);
    if (cfg instanceof Response) return cfg;
    const { storage, project } = cfg;
    const langs = project.settings.lsp?.languages;
    if (!langs || !(lang in langs)) return respondError(404, `language not configured: ${lang}`);
    langs[lang] = { ...(langs[lang] as object), enabled };
    const saved = saveConfig(storage, project);
    if (saved) return saved;
    refreshConfig(project);
    const res = await startOrStop(c, lang, enabled);
    if (res instanceof Response) return res;
    lspEvent(lang, res.status, "toggled");
    return jsonResponse(200, { action: "toggled", language: lang, status: res.status });
  });

  r.delete("/api/lsp/languages/{lang}", async (c) => {
    const mgr = getManager();
    if (!mgr) return noManager();
    const lang = requireLang(c);
    if (typeof lang !== "string") return lang;
    const cfg = configured(app);
    if (cfg instanceof Response) return cfg;
    const { storage, project } = cfg;
    if (project.settings.lsp?.languages) delete project.settings.lsp.languages[lang];
    const saved = saveConfig(storage, project);
    if (saved) return saved;
    refreshConfig(project);
    const res = await startOrStop(c, lang, false);
    if (res instanceof Response) return res;
    lspEvent(lang, "removed", "removed");
    return jsonResponse(200, { action: "removed", language: lang, status: "removed" });
  });

  const withKnown = async (c: RouteCtx): Promise<{ mgr: Manager; lang: string } | Response> => {
    const mgr = getManager();
    if (!mgr) return noManager();
    const lang = requireLang(c);
    if (typeof lang !== "string") return lang;
    if (!(await languageInfo(lang))) return respondError(404, `unknown language: ${lang}`);
    return { mgr, lang };
  };

  r.post("/api/lsp/languages/{lang}/restart", async (c) => {
    const k = await withKnown(c);
    if (k instanceof Response) return k;
    const d = await daemonClient(c.req.signal);
    if (d.error) return respondError(503, errMessage(d.error));
    let err: unknown;
    try {
      if (d.client) await d.client.restartLanguage(c.req.signal, k.lang);
      else await k.mgr.restartLanguage(c.req.signal, k.lang);
    } catch (e) {
      err = e;
    }
    const u = unavailable(err);
    if (u) return u;
    return languageAction(k.lang, "restarted", err);
  });

  r.patch("/api/lsp/languages/{lang}/config", async (c) => {
    const k = await withKnown(c);
    if (k instanceof Response) return k;
    const body = await readStruct(c, "patchLanguageConfigRequest", {
      backend: "string",
      projectPath: "string",
      version: "string",
      binary: "string",
      settings: "object",
      apply: "bool",
    });
    if (!body.ok) return body.res;
    const v = body.v;
    if (v.binary !== undefined) {
      try {
        k.mgr.validateBinaryOverride(k.lang, v.binary as string);
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }
    const cfg = configured(app);
    if (cfg instanceof Response) return cfg;
    const { storage, project } = cfg;
    project.settings.lsp ??= { languages: {} };
    project.settings.lsp.languages ??= {};
    const settings = { ...(project.settings.lsp.languages[k.lang] ?? {}) } as Obj;
    for (const [from, to] of [
      ["backend", "backend"],
      ["projectPath", "projectPath"],
      ["version", "version"],
      ["binary", "binary"],
    ] as const) {
      if (v[from] !== undefined) {
        if (v[from] === "") delete settings[to];
        else settings[to] = v[from];
      }
    }
    if (v.settings !== undefined) {
      const merged = { ...((settings.settings as Obj | undefined) ?? {}) };
      for (const [key, value] of Object.entries(v.settings as Obj)) merged[key] = value;
      settings.settings = merged;
    }
    project.settings.lsp.languages[k.lang] = settings as never;
    const saved = saveConfig(storage, project);
    if (saved) return saved;
    refreshConfig(project);
    const d = await daemonClient(c.req.signal);
    if (d.error) return respondError(503, errMessage(d.error));
    if (d.client) {
      try {
        await d.client.applyConfig(c.req.signal);
      } catch (e) {
        const u = unavailable(e);
        if (u) return u;
      }
    }
    let applyErr: unknown;
    const apply = v.apply === true;
    if (apply) {
      try {
        if (d.client) await d.client.restartLanguage(c.req.signal, k.lang);
        else await k.mgr.restartLanguage(c.req.signal, k.lang);
      } catch (e) {
        applyErr = e;
      }
    }
    const u = unavailable(applyErr);
    if (u) return u;
    return languageAction(k.lang, "configured", applyErr, { applied: apply });
  });

  r.post("/api/lsp/languages/{lang}/install", async (c) => {
    const k = await withKnown(c);
    if (k instanceof Response) return k;
    let path = "";
    let err: unknown;
    try {
      path = await k.mgr.installLanguage(c.req.signal, k.lang);
    } catch (e) {
      err = e;
    }
    return languageAction(k.lang, "installed", err, { path });
  });

  r.post("/api/lsp/languages/{lang}/cleanup", async (c) => {
    const k = await withKnown(c);
    if (k instanceof Response) return k;
    let err: unknown;
    try {
      k.mgr.cleanupLanguage(k.lang);
    } catch (e) {
      err = e;
    }
    return languageAction(k.lang, "cleaned", err);
  });

  r.get("/api/lsp/languages/{lang}/logs", (c) => {
    const mgr = getManager();
    if (!mgr) return noManager();
    const lang = requireLang(c);
    if (typeof lang !== "string") return lang;
    const kind = c.query("kind");
    let tail = 200;
    const raw = c.query("tail");
    if (raw !== "") {
      const n = atoi(raw);
      if (n === undefined || n < 0) return respondError(400, "tail must be a non-negative integer");
      tail = n;
    }
    try {
      const t = mgr.tailLog(lang, kind, tail);
      return jsonResponse(200, {
        content: t.lines.join("\n"),
        kind: t.kind,
        language: t.language,
        lines: t.lines,
        logPath: t.path,
      });
    } catch (e) {
      return respondError(400, errMessage(e));
    }
  });

  r.post("/api/lsp/languages/{lang}/trace", async (c) => {
    const k = await withKnown(c);
    if (k instanceof Response) return k;
    const body = await readStruct(c, "traceLanguageRequest", { enabled: "bool" });
    if (!body.ok) return body.res;
    if (body.v.enabled === undefined) return respondError(400, "enabled is required");
    let path = "";
    let err: unknown;
    try {
      path = k.mgr.setTrace(k.lang, body.v.enabled as boolean);
    } catch (e) {
      err = e;
    }
    return languageAction(k.lang, "trace", err, { enabled: body.v.enabled, tracePath: path });
  });
}

function emptyInfo(): LanguageInfo {
  return {
    id: "",
    name: "",
    enabled: false,
    detected: false,
    binary: "",
    installed: false,
    running: false,
    verified: false,
  };
}
