// Port of internal/mcp/handlers/time.go.
import { newCLITaskLifecycleService } from "../../cli/commands/task-lifecycle.ts";
import { parseGoDate } from "../../cli/commands/time-support.ts";
import { goQuote } from "../../cli/core/gofmt.ts";
import { wireTime } from "../../domain/tasklifecycle/clock.ts";
import { timeEntryToWire } from "../../domain/tasklifecycle/wire.ts";
import type { Task } from "../../models/task.ts";
import type { TimeEntry } from "../../models/time.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { ErrTaskIDReq, errFailed, errNotFound, noProjectError, stringArg } from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import { notifyTimeUpdated } from "../notify.ts";
import type { McpState } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";

export async function handle(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  switch (a.value) {
    case "start":
      return start(state, req);
    case "stop":
      return stop(state, req);
    case "add":
      return add(state, req);
    case "report":
      return report(state, req);
    default:
      return errorResult(`unknown time action: ${a.value}`);
  }
}

/** strconv.Atoi: the int, or Go's error text. */
function atoi(s: string): { v: number } | { err: string } {
  if (!/^[+-]?\d+$/.test(s)) return { err: `strconv.Atoi: parsing ${goQuote(s)}: invalid syntax` };
  const n = Number(s);
  if (!Number.isSafeInteger(n))
    return { err: `strconv.Atoi: parsing ${goQuote(s)}: value out of range` };
  return { v: n };
}

/** models.ParseDuration, with Go's exact error text. */
function goParseDuration(input: string): number {
  const s = goTrimSpace(input);
  if (s === "") throw new Error("empty duration string");
  let total = 0;
  let rest = s;
  for (const [unit, mult, label] of [
    ["h", 3600, "hours"],
    ["m", 60, "minutes"],
    ["s", 1, "seconds"],
  ] as const) {
    const i = rest.indexOf(unit);
    if (i < 0) continue;
    const r = atoi(rest.slice(0, i));
    if ("err" in r) throw new Error(`invalid ${label} in ${goQuote(s)}: ${r.err}`);
    total += r.v * mult;
    rest = rest.slice(i + 1);
  }
  if (rest !== "") {
    throw new Error(`unrecognised duration format: ${goQuote(s)} (use e.g. "2h", "30m", "1h30m")`);
  }
  if (total === 0 && s !== "0s" && s !== "0m" && s !== "0h") {
    throw new Error(`duration parsed to zero from ${goQuote(s)} \u2013 check the format`);
  }
  return total;
}

/** formatDuration: seconds as "1h05m", "5m", "30s". */
export function formatDuration(secs: number): string {
  const h = Math.trunc(secs / 3600);
  const m = Math.trunc((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return m > 0 || s > 0 ? `${h}h${pad(m)}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${pad(s)}s` : `${m}m`;
  return `${s}s`;
}

async function start(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
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
    await project.storage.time.start(task.id, task.title);
  } catch (e) {
    return errFailed("start timer", e);
  }
  notifyTimeUpdated(project.store);
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        taskId: task.id,
        message: `Timer started for task '${task.title}'`,
      }),
    ),
  );
}

async function stop(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "taskId");
  if (!id.ok) return errorResult(ErrTaskIDReq);
  const [expectedHash] = stringArg(argsOf(req), "expectedHash");
  let entry: TimeEntry;
  try {
    entry = await newCLITaskLifecycleService(project.storage).stopTimer(id.value, {
      actor: "mcp",
      expectedHash,
    });
  } catch (e) {
    return errFailed("stop timer", e);
  }
  notifyTimeUpdated(project.store);
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        taskId: id.value,
        duration: entry.duration,
        entry: timeEntryToWire(entry),
        message: `Timer stopped. Duration: ${formatDuration(entry.duration)}`,
      }),
    ),
  );
}

async function add(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "taskId");
  if (!id.ok) return errorResult(ErrTaskIDReq);
  const dur = requireString(req, "duration");
  if (!dur.ok) return errorResult(dur.error);
  let secs: number;
  try {
    secs = goParseDuration(dur.value);
  } catch (e) {
    return errorResult(`Invalid duration ${goQuote(dur.value)}: ${(e as Error).message}`);
  }
  let task: Task;
  try {
    task = project.storage.tasks.get(id.value);
  } catch (e) {
    return errNotFound("Task", e);
  }
  const args = argsOf(req);
  let startedMs = Date.now();
  const [dateStr, dok] = stringArg(args, "date");
  if (dok && dateStr !== "") {
    const parsed = parseGoDate(dateStr);
    if (parsed.ok) startedMs = parsed.date.ms;
  }
  const endedMs = startedMs + secs * 1000;
  const entry: TimeEntry = {
    id: `te-${Date.now()}-${id.value}`,
    startedAt: wireTime(new Date(startedMs)),
    endedAt: wireTime(new Date(endedMs)),
    duration: secs,
  };
  const [note, nok] = stringArg(args, "note");
  if (nok && note !== "") entry.note = note;
  const [expectedHash] = stringArg(args, "expectedHash");
  try {
    await newCLITaskLifecycleService(project.storage).addTimeEntry(id.value, {
      actor: "mcp",
      expectedHash,
      entry,
    });
  } catch (e) {
    return errFailed("save time entry", e);
  }
  notifyTimeUpdated(project.store);
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        taskId: id.value,
        duration: secs,
        entry: timeEntryToWire(entry),
        message: `Added ${dur.value} to task '${task.title}'`,
      }),
    ),
  );
}

interface ReportEntry {
  taskId: string;
  taskTitle?: string;
  duration?: number;
  note?: string;
  date?: string;
}

const ACTIVE_STARTED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function report(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const { storage } = project;
  const args = argsOf(req);
  const [fromStr] = stringArg(args, "from");
  const [toStr] = stringArg(args, "to");
  const [groupBy] = stringArg(args, "groupBy");

  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (fromStr !== "") {
    const p = parseGoDate(fromStr);
    if (p.ok && !p.date.isZero) fromMs = p.date.ms;
  }
  if (toStr !== "") {
    const p = parseGoDate(toStr);
    if (p.ok) toMs = p.date.ms + 24 * 3600 * 1000 - 1000;
  }
  let all: Record<string, TimeEntry[]>;
  try {
    all = storage.time.getAllEntries();
  } catch (e) {
    return errFailed("load time entries", e);
  }
  const taskMap = new Map<string, Task>();
  try {
    for (const t of storage.tasks.listAll()) taskMap.set(t.id, t);
  } catch {
    // tasks unreadable: no titles
  }
  const entries: ReportEntry[] = [];
  let totalSecs = 0;
  for (const [taskId, list] of Object.entries(all)) {
    for (const e of list) {
      const startedMs = Date.parse(e.startedAt);
      if (fromMs !== undefined && startedMs < fromMs) continue;
      if (toMs !== undefined && startedMs > toMs) continue;
      const re: ReportEntry = { taskId };
      const t = taskMap.get(taskId);
      if (t?.title) re.taskTitle = t.title;
      re.duration = e.duration;
      if (e.note) re.note = e.note;
      re.date = new Date(startedMs).toISOString().slice(0, 10);
      entries.push(re);
      totalSecs += e.duration;
    }
  }
  let timeState: ReturnType<typeof storage.time.getState> | undefined;
  try {
    timeState = storage.time.getState();
  } catch {
    timeState = undefined;
  }
  for (const at of timeState?.active ?? []) {
    if (!ACTIVE_STARTED.test(at.startedAt)) continue;
    const startedMs = Date.parse(at.startedAt);
    if (fromMs !== undefined && startedMs < fromMs) continue;
    let elapsed =
      Math.trunc((Date.now() - startedMs) / 1000) - Math.trunc((at.totalPausedMs ?? 0) / 1000);
    if (elapsed < 0) elapsed = 0;
    const re: ReportEntry = { taskId: at.taskId };
    const t = taskMap.get(at.taskId);
    if (t?.title) re.taskTitle = t.title;
    re.duration = elapsed;
    re.note = "(active timer)";
    re.date = new Date(startedMs).toISOString().slice(0, 10);
    entries.push(re);
    totalSecs += elapsed;
  }

  let data: Record<string, unknown>;
  if (groupBy !== "") {
    const groups = new Map<string, { key: string; duration: number; count: number }>();
    const bump = (key: string, e: ReportEntry): void => {
      const g = groups.get(key);
      if (g) {
        g.duration += e.duration ?? 0;
        g.count++;
      } else groups.set(key, { key, duration: e.duration ?? 0, count: 1 });
    };
    for (const e of entries) {
      let key = "";
      if (groupBy === "task") {
        key = e.taskId;
        if (e.taskTitle) key = `${e.taskTitle} (${e.taskId})`;
      } else if (groupBy === "label") {
        const task = taskMap.get(e.taskId);
        if (task && (task.labels ?? []).length > 0) {
          for (const label of task.labels ?? []) bump(label, e);
          continue;
        }
        key = "(no label)";
      } else if (groupBy === "status") {
        const task = taskMap.get(e.taskId);
        key = task ? task.status : "(unknown)";
      }
      bump(key, e);
    }
    data = goMap({
      groups: groups.size === 0 ? null : [...groups.values()],
      total: totalSecs,
      formatted: formatDuration(totalSecs),
      groupBy,
      from: fromStr,
      to: toStr,
    });
  } else {
    data = goMap({
      entries: entries.length === 0 ? null : entries,
      total: totalSecs,
      formatted: formatDuration(totalSecs),
      from: fromStr,
      to: toStr,
    });
  }
  return textResult(marshalIndent(data));
}
