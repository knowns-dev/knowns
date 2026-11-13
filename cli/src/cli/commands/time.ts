// `knowns time`: port of internal/cli/time.go.

import type { ActiveTimer, TimeEntry } from "../../models/time.ts";
import { parseDuration } from "../../models/time.ts";
import { exactArgs, maximumNArgs } from "../core/args.ts";
import type { CommandContext } from "../core/define.ts";
import { defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import { formatDuration } from "../core/helpers.ts";
import {
  renderSectionHeader,
  renderSeparator,
  renderSuccess,
  StyleBold,
  StyleDim,
  StyleID,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
  statusStyle,
} from "../core/plainoutput.ts";
import { cliLifecycleActor, newCLITaskLifecycleService, openStorage } from "./task-lifecycle.ts";
import { formatDate, formatDateMinute, formatRFC3339, padRunes } from "./task-text.ts";
import { csvRecord, parseGoDate } from "./time-support.ts";

const wrapErr = (prefix: string, e: unknown): Error =>
  new Error(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });

const TIMER_LAYOUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const parseTimerMs = (value: string): number =>
  TIMER_LAYOUT.test(value) ? Date.parse(value) : Number.NaN;

/** Elapsed active seconds of a timer: now - start - paused time, not counting the open pause. */
export function elapsedSeconds(a: ActiveTimer, nowMs: number): number {
  const start = parseTimerMs(a.startedAt);
  if (Number.isNaN(start)) return 0;
  let elapsed = nowMs - start - a.totalPausedMs;
  if (a.pausedAt !== null) {
    // Currently paused: don't include time since the pause.
    const pausedAt = parseTimerMs(a.pausedAt);
    if (!Number.isNaN(pausedAt)) elapsed -= nowMs - pausedAt;
  }
  if (elapsed < 0) return 0;
  return Math.trunc(elapsed / 1000);
}

/** The task ID a no-argument pause/stop/resume acts on, or the Go error. */
async function soleActiveTimer(ctx: CommandContext, requireSingle: boolean): Promise<string> {
  const storage = await openStorage(ctx);
  let active: ActiveTimer[];
  try {
    active = storage.time.getState().active ?? [];
  } catch (e) {
    throw wrapErr("get timer state", e);
  }
  if (active.length === 0) throw new Error("no active timer");
  if (requireSingle && active.length > 1) {
    throw new Error("multiple timers active, please specify task ID");
  }
  return (active[0] as ActiveTimer).taskId;
}

// --- start / stop / pause / resume -----------------------------------------------------------

async function runTimeStart(ctx: CommandContext): Promise<void> {
  const taskId = ctx.args[0] as string;
  const storage = await openStorage(ctx);
  let title: string;
  try {
    title = storage.tasks.get(taskId).title;
  } catch {
    throw new Error(`task ${goQuote(taskId)} not found`);
  }
  try {
    await storage.time.start(taskId, title);
  } catch (e) {
    throw wrapErr("start timer", e);
  }
  ctx.print(`${renderSuccess(`Timer started for task ${taskId} (${title})`)}\n`);
}

async function runTimeStop(ctx: CommandContext): Promise<void> {
  const storage = await openStorage(ctx);
  const taskId = ctx.args[0] ?? (await soleActiveTimer(ctx, true));
  let entry: TimeEntry;
  try {
    entry = await newCLITaskLifecycleService(storage).stopTimer(taskId, {
      actor: cliLifecycleActor(ctx.env),
      expectedHash: ctx.flags.string("expected-hash"),
    });
  } catch (e) {
    throw wrapErr("stop timer", e);
  }
  ctx.print(
    `${renderSuccess(`Timer stopped for task ${taskId}. Duration: ${formatDuration(entry.duration)}`)}\n`,
  );
}

async function runTimePause(ctx: CommandContext): Promise<void> {
  const taskId = ctx.args[0] ?? (await soleActiveTimer(ctx, true));
  const storage = await openStorage(ctx);
  try {
    await storage.time.pause(taskId);
  } catch (e) {
    throw wrapErr("pause timer", e);
  }
  ctx.print(`${StyleWarning.render(`⏸ Timer paused for task ${taskId}`)}\n`);
}

async function runTimeResume(ctx: CommandContext): Promise<void> {
  const storage = await openStorage(ctx);
  let taskId = ctx.args[0] ?? "";
  if (ctx.args.length === 0) {
    let active: ActiveTimer[];
    try {
      active = storage.time.getState().active ?? [];
    } catch (e) {
      throw wrapErr("get timer state", e);
    }
    if (active.length === 0) throw new Error("no active timer");
    taskId = active.find((a) => a.pausedAt !== null)?.taskId ?? "";
    if (taskId === "") throw new Error("no paused timer found");
  }
  try {
    await storage.time.resume(taskId);
  } catch (e) {
    throw wrapErr("resume timer", e);
  }
  ctx.print(`${renderSuccess(`Timer resumed for task ${taskId}`)}\n`);
}

// --- add -------------------------------------------------------------------------------------

async function runTimeAdd(ctx: CommandContext): Promise<void> {
  const taskId = ctx.args[0] as string;
  const durationStr = ctx.args[1] as string;
  const storage = await openStorage(ctx);

  let durationSecs: number;
  try {
    durationSecs = parseDuration(durationStr);
  } catch (e) {
    throw wrapErr(`invalid duration ${goQuote(durationStr)}`, e);
  }
  const note = ctx.flags.string("note");
  const dateStr = ctx.flags.string("date");

  let entryMs: number;
  if (dateStr !== "") {
    const parsed = parseGoDate(dateStr);
    if (!parsed.ok) {
      throw new Error(`invalid date ${goQuote(dateStr)} (use YYYY-MM-DD): ${parsed.error}`);
    }
    entryMs = parsed.date.ms;
  } else {
    entryMs = Date.now();
  }

  try {
    storage.tasks.get(taskId);
  } catch {
    throw new Error(`task ${goQuote(taskId)} not found`);
  }

  const entry: TimeEntry = {
    id: `te-${entryMs}-${taskId}`,
    startedAt: new Date(entryMs).toISOString(),
    endedAt: new Date(entryMs + durationSecs * 1000).toISOString(),
    duration: durationSecs,
  };
  if (note !== "") entry.note = note;

  try {
    await newCLITaskLifecycleService(storage).addTimeEntry(taskId, {
      actor: cliLifecycleActor(ctx.env),
      expectedHash: ctx.flags.string("expected-hash"),
      entry,
    });
  } catch (e) {
    throw wrapErr("save time entry", e);
  }
  ctx.print(`${renderSuccess(`Added ${formatDuration(durationSecs)} to task ${taskId}`)}\n`);
}

// --- status ----------------------------------------------------------------------------------

async function runTimeStatus(ctx: CommandContext): Promise<void> {
  const storage = await openStorage(ctx);
  let active: ActiveTimer[];
  try {
    active = storage.time.getState().active ?? [];
  } catch (e) {
    throw wrapErr("get timer state", e);
  }
  if (active.length === 0) {
    ctx.print(ctx.plain ? "STATUS: no active timer\n" : `${StyleDim.render("No active timer.")}\n`);
    return;
  }
  const now = Date.now();
  let out = "";
  if (ctx.plain) {
    out += `ACTIVE TIMERS: ${active.length}\n\n`;
    for (const a of active) {
      out += `TASK: ${a.taskId}\n`;
      if (a.taskTitle) out += `TITLE: ${a.taskTitle}\n`;
      out += `STATUS: ${a.pausedAt !== null ? "paused" : "running"}\n`;
      out += `ELAPSED: ${formatDuration(elapsedSeconds(a, now))}\n`;
      out += `STARTED: ${a.startedAt}\n\n`;
    }
  } else {
    out += `${StyleBold.render("Active timers:")} ${active.length}\n\n`;
    for (const a of active) {
      const title = a.taskTitle ? a.taskTitle : a.taskId;
      const indicator =
        a.pausedAt !== null ? StyleWarning.render("● paused") : StyleSuccess.render("● running");
      out += `  ${StyleID.render(`[${a.taskId}]`)} ${title} — ${StyleInfo.render(formatDuration(elapsedSeconds(a, now)))}  ${indicator}\n`;
    }
  }
  ctx.print(out);
}

// --- report ----------------------------------------------------------------------------------

const MS_PER_DAY = 24 * 3600 * 1000;

async function runTimeReport(ctx: CommandContext): Promise<void> {
  const storage = await openStorage(ctx);
  const fromStr = ctx.flags.string("from");
  const toStr = ctx.flags.string("to");
  const byLabel = ctx.flags.bool("by-label");
  const byStatus = ctx.flags.bool("by-status");
  const csvMode = ctx.flags.bool("csv");

  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (fromStr !== "") {
    const parsed = parseGoDate(fromStr);
    if (!parsed.ok) throw new Error(`invalid --from date: ${parsed.error}`);
    if (!parsed.date.isZero) fromMs = parsed.date.ms;
  }
  if (toStr !== "") {
    const parsed = parseGoDate(toStr);
    if (!parsed.ok) throw new Error(`invalid --to date: ${parsed.error}`);
    // Include the full day.
    if (!parsed.date.isZero) toMs = parsed.date.ms + MS_PER_DAY - 1000;
  }

  let allEntries: Record<string, TimeEntry[]>;
  try {
    allEntries = storage.time.getAllEntries();
  } catch (e) {
    throw wrapErr("get time entries", e);
  }

  const taskById = new Map<string, { title: string; labels: string[]; status: string }>();
  try {
    for (const t of storage.tasks.listAll()) {
      taskById.set(t.id, { title: t.title, labels: t.labels ?? [], status: t.status });
    }
  } catch {
    // The task list is advisory here.
  }

  interface Row {
    taskId: string;
    taskTitle: string;
    labels: string[];
    duration: number;
    date: string;
    note: string;
  }
  const rows: Row[] = [];
  let totalSecs = 0;
  for (const [taskId, entries] of Object.entries(allEntries)) {
    for (const entry of entries) {
      const started = Date.parse(entry.startedAt);
      if (fromMs !== undefined && started < fromMs) continue;
      if (toMs !== undefined && started > toMs) continue;
      const task = taskById.get(taskId);
      rows.push({
        taskId,
        taskTitle: task ? task.title : taskId,
        labels: task ? task.labels : [],
        duration: entry.duration,
        date: formatDate(entry.startedAt),
        note: entry.note ?? "",
      });
      totalSecs += entry.duration;
    }
  }

  if (csvMode) {
    let out = csvRecord([
      "date",
      "task_id",
      "title",
      "labels",
      "duration_secs",
      "duration",
      "note",
    ]);
    for (const r of rows) {
      out += csvRecord([
        r.date,
        r.taskId,
        r.taskTitle,
        r.labels.join(";"),
        String(r.duration),
        formatDuration(r.duration),
        r.note,
      ]);
    }
    ctx.print(out);
    return;
  }

  const plain = ctx.plain;
  let out = "";

  if (byLabel) {
    const totals = new Map<string, number>();
    const add = (k: string, secs: number) => totals.set(k, (totals.get(k) ?? 0) + secs);
    for (const r of rows) {
      if (r.labels.length === 0) add("(unlabeled)", r.duration);
      for (const l of r.labels) add(l, r.duration);
    }
    if (plain) {
      out += "TIME REPORT BY LABEL:\n";
      for (const [label, secs] of totals) out += `  ${label}: ${formatDuration(secs)}\n`;
      out += `\nTOTAL: ${formatDuration(totalSecs)}\n`;
    } else {
      out += `${renderSectionHeader("Time Report by Label")}\n${renderSeparator(40)}\n`;
      for (const [label, secs] of totals) {
        out += `  ${padRunes(label, 25)} ${StyleInfo.render(formatDuration(secs))}\n`;
      }
      out += `${renderSeparator(40)}\n`;
      out += `  ${StyleBold.render(padRunes("TOTAL", 25))} ${StyleInfo.render(formatDuration(totalSecs))}\n`;
    }
    ctx.print(out);
    return;
  }

  if (byStatus) {
    const totals = new Map<string, number>();
    for (const r of rows) {
      const status = taskById.get(r.taskId)?.status ?? "unknown";
      totals.set(status, (totals.get(status) ?? 0) + r.duration);
    }
    if (plain) {
      out += "TIME REPORT BY STATUS:\n";
      for (const [status, secs] of totals) out += `  ${status}: ${formatDuration(secs)}\n`;
      out += `\nTOTAL: ${formatDuration(totalSecs)}\n`;
    } else {
      out += `${renderSectionHeader("Time Report by Status")}\n${renderSeparator(40)}\n`;
      for (const [status, secs] of totals) {
        out += `  ${statusStyle(status).render(padRunes(status, 25))} ${StyleInfo.render(formatDuration(secs))}\n`;
      }
      out += `${renderSeparator(40)}\n`;
      out += `  ${StyleBold.render(padRunes("TOTAL", 25))} ${StyleInfo.render(formatDuration(totalSecs))}\n`;
    }
    ctx.print(out);
    return;
  }

  // Default: per-task summary.
  const taskTotals = new Map<string, number>();
  const taskTitles = new Map<string, string>();
  for (const r of rows) {
    taskTotals.set(r.taskId, (taskTotals.get(r.taskId) ?? 0) + r.duration);
    taskTitles.set(r.taskId, r.taskTitle);
  }
  if (plain) {
    out += "TIME REPORT:\n";
    for (const [id, secs] of taskTotals) {
      out += `  TASK: ${id} (${taskTitles.get(id)}): ${formatDuration(secs)}\n`;
    }
    out += `\nTOTAL: ${formatDuration(totalSecs)}\n`;
  } else {
    out += `${renderSectionHeader("Time Report")}\n`;
    if (fromMs !== undefined || toMs !== undefined) {
      out += `${StyleDim.render(`Period: ${fromStr} - ${toStr}`)}\n`;
    }
    out += `${renderSeparator(60)}\n`;
    for (const [id, secs] of taskTotals) {
      let title = taskTitles.get(id) ?? "";
      const bytes = Buffer.from(title, "utf8");
      if (bytes.length > 35) title = `${bytes.subarray(0, 32).toString("utf8")}...`;
      out += `  ${StyleID.render(padRunes(id, 8))} ${padRunes(title, 35)} ${StyleInfo.render(formatDuration(secs))}\n`;
    }
    out += `${renderSeparator(60)}\n`;
    out += `  ${padRunes("", 8)} ${StyleBold.render(padRunes("TOTAL", 35))} ${StyleInfo.render(formatDuration(totalSecs))}\n`;
  }
  ctx.print(out);
}

// --- log -------------------------------------------------------------------------------------

async function runTimeLog(ctx: CommandContext): Promise<void> {
  const taskId = ctx.args[0] as string;
  const storage = await openStorage(ctx);
  let entries: TimeEntry[];
  try {
    entries = storage.time.getEntries(taskId);
  } catch (e) {
    throw wrapErr(`get time entries for task ${taskId}`, e);
  }
  const plain = ctx.plain;
  if (entries.length === 0) {
    ctx.print(
      plain
        ? `TASK: ${taskId}\nENTRIES: 0\n`
        : `${StyleDim.render(`No time entries for task ${taskId}.`)}\n`,
    );
    return;
  }
  const totalSecs = entries.reduce((sum, e) => sum + e.duration, 0);
  let out = "";
  if (plain) {
    out += `TASK: ${taskId}\nENTRIES: ${entries.length}\nTOTAL: ${formatDuration(totalSecs)}\n\n`;
    for (const e of entries) {
      out += `ENTRY: ${e.id}\n`;
      out += `  STARTED: ${formatRFC3339(e.startedAt)}\n`;
      if (e.endedAt !== undefined) out += `  ENDED: ${formatRFC3339(e.endedAt)}\n`;
      out += `  DURATION: ${formatDuration(e.duration)}\n`;
      if (e.note) out += `  NOTE: ${e.note}\n`;
      out += "\n";
    }
  } else {
    out += `${renderSectionHeader(`Time log for task ${taskId}`)} ${StyleDim.render(`(${entries.length} entries, total: ${formatDuration(totalSecs)})`)}\n\n`;
    out += `  ${StyleBold.render(padRunes("STARTED", 20))}  ${StyleBold.render(padRunes("ENDED", 20))}  ${StyleBold.render(padRunes("DURATION", 12))}  ${StyleBold.render("NOTE")}\n`;
    out += `  ${renderSeparator(70)}\n`;
    for (const e of entries) {
      const ended = e.endedAt !== undefined ? formatDateMinute(e.endedAt) : StyleDim.render("-");
      out += `  ${padRunes(formatDateMinute(e.startedAt), 20)}  ${padRunes(ended, 20)}  ${StyleInfo.render(padRunes(formatDuration(e.duration), 12))}  ${e.note ?? ""}\n`;
    }
    out += `  ${renderSeparator(70)}\n`;
    out += `  ${padRunes("", 20)}  ${StyleBold.render(padRunes("TOTAL", 20))}  ${StyleInfo.render(formatDuration(totalSecs))}\n`;
  }
  ctx.print(out);
}

export default defineCommand({
  use: "time",
  short: "Time tracking",
  subcommands: [
    defineCommand({
      use: "start <taskId>",
      short: "Start a timer for a task",
      args: exactArgs(1),
      run: runTimeStart,
    }),
    defineCommand({
      use: "stop [taskId]",
      short: "Stop the active timer",
      args: maximumNArgs(1),
      flags: [{ type: "string", name: "expected-hash", usage: "Expected canonical task hash" }],
      run: runTimeStop,
    }),
    defineCommand({
      use: "pause [taskId]",
      short: "Pause the active timer",
      args: maximumNArgs(1),
      run: runTimePause,
    }),
    defineCommand({
      use: "resume [taskId]",
      short: "Resume a paused timer",
      args: maximumNArgs(1),
      run: runTimeResume,
    }),
    defineCommand({
      use: "add <taskId> <duration>",
      short: "Manually add a time entry (e.g. 2h, 30m)",
      args: exactArgs(2),
      flags: [
        { type: "string", name: "note", shorthand: "n", usage: "Note for this time entry" },
        {
          type: "string",
          name: "date",
          shorthand: "d",
          usage: "Date (YYYY-MM-DD, defaults to today)",
        },
        { type: "string", name: "expected-hash", usage: "Expected canonical task hash" },
      ],
      run: runTimeAdd,
    }),
    defineCommand({ use: "status", short: "Show current timer status", run: runTimeStatus }),
    defineCommand({
      use: "report",
      short: "Generate time tracking report",
      flags: [
        { type: "string", name: "from", usage: "Start date (YYYY-MM-DD)" },
        { type: "string", name: "to", usage: "End date (YYYY-MM-DD)" },
        { type: "bool", name: "by-label", usage: "Group by label" },
        { type: "bool", name: "by-status", usage: "Group by status" },
        { type: "bool", name: "csv", usage: "Output as CSV" },
      ],
      run: runTimeReport,
    }),
    defineCommand({
      use: "log <taskId>",
      short: "Show time log for a specific task",
      args: exactArgs(1),
      run: runTimeLog,
    }),
  ],
});
