// Renderers for `task` output (the helpers at the bottom of internal/cli/task.go).
import type { Task } from "../../models/task.ts";
import type { TaskVersion, TaskVersionHistory } from "../../models/version.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { compareBytes } from "../../storage/stores/go-shape.ts";
import { formatDuration } from "../core/helpers.ts";
import { type MarkdownBodyRenderer, passthroughMarkdown, terminalWidth } from "../core/markdown.ts";
import {
  priorityStyle,
  renderPriorityBadge,
  renderSectionHeader,
  renderSeparator,
  renderStatusBadge,
  StyleBold,
  StyleDim,
  StyleID,
  StyleInfo,
  StyleLabel,
  StyleSuccess,
  StyleWarning,
  statusStyle,
} from "../core/plainoutput.ts";
import {
  fmtV,
  formatDate,
  formatDateTime,
  formatISOLiteralZ,
  formatRFC3339,
  padRight,
  padRunes,
  stringWidth,
  truncateVisible,
} from "./task-text.ts";

const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8");

// --- ordering ------------------------------------------------------------------------------------

export function taskStatusListRank(status: string): number {
  switch (status) {
    case "urgent":
      return 0;
    case "blocked":
      return 1;
    case "in-progress":
      return 2;
    case "in-review":
      return 3;
    case "todo":
      return 4;
    case "on-hold":
      return 5;
    case "done":
      return 6;
    default:
      return 5;
  }
}

function isRankedTaskStatus(status: string): boolean {
  return ["urgent", "blocked", "in-progress", "in-review", "todo", "on-hold", "done"].includes(
    status,
  );
}

function taskPriorityListRank(priority: string): number {
  switch (priority) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

const ms = (ts: string): number => Date.parse(ts);

/**
 * The order a task list is presented in: status rank, then explicit display order, then priority,
 * then most recently updated, then ID. One sort above the fork into plain/styled/JSON, so every
 * rendering shows the same rows in the same order.
 */
export function sortTasksForList(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const rank = taskStatusListRank(left.status) - taskStatusListRank(right.status);
    if (rank !== 0) return rank;
    if (left.order !== undefined || right.order !== undefined) {
      if (left.order === undefined) return 1;
      if (right.order === undefined) return -1;
      if (left.order !== right.order) return left.order - right.order;
    }
    const prio = taskPriorityListRank(left.priority) - taskPriorityListRank(right.priority);
    if (prio !== 0) return prio;
    const lu = ms(left.updatedAt);
    const ru = ms(right.updatedAt);
    if (lu !== ru) return lu > ru ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

// --- plain ---------------------------------------------------------------------------------------

const plainAssignee = (t: Task): string => (t.assignee ? t.assignee : "-");
export const pluralTasks = (n: number): string => (n === 1 ? "task" : "tasks");

export function plainStatusSummary(tasks: Task[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const statuses = [...counts.keys()].sort((a, b) => taskStatusListRank(a) - taskStatusListRank(b));
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const status of statuses) {
    if (isRankedTaskStatus(status)) {
      parts.push(`${counts.get(status)} ${status}`);
      seen.add(status);
    }
  }
  const extra: string[] = [];
  for (const [status, n] of counts) if (!seen.has(status)) extra.push(`${n} ${status}`);
  extra.sort();
  return [...parts, ...extra].join(", ");
}

/**
 * One task per line in a fixed field order: ID, STATUS, PRIORITY, ASSIGNEE, TITLE. Assignee prints
 * "-" when empty so the field a value lands in never depends on which task it belongs to. Column
 * widths are byte lengths (Go's len) and padding counts runes (Go's %-*s), as in the original.
 */
export function sprintTaskListPlain(tasks: Task[]): string {
  let idW = 0;
  let statusW = 0;
  let prioW = 0;
  let assigneeW = 0;
  for (const t of tasks) {
    idW = Math.max(idW, utf8Len(t.id));
    statusW = Math.max(statusW, utf8Len(t.status));
    prioW = Math.max(prioW, utf8Len(t.priority));
    assigneeW = Math.max(assigneeW, utf8Len(plainAssignee(t)));
  }
  let b = "";
  for (const t of tasks) {
    b += `${padRunes(t.id, idW)}  ${padRunes(t.status, statusW)}  ${padRunes(t.priority, prioW)}  ${padRunes(plainAssignee(t), assigneeW)}  ${t.title}\n`;
  }
  if (tasks.length > 0) {
    b += `\nTotal: ${tasks.length} ${pluralTasks(tasks.length)} (${plainStatusSummary(tasks)})\n`;
  }
  return b;
}

export function sprintTaskPlain(t: Task): string {
  let b = "";
  b += `ID: ${t.id}\n`;
  b += `TITLE: ${t.title}\n`;
  b += `STATUS: ${t.status}\n`;
  b += `PRIORITY: ${t.priority}\n`;
  if (t.assignee) b += `ASSIGNEE: ${t.assignee}\n`;
  if (t.labels && t.labels.length > 0) b += `LABELS: ${t.labels.join(", ")}\n`;
  if (t.parent) b += `PARENT: ${t.parent}\n`;
  if (t.spec) b += `SPEC: ${t.spec}\n`;
  if (t.fulfills && t.fulfills.length > 0) b += `FULFILLS: ${t.fulfills.join(", ")}\n`;
  if (t.description) b += `DESCRIPTION:\n${t.description}\n`;
  const ac = t.acceptanceCriteria ?? [];
  if (ac.length > 0) {
    b += "ACCEPTANCE CRITERIA:\n";
    ac.forEach((c, i) => {
      b += `  ${i + 1}. [${c.completed ? "x" : " "}] ${c.text}\n`;
    });
  }
  if (t.implementationPlan) b += `PLAN:\n${t.implementationPlan}\n`;
  if (t.implementationNotes) b += `NOTES:\n${t.implementationNotes}\n`;
  if (t.timeSpent > 0) b += `TIME SPENT: ${formatDuration(t.timeSpent)}\n`;
  if (t.activeTimer) {
    const status = t.activeTimer.pausedAt !== null ? "paused" : "running";
    b += `TIMER: ${status} (started ${t.activeTimer.startedAt})\n`;
  }
  b += `CREATED: ${formatISOLiteralZ(t.createdAt)}\n`;
  b += `UPDATED: ${formatISOLiteralZ(t.updatedAt)}\n`;
  if (t.subtasks && t.subtasks.length > 0) b += `SUBTASKS: ${t.subtasks.join(", ")}\n`;
  return b;
}

// --- styled --------------------------------------------------------------------------------------

const renderKeyValue = (key: string, value: string): string =>
  `${StyleDim.render(`${key}:`)} ${value}`;

function renderLabels(labels: string[]): string {
  return labels.map((l) => StyleLabel.render(l)).join(StyleDim.render(", "));
}

function renderACCheckbox(index: number, text: string, completed: boolean): string {
  const num = StyleDim.render(`${index}.`);
  return completed
    ? `  ${num} ${StyleSuccess.render("[✓]")} ${StyleDim.render(text)}`
    : `  ${num} ${StyleDim.render("[ ]")} ${text}`;
}

export function renderTaskDetailed(
  t: Task,
  renderBody: MarkdownBodyRenderer = passthroughMarkdown,
): string {
  let b = "";
  b += `${StyleID.render(t.id)}  ${StyleBold.render(t.title)}\n`;
  b += `${StyleDim.render("Status:")} ${renderStatusBadge(t.status)}  ${StyleDim.render("Priority:")} ${renderPriorityBadge(t.priority)}\n`;
  if (t.assignee) b += `${renderKeyValue("Assignee", t.assignee)}\n`;
  if (t.labels && t.labels.length > 0) {
    b += `${StyleDim.render("Labels:")} ${renderLabels(t.labels)}\n`;
  }
  if (t.parent) b += `${renderKeyValue("Parent", t.parent)}\n`;
  if (t.spec) b += `${renderKeyValue("Spec", t.spec)}\n`;
  if (t.fulfills && t.fulfills.length > 0) {
    b += `${renderKeyValue("Fulfills", t.fulfills.join(", "))}\n`;
  }
  if (t.description) {
    b += `\n${renderSectionHeader("Description")}\n${renderBody(t.description)}\n`;
  }
  const ac = t.acceptanceCriteria ?? [];
  if (ac.length > 0) {
    b += `\n${renderSectionHeader("Acceptance Criteria")}\n`;
    ac.forEach((c, i) => {
      b += `${renderACCheckbox(i + 1, c.text, c.completed)}\n`;
    });
  }
  if (t.implementationPlan) {
    b += `\n${renderSectionHeader("Implementation Plan")}\n${renderBody(t.implementationPlan)}\n`;
  }
  if (t.implementationNotes) {
    b += `\n${renderSectionHeader("Implementation Notes")}\n${renderBody(t.implementationNotes)}\n`;
  }
  if (t.timeSpent > 0) {
    b += `\n${StyleDim.render("Time Spent:")} ${StyleInfo.render(formatDuration(t.timeSpent))}\n`;
  }
  if (t.activeTimer) {
    const status =
      t.activeTimer.pausedAt !== null
        ? StyleWarning.render("⏸ paused")
        : StyleSuccess.render("● running");
    b += `\n${StyleDim.render("Timer:")} ${status} ${StyleDim.render(`(since ${t.activeTimer.startedAt})`)}\n`;
  }
  b += `\n${StyleDim.render(`Created: ${formatDate(t.createdAt)} | Updated: ${formatDate(t.updatedAt)}`)}\n`;
  if (t.subtasks && t.subtasks.length > 0) {
    b += `${renderKeyValue("Subtasks", t.subtasks.join(", "))}\n`;
  }
  return b;
}

/**
 * The styled task table. Column widths come from the data and the terminal, not from constants;
 * titles that all fit are never truncated, and truncation is by display column, never mid-rune.
 */
export function renderTaskTable(tasks: Task[], width: number = terminalWidth()): string {
  const indent = 2;
  const gap = 2;
  const minTitle = 24;
  const maxAssign = 20;
  let idW = "ID".length;
  let assigneeW = "ASSIGNEE".length;
  let titleW = "TITLE".length;
  let statusW = "STATUS".length;
  let prioW = "PRIORITY".length;
  for (const t of tasks) {
    idW = Math.max(idW, stringWidth(t.id));
    statusW = Math.max(statusW, stringWidth(t.status));
    prioW = Math.max(prioW, stringWidth(t.priority));
    assigneeW = Math.max(assigneeW, stringWidth(t.assignee ?? ""));
    titleW = Math.max(titleW, stringWidth(t.title));
  }
  assigneeW = Math.min(assigneeW, maxAssign);
  const fixed = indent + idW + statusW + prioW + assigneeW + gap * 4;
  const room = width - fixed;
  if (room < titleW) titleW = Math.max(room, minTitle);

  const sep = " ".repeat(gap);
  const pad = " ".repeat(indent);
  let b = "";
  b += `${
    pad +
    [
      StyleBold.render(padRight("ID", idW)),
      StyleBold.render(padRight("TITLE", titleW)),
      StyleBold.render(padRight("STATUS", statusW)),
      StyleBold.render(padRight("PRIORITY", prioW)),
      StyleBold.render("ASSIGNEE"),
    ].join(sep)
  }\n`;
  b += `${pad + renderSeparator(fixed + titleW - indent)}\n`;
  for (const t of tasks) {
    b += `${
      pad +
      [
        StyleID.render(padRight(t.id, idW)),
        padRight(truncateVisible(t.title, titleW), titleW),
        statusStyle(t.status).render(padRight(t.status, statusW)),
        priorityStyle(t.priority).render(padRight(t.priority, prioW)),
        truncateVisible(t.assignee ?? "", assigneeW),
      ].join(sep)
    }\n`;
  }
  if (tasks.length > 0) {
    b += `\n${pad}${StyleDim.render(`Total: ${tasks.length} ${pluralTasks(tasks.length)} (${plainStatusSummary(tasks)})`)}\n`;
  }
  return b;
}

// --- assignees (D13, PR #156 internal/cli/task_assignees.go) --------------------------------------

/**
 * One assignee's share of the filtered tasks. The unassigned bucket has an empty `assignee` and
 * `unassigned` set, so a consumer never has to guess whether "" is a name.
 */
export interface AssigneeBucket {
  assignee: string;
  unassigned: boolean;
  total: number;
  byStatus: Map<string, number>;
  tasks: Task[];
}

/**
 * bucketTasksByAssignee: tasks grouped by trimmed assignee (whitespace-only joins the unassigned
 * bucket), largest bucket first, ties by name (Go byte order), the unassigned bucket last.
 */
export function bucketTasksByAssignee(tasks: Task[]): AssigneeBucket[] {
  const byName = new Map<string, AssigneeBucket>();
  for (const t of tasks) {
    const name = goTrimSpace(t.assignee ?? "");
    let b = byName.get(name);
    if (!b) {
      b = { assignee: name, unassigned: name === "", total: 0, byStatus: new Map(), tasks: [] };
      byName.set(name, b);
    }
    b.total++;
    b.byStatus.set(t.status, (b.byStatus.get(t.status) ?? 0) + 1);
    b.tasks.push(t);
  }
  return [...byName.values()].sort((l, r) => {
    if (l.unassigned !== r.unassigned) return l.unassigned ? 1 : -1;
    if (l.total !== r.total) return r.total - l.total;
    return compareBytes(l.assignee, r.assignee);
  });
}

/** The JSON form: struct field order, `unassigned` omitted when false, byStatus keys sorted. */
export function assigneeBucketsToWire(buckets: AssigneeBucket[]): unknown[] {
  return buckets.map((b) => {
    const byStatus: Record<string, number> = {};
    for (const k of [...b.byStatus.keys()].sort(compareBytes))
      byStatus[k] = b.byStatus.get(k) as number;
    return {
      assignee: b.assignee,
      ...(b.unassigned ? { unassigned: true } : {}),
      total: b.total,
      byStatus,
    };
  });
}

/** The unassigned bucket prints as "-", as the list does. */
const bucketLabel = (b: AssigneeBucket): string => (b.unassigned ? "-" : b.assignee);

export function sprintAssigneesPlain(buckets: AssigneeBucket[], total: number): string {
  let nameW = 0;
  let totalW = 0;
  for (const bk of buckets) {
    nameW = Math.max(nameW, stringWidth(bucketLabel(bk)));
    totalW = Math.max(totalW, String(bk.total).length);
  }
  let b = "";
  for (const bk of buckets) {
    b += `${padRight(bucketLabel(bk), nameW)}  ${String(bk.total).padStart(totalW)}  (${plainStatusSummary(bk.tasks)})\n`;
  }
  b += `\nTotal: ${total} ${pluralTasks(total)}\n`;
  return b;
}

/** Each "N status" part of plainStatusSummary in its status colour, so both views keep one order. */
function styledStatusSummary(tasks: Task[]): string {
  return plainStatusSummary(tasks)
    .split(", ")
    .map((part) => {
      const sp = part.indexOf(" ");
      return sp < 0 ? part : statusStyle(part.slice(sp + 1)).render(part);
    })
    .join(", ");
}

export function renderAssigneesTable(buckets: AssigneeBucket[], total: number): string {
  const indent = 2;
  const gap = 2;
  let nameW = "ASSIGNEE".length;
  const totalW = "TASKS".length;
  let statusW = "STATUS".length;
  for (const bk of buckets) {
    nameW = Math.max(nameW, stringWidth(bucketLabel(bk)));
    statusW = Math.max(statusW, stringWidth(plainStatusSummary(bk.tasks)));
  }
  const sep = " ".repeat(gap);
  const pad = " ".repeat(indent);
  let b = `${pad}${[
    StyleBold.render(padRight("ASSIGNEE", nameW)),
    StyleBold.render(padRight("TASKS", totalW)),
    StyleBold.render("STATUS"),
  ].join(sep)}\n`;
  b += `${pad}${renderSeparator(nameW + totalW + statusW + gap * 2)}\n`;
  for (const bk of buckets) {
    let name = padRight(bucketLabel(bk), nameW);
    if (bk.unassigned) name = StyleDim.render(name);
    b += `${pad}${[name, padRight(String(bk.total), totalW), styledStatusSummary(bk.tasks)].join(sep)}\n`;
  }
  b += `\n${pad}${StyleDim.render(`Total: ${total} ${pluralTasks(total)}`)}\n`;
  return b;
}

// --- tree ----------------------------------------------------------------------------------------

function treeRoots(tasks: Task[]): { byId: Map<string, Task>; roots: Task[] } {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const roots = tasks.filter((t) => !t.parent || !byId.has(t.parent));
  return { byId, roots };
}

function writeTree(
  byId: Map<string, Task>,
  line: (t: Task, indent: string) => string,
): (t: Task, indent: string) => string {
  const walk = (t: Task, indent: string): string => {
    let out = line(t, indent);
    for (const childId of t.subtasks ?? []) {
      const child = byId.get(childId);
      if (child) out += walk(child, `${indent}  `);
    }
    return out;
  };
  return walk;
}

export function sprintTaskTreePlain(tasks: Task[]): string {
  const { byId, roots } = treeRoots(tasks);
  const walk = writeTree(byId, (t, i) => `${i}${t.id}: ${t.title} [${t.status}]\n`);
  return roots.map((r) => walk(r, "")).join("");
}

export function renderTaskTree(tasks: Task[]): string {
  const { byId, roots } = treeRoots(tasks);
  const walk = writeTree(
    byId,
    (t, i) =>
      `${i}${StyleID.render(t.id)} ${t.title} ${statusStyle(t.status).render(`[${t.status}]`)}\n`,
  );
  return roots.map((r) => walk(r, "")).join("");
}

// --- history -------------------------------------------------------------------------------------

export function renderTaskHistory(id: string, history: TaskVersionHistory): string {
  let b = `${StyleID.render(id)} ${StyleDim.render(`— ${history.currentVersion} version(s)`)}\n\n`;
  for (const v of history.versions ?? []) {
    let header = `${StyleDim.render(`[${v.id}]`)} ${formatDateTime(v.timestamp)}`;
    if (v.author) header += StyleDim.render(" by ") + v.author;
    b += `${header}\n`;
    for (const ch of v.changes ?? []) {
      b += `  ${StyleDim.render("•")} ${StyleBold.render(fmtV(ch.field))}: ${fmtV(ch.oldValue)} → ${fmtV(ch.newValue)}\n`;
    }
    b += "\n";
  }
  return b;
}

/** The plain history for one revision (`--revision`). */
export function renderPlainTaskHistory(id: string, history: TaskVersionHistory): string {
  let b = `TASK: ${id}\nVERSIONS: ${history.currentVersion}\n\n`;
  if (history.tailTruncated) b += "TAIL_TRUNCATED: true\n\n";
  for (const v of history.versions ?? []) {
    b += `VERSION: ${v.id}\nTIMESTAMP: ${formatRFC3339(v.timestamp)}\n`;
    for (const ch of v.changes ?? []) {
      b += `  CHANGE: ${ch.field}: ${fmtV(ch.oldValue)} -> ${fmtV(ch.newValue)}\n`;
    }
    b += "\n";
  }
  return b;
}

/** The plain history of every version (no flags). Author lines appear; tail truncation does not. */
export function renderPlainFullTaskHistory(id: string, history: TaskVersionHistory): string {
  let b = `TASK: ${id}\n`;
  b += `VERSIONS: ${history.currentVersion}\n\n`;
  for (const v of history.versions ?? []) b += plainVersionBlock(v);
  return b;
}

function plainVersionBlock(v: TaskVersion): string {
  let b = `VERSION: ${v.id}\n`;
  b += `TIMESTAMP: ${formatRFC3339(v.timestamp)}\n`;
  if (v.author) b += `AUTHOR: ${v.author}\n`;
  for (const ch of v.changes ?? []) {
    b += `  CHANGE: ${ch.field}: ${fmtV(ch.oldValue)} -> ${fmtV(ch.newValue)}\n`;
  }
  b += "\n";
  return b;
}
