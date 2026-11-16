// KN-6DVWN6 diverges from the 0.34.1 oracle: MCP `tasks list` returns summaries in
// {results,total,limit,nextCursor?} (first 50) and `tasks board` returns per-column summary pages,
// where Go returns full tasks in a bare array. Diff tests project both sides to the same summary
// fields so the task set, titles and statuses are still compared. Paging itself is covered by
// test/mcp/tasks-pagination.test.ts.

export const SUMMARY_KEYS = [
  "id",
  "title",
  "status",
  "priority",
  "assignee",
  "labels",
  "parent",
  "order",
  "updatedAt",
  "workedBy",
];

export function summarize(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SUMMARY_KEYS) {
    const v = k === "labels" ? (t[k] ?? []) : t[k];
    if (v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

/** The task array of a Go list (bare array) or a TypeScript list ({results,total}), projected and sorted by id. */
export function projectTaskList(text: string): string {
  const v = JSON.parse(text);
  const list: Record<string, unknown>[] = Array.isArray(v) ? v : v.results;
  const byId = (a: { id?: unknown }, b: { id?: unknown }) =>
    String(a.id ?? "").localeCompare(String(b.id ?? ""));
  return JSON.stringify(list.map(summarize).sort(byId), null, 2);
}

// --- help, schema and tool-description text -------------------------------------------------------
// [TS, 0.34.1] literal pairs for the wording and parameters KN-6DVWN6 added or changed. Each pair is
// also tried JSON-escaped once and twice, because the same text appears raw, inside a JSON-RPC line
// and inside a text result that is itself JSON.

const LIST_TS =
  "- list: List tasks with filters. Required: none. Optional: status, priority, assignee, unassigned, label, spec, parent, query, includeHistorical, limit, cursor, detail. Returns: {results, total, limit, nextCursor?}; results are summaries (id, title, status, priority, assignee, labels, parent, order, updatedAt), first 50 by default. Pass nextCursor as cursor for the next page; detail=full returns full tasks; use get for one task.";
const LIST_GO =
  "- list: List tasks with filters. Required: none. Optional: status, priority, assignee, unassigned, label, spec, includeHistorical. Returns: matching task summaries with IDs, titles, statuses, priorities, assignees, labels, and spec links.";
const BOARD_TS =
  "- board: Show tasks grouped by status. Required: none. Optional: status, limit, cursor. Returns: columns with the first 20 task summaries each, the full count and nextCursor; pass status plus cursor to page one column.";
const BOARD_GO =
  "- board: Show tasks grouped by status. Required: none. Optional: none. Returns: board columns containing task summaries by status.";

const PAIRS: Array<[string, string]> = [
  [LIST_TS, LIST_GO],
  [BOARD_TS, BOARD_GO],
  [
    "Parent task ID for subtasks (create); only subtasks of this task (list)",
    "Parent task ID for subtasks (create)",
  ],
  [
    "History metadata offset (newest first); list start offset, cursor is preferred",
    "History metadata offset (newest first)",
  ],
  [
    "History metadata page size; list page size (default 50, max 200); board per-column size (default 20)",
    "History metadata page size",
  ],
  [
    'when": "Find tasks by status, owner, priority, label, spec, parent or text before choosing work or checking remaining scope. Returns summaries, 50 per page: follow nextCursor, use detail=full or tasks.get for full fields.',
    'when": "Find tasks by status, owner, priority, label, or spec before choosing work or checking remaining scope.',
  ],
  [
    '"params": {\n        "cursor": "nextCursor of a column; requires status",\n        "limit": "tasks per column, default 20, max 200",\n        "status": "only this column"\n      }',
    '"params": {}',
  ],
];

// Removed outright: new input-schema properties and new help params of tasks list.
const REMOVALS: RegExp[] = [
  /"cursor":\{"description":"Opaque cursor from a previous list or board response nextCursor","type":"string"\},/g,
  /"query":\{"description":"Case-insensitive text in title or description \(list\)","type":"string"\},/g,
  /"detail":\{"description":"List detail: summary \(default\) or full task payloads","enum":\["summary","full"\],"type":"string"\},/g,
];

const HELP_LIST_PARAMS = [
  ["cursor", "nextCursor of the previous page"],
  ["detail", "summary (default) | full task payloads"],
  ["limit", "page size, default 50, max 200"],
  ["offset", "start offset; prefer cursor"],
  ["parent", "only subtasks of this Task ID"],
  ["query", "case-insensitive text in title or description"],
];

function variants(s: string): string[] {
  const one = JSON.stringify(s).slice(1, -1);
  const two = JSON.stringify(one).slice(1, -1);
  return [s, one, two];
}

/** The TypeScript output with the KN-6DVWN6 changes reverted to 0.34.1, for a diff against the oracle. */
export function withoutKn6dvwn6(text: string): string {
  let out = text;
  for (const [ts, go] of PAIRS) {
    const g = variants(go);
    variants(ts).forEach((t, i) => {
      out = out.replaceAll(t, g[i] as string);
    });
  }
  for (const re of REMOVALS) out = out.replace(re, "");
  // help("tasks.list") params: drop each added entry, whatever the indentation or escaping.
  for (const [k, v] of HELP_LIST_PARAMS) {
    for (const sep of variants(",\n")) {
      for (const ind of [8, 10, 12]) {
        const pad = " ".repeat(ind);
        for (const entry of variants(`${pad}"${k}": "${v}"`)) {
          out = out.replaceAll(`${sep}${entry}`, "");
        }
      }
    }
  }
  return out;
}
