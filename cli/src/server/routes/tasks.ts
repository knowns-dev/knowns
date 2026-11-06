// internal/server/routes/tasks.go

import { taskLifecycleSeams } from "../../cli/commands/task-lifecycle.ts";
import { findError, isNotFound as lifecycleNotFound } from "../../domain/tasklifecycle/errors.ts";
import {
  applyStatusTransition,
  FailureConflict,
  FailureDenied,
  FailureInvalidRequest,
  FailureNone,
  FailureNotFound,
  FailurePermission,
  failureKindFor,
  type Request as LifecycleRequest,
  Service,
} from "../../domain/tasklifecycle/index.ts";
import {
  eventToWire,
  historyMetadataPageToWire,
  responseToWire,
  taskToWire,
  taskVersionHistoryToWire,
  taskVersionToWire,
} from "../../domain/tasklifecycle/wire.ts";
import { normalizeTaskIdPrefix } from "../../models/id.ts";
import { type Task, taskLifecycleState } from "../../models/task.ts";
import type { Storage } from "../../storage/adapters.ts";
import { goNow } from "../../storage/history/go-json.ts";
import {
  createTaskWithHistory,
  HistoryConflictError,
  MutationConflictError,
} from "../../storage/history/index.ts";
import { type App, requireStore } from "../app.ts";
import { decodeStruct, type FieldType, jsonKind, timeField } from "../gojson.ts";
import { type Ctx, errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { atoi, type Obj, readMap, readStruct } from "./support.ts";

// ---- response shape -------------------------------------------------------------------------

/** newTaskResponse: NormalizeTask then the derived lifecycleState after the Task fields. */
export function taskResponse(task: Task): Obj {
  const wire = taskToWire(task);
  if (wire.labels === null || wire.labels === undefined) wire.labels = [];
  if (wire.acceptanceCriteria === null) wire.acceptanceCriteria = [];
  wire.lifecycleState = taskLifecycleState(task);
  return wire;
}

const TASK_FIELDS: Record<string, FieldType> = {
  id: "string",
  title: "string",
  description: "string",
  status: "string",
  priority: "string",
  assignee: "string",
  labels: "strings",
  parent: "string",
  subtasks: "strings",
  spec: "string",
  fulfills: "strings",
  order: "int",
  createdAt: timeField,
  updatedAt: timeField,
  completedAt: timeField,
  archivedAt: timeField,
  archived: "bool",
  acceptanceCriteria: {
    array: {
      custom: (v) =>
        jsonKind(v) === "object" &&
        (((v as Obj).text ?? "") === "" || typeof (v as Obj).text === "string") &&
        ((v as Obj).completed === undefined || typeof (v as Obj).completed === "boolean"),
      goName: "models.AcceptanceCriterion",
    },
    goName: "[]models.AcceptanceCriterion",
  },
  timeSpent: "int",
  timeEntries: "object",
  activeTimer: "object",
  canonicalHash: "string",
  implementationPlan: "string",
  implementationNotes: "string",
};
// timeEntries/activeTimer arrive as arrays/objects; accept loosely.
TASK_FIELDS.timeEntries = { array: "object", goName: "[]models.TimeEntry" };

const NULLABLE = new Set([
  "labels",
  "subtasks",
  "fulfills",
  "order",
  "completedAt",
  "archivedAt",
  "acceptanceCriteria",
  "timeEntries",
  "activeTimer",
]);

/** Applies a decoded Task JSON object onto `task` with json.Unmarshal semantics. */
function applyTaskJson(task: Task, fields: Obj, rawKeys: Obj): void {
  const t = task as unknown as Obj;
  for (const key of Object.keys(TASK_FIELDS)) {
    if (!(key in rawKeys)) continue;
    if (rawKeys[key] === null) {
      if (NULLABLE.has(key)) {
        if (key === "labels" || key === "acceptanceCriteria") t[key] = null;
        else delete t[key];
      }
      continue;
    }
    if (key in fields) {
      if (key === "acceptanceCriteria") {
        t[key] = (fields[key] as Obj[]).map((a) => ({
          text: (a.text as string | undefined) ?? "",
          completed: (a.completed as boolean | undefined) ?? false,
        }));
      } else t[key] = fields[key];
    }
  }
}

/** Canonical (lowercase-insensitive) key lookup so "Title" patches "title", as encoding/json does. */
function canonicalKeys(raw: Obj): Obj {
  const byLower = new Map(Object.keys(TASK_FIELDS).map((k) => [k.toLowerCase(), k]));
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) out[byLower.get(k.toLowerCase()) ?? k] = v;
  return out;
}

// ---- lifecycle service ----------------------------------------------------------------------

export async function bestEffort(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // search indexing never fails a request
  }
}

export function lifecycleService(app: App, storage: Storage): Service {
  return new Service(storage, {
    ...(taskLifecycleSeams.purgeReconciler && {
      purgeReconciler: taskLifecycleSeams.purgeReconciler,
    }),
    hooks: {
      indexTask: (id) => bestEffort(() => taskLifecycleSeams.indexTask?.(storage, id)),
      removeTask: (id) => bestEffort(() => taskLifecycleSeams.removeTask?.(storage, id)),
      emit: (event) => {
        app.sse.broadcast({ type: "tasks:lifecycle", data: eventToWire(event) });
      },
    },
  });
}

const isConflictErr = (e: Error): e is HistoryConflictError | MutationConflictError =>
  e instanceof HistoryConflictError || e instanceof MutationConflictError;

function historyPageQuery(c: Ctx): { offset: number; limit: number } | string {
  const parse = (name: string): number | undefined => {
    const v = c.query(name);
    if (v === "") return 0;
    const n = atoi(v);
    return n === undefined || n < 0 ? undefined : n;
  };
  const offset = parse("offset");
  if (offset === undefined) return "invalid history offset";
  const limit = parse("limit");
  if (limit === undefined) return "invalid history limit";
  return { offset, limit };
}

export { historyPageQuery };

function parseIncludeHistorical(c: Ctx): boolean | string {
  const values = c.url.searchParams.getAll("includeHistorical");
  if (values.length === 0) return false;
  if (values.length !== 1 || (values[0] !== "true" && values[0] !== "false")) {
    return "includeHistorical must be true or false";
  }
  return values[0] === "true";
}

export { parseIncludeHistorical };

function lifecycleRank(t: Task): number {
  const s = taskLifecycleState(t);
  return s === "active" ? 0 : s === "done" ? 1 : 2;
}

function sortTasks(tasks: Task[]): Task[] {
  // sort.Slice is not stable but the comparator is total (ID breaks ties).
  return [...tasks].sort((a, b) => {
    const ra = lifecycleRank(a);
    const rb = lifecycleRank(b);
    if (ra !== rb) return ra - rb;
    if (a.order !== undefined || b.order !== undefined) {
      if (a.order === undefined) return 1;
      if (b.order === undefined) return -1;
      if (a.order !== b.order) return a.order - b.order;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function loadTimeEntries(s: Storage, t: Task): void {
  try {
    const entries = s.time.getEntries(t.id);
    t.timeEntries = entries;
  } catch {
    // Go ignores the error and keeps whatever the task had
  }
}

function lifecycleStatus(response: Parameters<typeof failureKindFor>[0], err?: Error): number {
  switch (failureKindFor(response, err)) {
    case FailureNone:
      return 200;
    case FailureInvalidRequest:
      return 400;
    case FailurePermission:
      return 403;
    case FailureNotFound:
      return 404;
    case FailureConflict:
    case FailureDenied:
      return 409;
    default:
      return 500;
  }
}

async function executeLifecycle(app: App, request: LifecycleRequest): Promise<Response> {
  const storage = app.need();
  if (!request.actor) request.actor = "api";
  const { response, error } = await lifecycleService(app, storage).executePublic(
    request,
    app.opts.allowTaskHardDelete === true,
  );
  return jsonResponse(lifecycleStatus(response, error), responseToWire(response));
}

const LIFECYCLE_FIELDS: Record<string, FieldType> = {
  operation: "string",
  taskId: "string",
  ids: "strings",
  execute: "bool",
  actor: "string",
  reason: "string",
  confirmed: "bool",
  status: "string",
  minimumAgeMs: "int64",
  expectedHash: "string",
  expectedHashes: "stringMap",
};

async function decodeLifecycleRequest(
  c: Ctx,
): Promise<{ ok: true; req: LifecycleRequest } | { ok: false; res: Response }> {
  const req = {
    operation: "" as LifecycleRequest["operation"],
    execute: false,
  } as LifecycleRequest;
  // No body (Content-Length 0) is a plain request.
  const text = await c.text();
  if (text.length === 0) return { ok: true, req };
  const r = await readStruct(c, "Request", LIFECYCLE_FIELDS);
  if (!r.ok) return r;
  const v = r.v;
  if (v.operation !== undefined) req.operation = v.operation as LifecycleRequest["operation"];
  if (v.taskId !== undefined) req.taskId = v.taskId as string;
  if (v.ids !== undefined) req.ids = v.ids as string[];
  if (v.execute !== undefined) req.execute = v.execute as boolean;
  if (v.actor !== undefined) req.actor = v.actor as string;
  if (v.reason !== undefined) req.reason = v.reason as string;
  if (v.confirmed !== undefined) req.confirmed = v.confirmed as boolean;
  if (v.status !== undefined) req.status = v.status as string;
  if (v.minimumAgeMs !== undefined) req.minimumAgeMs = v.minimumAgeMs as number;
  if (v.expectedHash !== undefined) req.expectedHash = v.expectedHash as string;
  if (v.expectedHashes !== undefined)
    req.expectedHashes = v.expectedHashes as Record<string, string>;
  return { ok: true, req };
}

export function registerTasks(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);

  r.get(
    "/api/tasks",
    guard((c) => {
      const s = app.need();
      const inc = parseIncludeHistorical(c);
      if (typeof inc === "string") return respondError(400, inc);
      let tasks: Task[];
      try {
        tasks = s.tasks.listActive();
        if (inc) tasks = [...tasks, ...s.tasks.listArchived()];
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      const out = sortTasks(tasks).map((t) => {
        loadTimeEntries(s, t);
        return taskResponse(t);
      });
      return jsonResponse(200, out);
    }),
  );

  r.post(
    "/api/tasks",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "taskCreateRequest", { ...TASK_FIELDS, prefix: "string" });
      if (!body.ok) return body.res;
      const task: Task = {
        id: "",
        title: "",
        status: "",
        priority: "",
        labels: null,
        createdAt: "",
        updatedAt: "",
        archived: false,
        acceptanceCriteria: null,
        timeSpent: 0,
      };
      applyTaskJson(task, body.v, canonicalKeys(body.raw as Obj));
      const prefix = (body.v.prefix as string | undefined) ?? "";
      try {
        normalizeTaskIdPrefix(prefix);
      } catch (e) {
        return respondError(400, errMessage(e));
      }
      const nowDate = new Date();
      const now = goNow(nowDate);
      if (!task.createdAt) task.createdAt = now;
      task.updatedAt = now;
      let requested = task.status;
      if (requested === "") requested = "todo";
      task.status = "todo";
      delete task.completedAt;
      task.archived = false;
      delete task.archivedAt;
      applyStatusTransition(task, requested, nowDate);
      if (task.priority === "") task.priority = "medium";
      if (task.labels === null) task.labels = [];
      try {
        await createTaskWithHistory(
          s.ctx,
          task,
          { changes: s.versions.trackChanges(null, task) },
          prefix,
        );
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      await bestEffort(() => taskLifecycleSeams.indexTask?.(s, task.id));
      const response = taskResponse(task);
      app.sse.broadcast({ type: "tasks:updated", data: { task: response } });
      return jsonResponse(201, response);
    }),
  );

  r.get(
    "/api/tasks/{id}",
    guard((c) => {
      const s = app.need();
      let task: Task;
      try {
        task = s.tasks.get(c.params.id as string);
      } catch (e) {
        return respondError(404, errMessage(e));
      }
      loadTimeEntries(s, task);
      const timer = s.time.getActiveTimer(task.id);
      if (timer) task.activeTimer = timer;
      else delete task.activeTimer;
      return jsonResponse(200, taskResponse(task));
    }),
  );

  r.put(
    "/api/tasks/{id}",
    guard(async (c) => {
      const s = app.need();
      const id = c.params.id as string;
      const m = await readMap(c);
      if (!m.ok) return m.res;
      const patch = { ...m.v };
      let expectedHash = "";
      if ("expectedHash" in patch) {
        const v = patch.expectedHash;
        if (v !== null && typeof v !== "string")
          return respondError(400, "expectedHash must be a string");
        expectedHash = (v as string | null) ?? "";
        delete patch.expectedHash;
      }
      const keys = canonicalKeys(patch);
      let updated: Task;
      try {
        updated = await lifecycleService(app, s).updateTask(id, {
          actor: "api",
          expectedHash,
          mutate: (task) => {
            // Marshal, overlay the patch keys, unmarshal back: typed decoding errors surface here.
            applyTaskJson(task, checkTaskPatch(keys), keys);
          },
        });
      } catch (e) {
        let status = 500;
        if (lifecycleNotFound(e)) status = 404;
        if (findError(e, isConflictErr)) status = 409;
        return respondError(status, errMessage(e));
      }
      const response = taskResponse(updated);
      app.sse.broadcast({ type: "tasks:updated", data: { task: response } });
      return jsonResponse(200, response);
    }),
  );

  r.post(
    "/api/tasks/batch-archive",
    guard(async (c) => {
      const body = await readStruct(c, "batchArchiveRequest", {
        ids: "strings",
        execute: "bool",
        actor: "string",
        minimumAgeMs: "int64",
        olderThanMs: "int64",
        expectedHashes: "stringMap",
      });
      if (!body.ok) return body.res;
      const v = body.v;
      const minimumAge = (v.minimumAgeMs ?? v.olderThanMs) as number | undefined;
      return executeLifecycle(app, {
        operation: "batch_archive",
        ...(v.ids !== undefined && { ids: v.ids as string[] }),
        execute: (v.execute as boolean | undefined) ?? false,
        ...(v.actor !== undefined && { actor: v.actor as string }),
        ...(minimumAge !== undefined && { minimumAgeMs: minimumAge }),
        ...(v.expectedHashes !== undefined && {
          expectedHashes: v.expectedHashes as Record<string, string>,
        }),
      });
    }),
  );

  r.post(
    "/api/tasks/batch-unarchive",
    guard(async (c) => {
      const d = await decodeLifecycleRequest(c);
      if (!d.ok) return d.res;
      d.req.operation = "batch_unarchive";
      return executeLifecycle(app, d.req);
    }),
  );

  r.post(
    "/api/tasks/reorder",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "reorderRequest", {
        orders: {
          array: {
            custom: (v) =>
              jsonKind(v) === "object" &&
              ((v as Obj).id === undefined || typeof (v as Obj).id === "string") &&
              ((v as Obj).order === undefined || Number.isInteger((v as Obj).order)),
            goName: "routes.reorderItem",
          },
          goName: "[]routes.reorderItem",
        },
        expectedHashes: "stringMap",
      });
      if (!body.ok) return body.res;
      const items = ((body.v.orders as Obj[] | undefined) ?? []).map((o) => ({
        taskId: (o.id as string | undefined) ?? "",
        order: (o.order as number | undefined) ?? 0,
      }));
      let updated: number;
      try {
        updated = await lifecycleService(app, s).reorderTasks(
          items,
          body.v.expectedHashes as Record<string, string> | undefined,
        );
      } catch (e) {
        let status = 500;
        if (findError(e, isConflictErr)) status = 409;
        else if (lifecycleNotFound(e)) status = 404;
        return respondError(status, errMessage(e));
      }
      if (updated > 0) app.sse.broadcast({ type: "tasks:reordered", data: { updated } });
      return jsonResponse(200, { success: true, updated });
    }),
  );

  r.post(
    "/api/tasks/sync-spec-acs",
    guard(() => {
      const s = app.need();
      let tasks: Task[];
      try {
        tasks = s.tasks.listAll();
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      let synced = 0;
      for (const t of tasks) {
        if (t.status !== "done" || !t.spec || (t.fulfills ?? []).length === 0) continue;
        try {
          s.docs.get(t.spec);
        } catch {
          continue;
        }
        synced++;
      }
      if (synced > 0) app.sse.broadcast({ type: "docs:updated", data: { synced } });
      return jsonResponse(200, { success: true, synced });
    }),
  );

  for (const [path, op] of [
    ["archive", "archive"],
    ["unarchive", "reopen"],
    ["hard-delete", "hard_delete"],
  ] as const) {
    r.post(
      `/api/tasks/{id}/${path}`,
      guard(async (c) => {
        const d = await decodeLifecycleRequest(c);
        if (!d.ok) return d.res;
        d.req.operation = op;
        d.req.taskId = c.params.id as string;
        if (op === "hard_delete") d.req.execute = d.req.confirmed === true;
        return executeLifecycle(app, d.req);
      }),
    );
  }

  r.get(
    "/api/tasks/{id}/history",
    guard(async (c) => {
      const s = app.need();
      const id = c.params.id as string;
      const meta = c.query("metadata");
      if (meta.toLowerCase() === "true" || c.query("offset") !== "" || c.query("limit") !== "") {
        const q = historyPageQuery(c);
        if (typeof q === "string") return respondError(400, q);
        try {
          const page = await s.versions.listTaskHistoryMetadata(id, q.offset, q.limit);
          return jsonResponse(200, historyMetadataPageToWire(page));
        } catch (e) {
          return respondError(500, errMessage(e));
        }
      }
      try {
        const h = await s.versions.getHistory(id);
        return jsonResponse(200, taskVersionHistoryToWire(h));
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  r.get(
    "/api/tasks/{id}/history/{revision}",
    guard(async (c) => {
      const s = app.need();
      try {
        const v = await s.versions.getTaskRevisionDetail(
          c.params.id as string,
          c.params.revision as string,
        );
        return jsonResponse(200, taskVersionToWire(v));
      } catch (e) {
        return respondError(404, errMessage(e));
      }
    }),
  );
}

/** Type-checks a PUT patch against the Task fields; throws Go's UnmarshalTypeError text. */
function checkTaskPatch(keys: Obj): Obj {
  return decodeStruct(keys, "Task", TASK_FIELDS);
}
