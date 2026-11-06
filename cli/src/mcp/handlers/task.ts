// Port of internal/mcp/handlers/task.go.
import { newCLITaskLifecycleService } from "../../cli/commands/task-lifecycle.ts";
import type { Request } from "../../domain/tasklifecycle/index.ts";
import {
  applyStatusTransition,
  historyMetadataPageToWire,
  responseToWire,
  taskToWire,
  taskVersionHistoryToWire,
  taskVersionToWire,
} from "../../domain/tasklifecycle/index.ts";
import { DEFAULT_STATUSES, type Task } from "../../models/task.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import {
  boolArg,
  ErrTaskIDReq,
  errFailed,
  errMsg,
  errNotFound,
  historyPageArgs,
  intArg,
  intSliceArg,
  MUTATION_FULL,
  noProjectError,
  notNil,
  parseMutationReturn,
  stringArg,
  stringSetArg,
  stringSliceArg,
} from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import { TASK_ACTION_PARAMS } from "../help-data.ts";
import { notifyRefresh, notifyTaskUpdated } from "../notify.ts";
import { type ActionMeta, CapArchive, CapDelete, effectivePolicy } from "../permissions.ts";
import type { McpState, Project } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";
import { tombstoneRestoreResult } from "./tombstone.ts";

void (undefined as unknown as ActionMeta);

export async function handle(
  state: McpState,
  ctx: { signal?: AbortSignal },
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  const action = a.value;
  const bad = validateTaskArgs(action, argsOf(req));
  if (bad) return errorResult(bad);
  switch (action) {
    case "create":
      return create(state, req);
    case "get":
      return get(state, req);
    case "update":
      return update(state, req);
    case "delete":
      return del(state, req);
    case "list":
      return list(state, req);
    case "history":
      return history(state, req);
    case "board":
      return board(state);
    case "restore":
      return restore(state, req);
    case "archive":
    case "unarchive":
    case "batch_archive":
    case "batch_unarchive":
    case "hard_delete":
      return lifecycle(state, ctx, action, req);
    default:
      return errorResult(`unknown tasks action: ${action}`);
  }
}

/** validateTaskArgs: a parameter the action does not accept is an error. */
function validateTaskArgs(action: string, args: Record<string, unknown>): string | undefined {
  const allowed = Object.hasOwn(TASK_ACTION_PARAMS, action)
    ? TASK_ACTION_PARAMS[action]
    : undefined;
  if (!allowed) return undefined;
  const unknown: string[] = [];
  for (const key of Object.keys(args)) {
    if (key === "action") continue;
    if (!Object.hasOwn(allowed, key)) unknown.push(key);
  }
  if (unknown.length === 0) return undefined;
  unknown.sort(byBytes);
  return `tasks ${action} does not accept ${unknown.join(", ")}; call help("tasks.${action}") for the parameters it takes`;
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function mutationResult(task: Task, mode: string): CallToolResult {
  if (mode === MUTATION_FULL) return textResult(marshalIndent(taskToWire(task)));
  return textResult(
    marshalIndent({
      success: true,
      taskId: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
    }),
  );
}

async function create(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const t = requireString(req, "title");
  if (!t.ok) return errorResult(t.error);
  const args = argsOf(req);
  const rm = parseMutationReturn(args);
  if (rm.error) return errorResult(rm.error);
  const { storage } = project;

  let priority = "medium";
  let status = "todo";
  try {
    const dp = storage.config.load().settings.defaultPriority;
    if (dp) priority = dp;
  } catch {
    // defaults
  }
  const [s, sok] = stringArg(args, "status");
  if (sok) status = s;
  const [p, pok] = stringArg(args, "priority");
  if (pok) priority = p;

  const now = new Date();
  const nowText = now.toISOString();
  const task: Task = {
    id: "",
    title: t.value,
    status,
    priority,
    labels: [],
    createdAt: nowText,
    updatedAt: nowText,
    archived: false,
    acceptanceCriteria: null,
    timeSpent: 0,
  };
  if (status === "done") {
    task.status = "todo";
    applyStatusTransition(task, status, now);
  }
  const [description, dok] = stringArg(args, "description");
  if (dok && description !== "") task.description = description;
  const [assignee, aok] = stringArg(args, "assignee");
  if (aok && assignee !== "") task.assignee = assignee;
  const [parent, pk] = stringArg(args, "parent");
  if (pk && parent !== "") task.parent = parent;
  const [spec, spk] = stringArg(args, "spec");
  if (spk && spec !== "") task.spec = spec;
  const [labels, lok] = stringSliceArg(args, "labels");
  if (lok) task.labels = labels;
  const [fulfills, fok] = stringSliceArg(args, "fulfills");
  if (fok && fulfills.length > 0) task.fulfills = fulfills;
  const [order, ook] = intArg(args, "order");
  if (ook) task.order = order;
  const [plan, plok] = stringArg(args, "plan");
  if (plok && plan !== "") task.implementationPlan = plan;
  const [notes, nok] = stringArg(args, "notes");
  if (nok && notes !== "") task.implementationNotes = notes;
  // Acceptance criteria are accepted at creation, so none are dropped silently.
  const [addAc, acok] = stringSliceArg(args, "addAc");
  if (acok && addAc.length > 0) {
    task.acceptanceCriteria = addAc.map((text) => ({ text, completed: false }));
  }
  const [prefix] = stringArg(args, "prefix");
  try {
    const { createTaskWithHistory } = await import("../../storage/history/index.ts");
    await createTaskWithHistory(
      storage.ctx,
      task,
      { changes: storage.versions.trackChanges(null, task) },
      prefix,
    );
  } catch (e) {
    return errFailed("create task", e);
  }
  await indexTask(project, task.id);
  notifyTaskUpdated(project.store, task.id);
  return mutationResult(task, rm.mode);
}

async function indexTask(project: Project, id: string): Promise<void> {
  try {
    const { taskLifecycleSeams } = await import("../../cli/commands/task-lifecycle.ts");
    await taskLifecycleSeams.indexTask?.(project.storage, id);
  } catch {
    // best effort
  }
}

function getTask(project: Project, id: string): Task {
  const { storage } = project;
  const task = storage.tasks.get(id);
  try {
    task.timeEntries = storage.time.getEntries(task.id);
  } catch {
    // entries unreadable: leave unset
  }
  const timer = storage.time.getActiveTimer(task.id);
  if (timer) task.activeTimer = timer;
  return task;
}

async function get(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "taskId");
  if (!id.ok) return errorResult(ErrTaskIDReq);
  let task: Task;
  try {
    task = project.storage.tasks.get(id.value);
  } catch (e) {
    return errNotFound("Task", e);
  }
  try {
    task.timeEntries = project.storage.time.getEntries(task.id);
  } catch {
    // leave unset
  }
  const timer = project.storage.time.getActiveTimer(task.id);
  if (timer) task.activeTimer = timer;
  return textResult(marshalIndent(taskToWire(task)));
}

async function update(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "taskId");
  if (!id.ok) return errorResult(ErrTaskIDReq);
  const args = argsOf(req);
  const rm = parseMutationReturn(args);
  if (rm.error) return errorResult(rm.error);
  const clear = stringSetArg(args, "clear");
  const { storage } = project;
  const service = newCLITaskLifecycleService(storage);
  const [expectedHash] = stringArg(args, "expectedHash");
  let task: Task;
  try {
    task = await service.updateTask(id.value, {
      actor: "mcp",
      expectedHash,
      mutate: (t) => {
        const [title, tok] = stringArg(args, "title");
        if (clear.has("title")) t.title = "";
        else if (tok && title !== "") t.title = title;
        const [description, dok] = stringArg(args, "description");
        if (clear.has("description")) delete t.description;
        else if (dok && description !== "") t.description = description;
        const [status, sok] = stringArg(args, "status");
        if (sok) t.status = status;
        const [priority, pok] = stringArg(args, "priority");
        if (pok) t.priority = priority;
        const [assignee, aok] = stringArg(args, "assignee");
        if (clear.has("assignee")) delete t.assignee;
        else if (aok && assignee !== "") t.assignee = assignee;
        if (Object.hasOwn(args, "labels")) {
          const [labels, ok] = stringSliceArg(args, "labels");
          t.labels = ok ? labels : [];
        }
        const [spec, spk] = stringArg(args, "spec");
        if (clear.has("spec")) delete t.spec;
        else if (spk && spec !== "") t.spec = spec;
        if (Object.hasOwn(args, "fulfills")) {
          const [fulfills, ok] = stringSliceArg(args, "fulfills");
          if (ok && fulfills.length > 0) t.fulfills = fulfills;
          else delete t.fulfills;
        }
        if (Object.hasOwn(args, "order")) {
          const [order, ok] = intArg(args, "order");
          if (ok) t.order = order;
        }
        const [addAc, aok2] = stringSliceArg(args, "addAc");
        if (aok2) {
          const list = [...(t.acceptanceCriteria ?? [])];
          for (const text of addAc) list.push({ text, completed: false });
          t.acceptanceCriteria = list;
        }
        const [check, cok] = intSliceArg(args, "checkAc");
        if (cok) applyACCompletion(t, check, true);
        const [uncheck, uok] = intSliceArg(args, "uncheckAc");
        if (uok) applyACCompletion(t, uncheck, false);
        const [remove, rok] = intSliceArg(args, "removeAc");
        if (rok) {
          const sorted = [...remove].sort((x, y) => y - x);
          for (const idx of sorted) {
            const i = idx - 1;
            const list = t.acceptanceCriteria ?? [];
            if (i >= 0 && i < list.length) {
              list.splice(i, 1);
              t.acceptanceCriteria = list;
            }
          }
        }
        const [plan, plok] = stringArg(args, "plan");
        if (clear.has("plan")) delete t.implementationPlan;
        else if (plok && plan !== "") t.implementationPlan = plan;
        const [notes, nok] = stringArg(args, "notes");
        if (clear.has("notes")) delete t.implementationNotes;
        else if (nok && notes !== "") t.implementationNotes = notes;
        const [append, apok] = stringArg(args, "appendNotes");
        if (apok && append !== "") {
          t.implementationNotes = t.implementationNotes
            ? `${t.implementationNotes}\n\n${append}`
            : append;
        }
      },
    });
  } catch (e) {
    return errFailed("update task", e);
  }
  notifyTaskUpdated(project.store, task.id);
  if (rm.mode === MUTATION_FULL) {
    const timer = storage.time.getActiveTimer(task.id);
    if (timer) task.activeTimer = timer;
  }
  return mutationResult(task, rm.mode);
}

/** applyACCompletion: an index the Task does not have is an error, not a silent skip. */
function applyACCompletion(task: Task, indexes: number[], completed: boolean): void {
  for (const idx of indexes) {
    const i = idx - 1;
    const list = task.acceptanceCriteria ?? [];
    const item = list[i];
    if (i < 0 || !item) {
      throw new Error(`acceptance criterion ${idx} is out of range: task has ${list.length}`);
    }
    item.completed = completed;
  }
}

async function list(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [statusFilter] = stringArg(args, "status");
  const [priorityFilter] = stringArg(args, "priority");
  const [assigneeFilter] = stringArg(args, "assignee");
  const [labelFilter] = stringArg(args, "label");
  const [specFilter] = stringArg(args, "spec");
  const includeHistorical = boolArg(args, "includeHistorical");
  const { storage } = project;
  let tasks: Task[];
  try {
    tasks = includeHistorical ? storage.tasks.listAll() : storage.tasks.listActive();
  } catch (e) {
    return errFailed("list tasks", e);
  }
  // Go: ListActive returns a nil slice when there are none (JSON null); ListAll never does.
  const nilSource = !includeHistorical && tasks.length === 0;
  const filtered = tasks.filter(
    (t) =>
      !(
        (statusFilter !== "" && t.status !== statusFilter) ||
        (priorityFilter !== "" && t.priority !== priorityFilter) ||
        (assigneeFilter !== "" && (t.assignee ?? "") !== assigneeFilter) ||
        (labelFilter !== "" && !(t.labels ?? []).includes(labelFilter)) ||
        (specFilter !== "" && (t.spec ?? "") !== specFilter)
      ),
  );
  if (filtered.length === 0) {
    return textResult(
      marshalIndent(
        goMap({
          results: nilSource ? null : [],
          _projectRoot: project.store.root,
          _hint:
            'No tasks found. Verify the active project is correct via project({ action: "current" }).',
        }),
      ),
    );
  }
  return textResult(marshalIndent(filtered.map(taskToWire)));
}

async function lifecycle(
  state: McpState,
  ctx: { signal?: AbortSignal },
  action: string,
  req: CallToolRequest,
): Promise<CallToolResult> {
  void ctx;
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const request: Request = { operation: "archive", execute: false, actor: "mcp" };
  const [taskId] = stringArg(args, "taskId");
  request.taskId = taskId;
  const [ids, idsOk] = stringSliceArg(args, "ids");
  if (idsOk) request.ids = ids;
  request.execute = args.execute === true;
  request.confirmed = args.confirmed === true;
  const [reason] = stringArg(args, "reason");
  request.reason = reason;
  const [expectedHash] = stringArg(args, "expectedHash");
  request.expectedHash = expectedHash;
  const raw = args.expectedHashes;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const hashes: Record<string, string> = {};
    for (const [id, value] of Object.entries(raw))
      if (typeof value === "string") hashes[id] = value;
    request.expectedHashes = hashes;
  }
  const [actor, aok] = stringArg(args, "actor");
  if (aok) request.actor = actor;
  switch (action) {
    case "archive":
      request.operation = "archive";
      break;
    case "unarchive":
      request.operation = "reopen";
      break;
    case "batch_archive":
      request.operation = "batch_archive";
      break;
    case "batch_unarchive":
      request.operation = "batch_unarchive";
      break;
    case "hard_delete":
      request.operation = "hard_delete";
      request.execute = request.confirmed === true;
      break;
  }
  // Permission comes from canonical project policy, never MCP arguments.
  const capabilities = { archive: false, hardDelete: false };
  try {
    const policy = effectivePolicy(project.storage.config.load().settings.permissions);
    capabilities.archive = policy.allowed.has(CapArchive) && !policy.denied.has(CapArchive);
    capabilities.hardDelete = policy.allowed.has(CapDelete) && !policy.denied.has(CapDelete);
  } catch {
    // unreadable config: no capabilities
  }
  const { response, error } = await newCLITaskLifecycleService(
    project.storage,
  ).executePublicWithCapabilities(request, capabilities);
  if (response.changed > 0) notifyRefresh(project.store);
  const out = marshalIndent(responseToWire(response));
  return error ? errorResult(out) : textResult(out);
}

async function history(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "taskId");
  if (!id.ok) return errorResult(ErrTaskIDReq);
  const args = argsOf(req);
  const { versions } = project.storage;
  const [revision, rok] = stringArg(args, "revision");
  if (rok && goTrimSpace(revision) !== "") {
    try {
      const version = await versions.getTaskRevisionDetail(id.value, revision);
      return textResult(marshalIndent(taskVersionToWire(version)));
    } catch (e) {
      return errFailed("get task revision", e);
    }
  }
  if (boolArg(args, "metadata") || notNil(args, "offset") || notNil(args, "limit")) {
    const [offset, limit, err] = historyPageArgs(args);
    if (err) return errorResult(err);
    try {
      const page = await versions.listTaskHistoryMetadata(id.value, offset, limit);
      return textResult(marshalIndent(historyMetadataPageToWire(page)));
    } catch (e) {
      return errFailed("list task history metadata", e);
    }
  }
  try {
    const h = await versions.getHistory(id.value);
    return textResult(marshalIndent(taskVersionHistoryToWire(h)));
  } catch (e) {
    return errFailed("get task history", e);
  }
}

async function del(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [taskId, ok] = stringArg(args, "taskId");
  if (!ok || taskId === "") return errorResult(ErrTaskIDReq);
  let dryRun = true;
  if (Object.hasOwn(args, "dryRun") && typeof args.dryRun === "boolean") dryRun = args.dryRun;
  let task: Task;
  try {
    task = project.storage.tasks.get(taskId);
  } catch (e) {
    return errNotFound("Task", e);
  }
  if (dryRun) {
    return textResult(
      marshalIndent(
        goMap({
          dryRun: true,
          message: `Would delete task ${task.id}: ${task.title}`,
          task: taskToWire(task),
        }),
      ),
    );
  }
  return errorResult(
    "tasks.delete is preview-only; use the separately permission-gated hard_delete action with confirmed=true and a non-empty reason",
  );
}

async function board(state: McpState): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const { storage } = project;
  let tasks: Task[];
  try {
    tasks = storage.tasks.listActive();
  } catch (e) {
    return errFailed("list tasks", e);
  }
  let columns: string[] = [...DEFAULT_STATUSES];
  try {
    const s = storage.config.load().settings;
    if (s.visibleColumns && s.visibleColumns.length > 0) columns = s.visibleColumns;
    else if (s.statuses && s.statuses.length > 0) columns = s.statuses;
  } catch {
    // defaults
  }
  interface Column {
    status: string;
    tasks: Task[];
    count: number;
  }
  const map = new Map<string, Column>();
  for (const status of columns) map.set(status, { status, tasks: [], count: 0 });
  const extra: string[] = [];
  for (const t of tasks) {
    let c = map.get(t.status);
    if (!c) {
      extra.push(t.status);
      c = { status: t.status, tasks: [], count: 0 };
      map.set(t.status, c);
    }
    c.tasks.push(t);
    c.count++;
  }
  const ordered: Column[] = [];
  for (const status of columns) {
    const c = map.get(status);
    if (c) ordered.push(c);
  }
  for (const status of extra) {
    const c = map.get(status);
    if (c) ordered.push(c);
  }
  const total = ordered.reduce((n, c) => n + c.count, 0);
  return textResult(
    marshalIndent(
      goMap({
        columns: ordered.map((c) => ({
          status: c.status,
          tasks: c.tasks.map(taskToWire),
          count: c.count,
        })),
        total,
      }),
    ),
  );
}

async function restore(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "taskId");
  if (!id.ok) return errorResult(ErrTaskIDReq);
  return tombstoneRestoreResult(project, "task", id.value, argsOf(req).execute === true);
}

void errMsg;
void getTask;
