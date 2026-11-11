// internal/server/routes: search, activities, user prefs, workspaces, notify, skills, audit.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { taskToWire } from "../../domain/tasklifecycle/wire.ts";
import type { RegistryProject } from "../../models/registry.ts";
import { goFsError, goNotExistReason } from "../../platform/goerror.ts";
import { canonicalPath } from "../../storage/core/canonical-path.ts";
import { loadMachineRegistry } from "../../storage/core/manager.ts";
import { sortKeysDeep } from "../../storage/core/util.ts";
import type { AuditFilter } from "../../storage/stores/audit-store.ts";
import { AuditStore } from "../../storage/stores/audit-store.ts";
import { goTimeJson } from "../../storage/stores/internal.ts";
import { UserPrefsStore } from "../../storage/stores/user-prefs-store.ts";
import { type App, requireStore } from "../app.ts";
import { emptyJson, errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { atoi, goMap, goTop, type Obj, readMap, readStruct } from "./support.ts";
import { attachAgent, parseIncludeHistorical, taskResponse } from "./tasks.ts";

// ---- search -----------------------------------------------------------------------------------

export function registerSearch(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);
  const limitOf = (v: string): number => {
    const n = v === "" ? undefined : atoi(v);
    return n !== undefined && n > 0 ? n : 20;
  };

  r.get(
    "/api/search",
    guard(async (c) => {
      const s = app.need();
      const limit = limitOf(c.query("limit"));
      const inc = parseIncludeHistorical(c);
      if (typeof inc === "string") return respondError(400, inc);
      const { searchWithRuntime } = await import("../../search/runtime.ts");
      const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
      let response: Awaited<ReturnType<typeof searchWithRuntime>>;
      try {
        response = await searchWithRuntime(s, buildSearchEnvironment(), {
          query: c.query("q"),
          type: c.query("type"),
          mode: c.query("mode"),
          status: c.query("status"),
          priority: c.query("priority"),
          assignee: c.query("assignee"),
          label: c.query("label"),
          tag: c.query("tag"),
          limit,
          includeHistorical: inc,
        });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      const by = (type: string) => response.results.filter((x) => x.type === type);
      const payload: Obj = {
        code: by("code"),
        decisions: by("decision"),
        docs: by("doc"),
        memories: by("memory"),
        tasks: by("task"),
      };
      if (response.runtime) payload._runtime = response.runtime;
      // map[string]interface{}: keys sorted ("_runtime" sorts before the letters).
      return jsonResponse(200, goTop(payload));
    }),
  );

  r.get(
    "/api/retrieve",
    guard(async (c) => {
      const s = app.need();
      const limit = limitOf(c.query("limit"));
      const raw = c.query("expandReferences");
      const expand = raw !== "" && (raw.toLowerCase() === "true" || raw === "1");
      const sourceTypes = c.url.searchParams.getAll("sourceType");
      const { retrieveWithRuntime } = await import("../../search/runtime.ts");
      const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
      try {
        const { response, runtime } = await retrieveWithRuntime(s, buildSearchEnvironment(), {
          query: c.query("q"),
          mode: c.query("mode"),
          limit,
          ...(sourceTypes.length > 0 && { sourceTypes }),
          expandReferences: expand,
          status: c.query("status"),
          priority: c.query("priority"),
          assignee: c.query("assignee"),
          label: c.query("label"),
          tag: c.query("tag"),
        });
        if (runtime) {
          return jsonResponse(
            200,
            goTop({
              query: response.query,
              mode: response.mode,
              candidates: response.candidates,
              contextPack: response.contextPack,
              _runtime: runtime,
            }),
          );
        }
        return jsonResponse(200, response);
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  r.get(
    "/api/resolve",
    guard(async (c) => {
      const s = app.need();
      const raw = c.query("ref");
      if (raw.trim() === "") return respondError(400, "missing ref query parameter");
      const { resolveRaw } = await import("../../cli/commands/resolve-support.ts");
      try {
        return jsonResponse(200, await resolveRaw(s, raw));
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }),
  );
}

// ---- activities, preferences, notify ------------------------------------------------------------

export function registerSmall(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);

  r.get(
    "/api/activities",
    guard(async (c) => {
      const s = app.need();
      const v = c.query("limit");
      const n = v === "" ? undefined : atoi(v);
      const limit = n !== undefined && n > 0 ? n : 20;
      try {
        const entries = s.versions.listRecentActivities(limit, c.query("type"));
        return jsonResponse(200, {
          activities:
            entries.length === 0
              ? null
              : entries.map((e) => {
                  const o: Obj = {
                    taskId: e.taskId,
                    taskTitle: e.taskTitle,
                    version: e.version,
                    timestamp: e.timestamp,
                  };
                  if (e.author) o.author = e.author;
                  o.changes =
                    e.changes === null
                      ? null
                      : e.changes.map((ch) => ({
                          field: ch.field,
                          oldValue: sortKeysDeep(ch.oldValue ?? null),
                          newValue: sortKeysDeep(ch.newValue ?? null),
                        }));
                  return o;
                }),
        });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  const prefs = new UserPrefsStore();
  r.get("/api/user-preferences", () => {
    try {
      return jsonResponse(200, prefs.load());
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });
  r.post("/api/user-preferences", async (c) => {
    let loaded: ReturnType<UserPrefsStore["load"]>;
    try {
      loaded = prefs.load();
    } catch (e) {
      return respondError(500, `load user prefs: ${errMessage(e)}`);
    }
    const m = await readMap(c);
    if (!m.ok) return m.res;
    try {
      prefs.save(loaded);
    } catch (e) {
      return respondError(500, errMessage(e));
    }
    return jsonResponse(200, loaded);
  });

  // MCP -> server notifications relayed as SSE.
  r.post(
    "/api/notify/task/{id}",
    guard((c) => {
      const s = app.need();
      try {
        const task = s.tasks.get(c.params.id as string);
        attachAgent(s, [task]);
        app.sse.broadcast({ type: "tasks:updated", data: { task: taskResponse(task) } });
      } catch {
        app.sse.broadcast({ type: "tasks:refresh", data: {} });
      }
      return jsonResponse(200, { status: "broadcast" });
    }),
  );
  r.post(
    "/api/notify/doc/*",
    guard((c) => {
      const path = (c.params["*"] as string).replace(/^\//, "");
      app.sse.broadcast({ type: "docs:updated", data: { path } });
      return jsonResponse(200, { status: "broadcast" });
    }),
  );
  r.post(
    "/api/notify/time",
    guard(async () => {
      const s = app.need();
      try {
        const { timeStateWire } = await import("./time.ts");
        app.sse.broadcast({ type: "time:updated", data: timeStateWire(s.time.getState().active) });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      return jsonResponse(200, { status: "broadcast" });
    }),
  );
  r.post(
    "/api/notify/refresh",
    guard(() => {
      app.sse.broadcast({ type: "refresh", data: { full: true } });
      return jsonResponse(200, { status: "broadcast" });
    }),
  );
}

/** A Go *PathError text; Windows tells a missing parent from a missing file. */
function fsError(op: string, path: string, e: unknown): string {
  if ((e as NodeJS.ErrnoException).code === "ENOENT") {
    return `${op} ${path}: ${goNotExistReason(existsSync(dirname(path)))}`;
  }
  return goFsError(op, path, e).message;
}

// ---- skills -------------------------------------------------------------------------------------

interface Skill {
  name: string;
  description: string;
  usage?: string;
  example?: string;
}

function parseSkill(dirName: string, content: string): Skill {
  const skill: Skill = {
    name: `/${dirName.startsWith("kn-") ? dirName.slice(3) : dirName}`,
    description: "",
  };
  let inFront = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "---") {
      inFront = !inFront;
      continue;
    }
    if (!inFront) break;
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === "name") skill.name = `/${value.startsWith("kn-") ? value.slice(3) : value}`;
      else if (key === "description") skill.description = value;
    }
  }
  let inCode = false;
  let code = "";
  for (const line of content.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (inCode) break;
      inCode = true;
      continue;
    }
    if (inCode) code += `${line}\n`;
  }
  if (code !== "") {
    let usage = code.trim();
    const idx = usage.indexOf("\n");
    if (idx > 0) usage = usage.slice(0, idx).trim();
    skill.usage = usage.replaceAll("mcp__knowns__", "");
  }
  return skill;
}

function loadSkills(projectRoot: string): Skill[] {
  const dir = join(projectRoot, ".claude", "skills");
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch (e) {
    throw new Error(`read skills dir: ${fsError("open", dir, e)}`);
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(parseSkill(entry.name, readFileSync(join(dir, entry.name, "SKILL.md"), "utf8")));
    } catch {
      // skipped, as in Go
    }
  }
  return out;
}

export function registerSkills(r: Router, app: App): void {
  r.get("/api/skills", () => {
    try {
      return jsonResponse(200, loadSkills(app.projectRoot));
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });
  r.get("/api/skills/{name}", (c) => {
    const name = c.params.name as string;
    try {
      const skill = loadSkills(app.projectRoot).find(
        (s) => s.name === name || s.name === `/${name}`,
      );
      if (skill) return jsonResponse(200, skill);
      return respondError(404, "skill not found");
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });
}

// ---- audit --------------------------------------------------------------------------------------

function auditEventJson(e: import("../../models/audit.ts").AuditEvent): Obj {
  const out: Obj = { timestamp: goTimeJson(e.timestamp), toolName: e.toolName };
  if (e.action) out.action = e.action;
  out.actionClass = e.actionClass;
  if (e.projectRoot) out.projectRoot = e.projectRoot;
  if (e.dryRun) out.dryRun = true;
  out.result = e.result;
  out.durationMs = e.durationMs;
  if (e.errorMessage) out.errorMessage = e.errorMessage;
  if (e.entityRefs && e.entityRefs.length > 0) out.entityRefs = e.entityRefs;
  // KN-4FQN0P: the agent that made the call, only for known agent clients; absent otherwise, like Go.
  if (e.client) out.client = e.client;
  if (e.argumentSummary && Object.keys(e.argumentSummary).length > 0) {
    out.argumentSummary = goMap(e.argumentSummary);
  }
  return out;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The instant a YYYY-MM-DD calendar day starts in `tz`. */
function dayStart(day: string, tz: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return undefined;
  if (tz === "UTC") return probe;
  // Find the offset of tz at that wall-clock time (two passes cover DST edges).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offsetAt = (t: number): number => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return asUtc - t;
  };
  let t = probe.getTime() - offsetAt(probe.getTime());
  t = probe.getTime() - offsetAt(t);
  return new Date(t);
}

function buildAuditFilter(c: import("../http.ts").Ctx): AuditFilter | undefined {
  const tool = c.query("tool");
  const result = c.query("result");
  const project = c.query("project");
  const from = c.query("from");
  const to = c.query("to");
  if (tool === "" && result === "" && project === "" && from === "" && to === "") return undefined;
  const filter: AuditFilter = {};
  if (tool) filter.toolName = tool;
  if (result) filter.result = result;
  if (project) filter.project = project;
  let tz = "UTC";
  const q = c.query("timezone");
  if (q !== "" && validTimeZone(q)) tz = q;
  const since = dayStart(from, tz);
  if (since) filter.since = since;
  const until = dayStart(to, tz);
  if (until) {
    // AddDate(0,0,1).Add(-1ns): the last nanosecond of the day (ms resolution here).
    const next = dayStart(nextDay(to), tz) ?? new Date(until.getTime() + 86_400_000);
    filter.until = new Date(next.getTime() - 1);
  }
  return filter;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function registerAudit(r: Router): void {
  const store = new AuditStore();
  r.get("/api/audit/recent", (c) => {
    const v = c.query("limit");
    const n = v === "" ? undefined : atoi(v);
    const limit = n !== undefined && n > 0 ? n : 50;
    try {
      const events = store.recent(limit, buildAuditFilter(c));
      return jsonResponse(200, { count: events.length, events: events.map(auditEventJson) });
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });
  r.get("/api/audit/stats", (c) => {
    try {
      return jsonResponse(200, statsJson(store.stats(buildAuditFilter(c))));
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });
  r.get("/api/audit/analytics", (c) => {
    let days = 30;
    const v = c.query("days");
    if (v !== "") {
      const n = atoi(v);
      if (n === undefined || (n !== 7 && n !== 30 && n !== 90)) {
        return respondError(400, "days must be 7, 30, or 90");
      }
      days = n;
    }
    const timezone = c.query("timezone") || "UTC";
    if (!validTimeZone(timezone)) return respondError(400, "unknown timezone");
    const scope = c.query("scope");
    const project = c.query("project");
    const allProjects = scope === "all" || (scope === "" && project === "");
    try {
      const a = store.analytics({
        days,
        timezone,
        ...(project !== "" && { project }),
        ...(allProjects && { allProjects }),
      });
      return jsonResponse(200, analyticsJson(a));
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });
}

function nilMap<T>(m: Record<string, T> | null | undefined): unknown {
  return m == null ? null : goMap(m);
}

function statsJson(s: import("../../models/audit.ts").AuditStats): Obj {
  return {
    totalCalls: s.totalCalls,
    byTool: nilMap(s.byTool),
    byActionClass: nilMap(s.byActionClass),
    byResult: nilMap(s.byResult),
    dryRunCount: s.dryRunCount,
    executeCount: s.executeCount,
    byToolResult: s.byToolResult == null ? null : goMap(s.byToolResult),
  };
}

function analyticsJson(a: import("../../models/audit.ts").AuditAnalytics): Obj {
  const cov: Obj = {};
  if (a.coverage.startDate) cov.startDate = a.coverage.startDate;
  if (a.coverage.endDate) cov.endDate = a.coverage.endDate;
  cov.partial = a.coverage.partial;
  return {
    ...statsJson(a),
    timezone: a.timezone,
    rangeStart: a.rangeStart,
    rangeEnd: a.rangeEnd,
    coverage: cov,
    dailyBuckets:
      a.dailyBuckets === null
        ? null
        : a.dailyBuckets.map((b) => {
            const o: Obj = {
              date: b.date,
              covered: b.covered,
              totalCalls: b.totalCalls,
              successCount: b.successCount,
              errorCount: b.errorCount,
              deniedCount: b.deniedCount,
              needsAttention: b.needsAttention,
              averageDurationMs: b.averageDurationMs,
            };
            if (b.topTool) o.topTool = b.topTool;
            o.topToolCalls = b.topToolCalls;
            return o;
          }),
    tools:
      a.tools === null
        ? null
        : a.tools.map((t) => ({
            tool: t.tool,
            totalCalls: t.totalCalls,
            byResult: nilMap(t.byResult),
            averageDurationMs: t.averageDurationMs,
          })),
    byProject: nilMap(a.byProject),
    needsAttention: a.needsAttention,
    averageDurationMs: a.averageDurationMs,
  };
}

// ---- workspaces ---------------------------------------------------------------------------------

function projectJson(p: RegistryProject): Obj {
  const out: Obj = { id: p.id, name: p.name, path: p.path, lastUsed: goTimeJson(p.lastUsed) };
  if (p.store) {
    const st: Obj = { name: p.store.name, project: p.store.project };
    if (p.store.remote) st.remote = p.store.remote;
    out.store = st;
  }
  if (p.machine && Object.keys(p.machine).length > 0) out.machine = sortKeysDeep(p.machine);
  return out;
}

function scanCandidates(home: string): string[] {
  const names = [
    "",
    "Projects",
    "projects",
    "Developer",
    "developer",
    "Documents",
    "Code",
    "code",
    "repos",
    "Repos",
    "workspace",
    "Workspace",
    "src",
    join("go", "src"),
    "dev",
    "Dev",
  ];
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const d = n === "" ? home : join(home, n);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    const canonical = canonicalPath(d);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    dirs.push(canonical);
  }
  return dirs;
}

export function registerWorkspaces(r: Router, app: App): void {
  r.get("/api/workspaces/browse", (c) => {
    let dir = c.query("path");
    if (dir === "") {
      const home = process.env.HOME || process.env.USERPROFILE || homedir();
      if (!home) return respondError(500, "cannot determine home directory");
      dir = home;
    }
    const absDir = resolve(dir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch (e) {
      return respondError(400, `cannot read directory: ${fsError("open", absDir, e)}`);
    }
    const result: Obj[] = [];
    for (const e of entries) {
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(join(absDir, e.name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir || e.name.startsWith(".")) continue;
      const full = join(absDir, e.name);
      let resolved = full;
      try {
        resolved = realpathSync(full);
      } catch {
        // keep full
      }
      if (resolved.startsWith("/private")) continue;
      let isProject = false;
      const kn = join(full, ".knowns");
      try {
        if (statSync(kn).isDirectory() && existsSync(join(kn, "config.json"))) isProject = true;
      } catch {
        // not a project
      }
      let hasChildren = false;
      try {
        for (const s of readdirSync(full, { withFileTypes: true })) {
          let d = s.isDirectory();
          if (s.isSymbolicLink()) {
            try {
              d = statSync(join(full, s.name)).isDirectory();
            } catch {
              d = false;
            }
          }
          if (d && !s.name.startsWith(".")) {
            hasChildren = true;
            break;
          }
        }
      } catch {
        // unreadable
      }
      result.push({ name: e.name, path: full, isProject, hasChildren });
    }
    return jsonResponse(200, result);
  });

  r.get("/api/workspaces", () => {
    const reg = app.registry;
    if (!reg) return jsonResponse(200, []);
    const projects = reg.projects;
    if (projects.length === 0) return jsonResponse(200, []);
    return jsonResponse(200, projects.filter((p) => reg.isValid(p)).map(projectJson));
  });

  r.post("/api/workspaces/switch", async (c) => {
    const body = await readStruct(c, "", { id: "string", path: "string" });
    const id = body.ok ? ((body.v.id as string | undefined) ?? "") : "";
    const path = body.ok ? ((body.v.path as string | undefined) ?? "") : "";
    if (!body.ok || (id === "" && path === "")) return respondError(400, "id or path is required");
    const reg = app.registry;
    if (!reg) return respondError(500, "registry not available");
    let projectPath = path;
    if (projectPath === "") {
      projectPath = reg.projects.find((p) => p.id === id)?.path ?? "";
      if (projectPath === "") return respondError(404, "project not found");
    }
    try {
      app.manager.switch(projectPath);
    } catch (e) {
      return respondError(500, errMessage(e));
    }
    app.sse.broadcast({ type: "refresh", data: { reason: "workspace-switch" } });
    const canonical = canonicalPath(projectPath);
    const found = reg.projects.find((p) => p.path === canonical);
    if (found) return jsonResponse(200, projectJson(found));
    return jsonResponse(200, { path: projectPath, status: "switched" });
  });

  const scanResponse = (added: RegistryProject[] | undefined): Response =>
    jsonResponse(200, !added || added.length === 0 ? [] : added.map(projectJson));

  r.post("/api/workspaces/scan", async (c) => {
    const body = await readStruct(c, "", { dirs: "strings" });
    const dirs = body.ok ? ((body.v.dirs as string[] | undefined) ?? []) : [];
    if (!body.ok || dirs.length === 0) return respondError(400, "dirs array is required");
    const reg = app.registry;
    if (!reg) return respondError(500, "registry not available");
    try {
      return scanResponse(reg.scan(dirs));
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });

  r.post("/api/workspaces/auto-scan", () => {
    const reg = app.registry;
    if (!reg) return respondError(500, "registry not available");
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    if (!home) return respondError(500, "cannot determine home directory");
    try {
      return scanResponse(reg.scan(scanCandidates(home)));
    } catch (e) {
      return respondError(500, errMessage(e));
    }
  });

  r.delete("/api/workspaces/{id}", (c) => {
    const id = c.params.id as string;
    const reg = app.registry;
    if (!reg) return respondError(500, "registry not available");
    try {
      reg.remove(id);
    } catch (e) {
      return respondError(404, errMessage(e));
    }
    return new Response(null, { status: 204 });
  });
}

void taskToWire;
void emptyJson;
void loadMachineRegistry;
